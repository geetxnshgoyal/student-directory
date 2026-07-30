const fs = require('node:fs');
const path = require('node:path');

function loadEnvFileFallback() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;

    const envContent = fs.readFileSync(envPath, 'utf8');

    for (const rawLine of envContent.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1) continue;

        const key = line.slice(0, separatorIndex).trim();
        let value = line.slice(separatorIndex + 1).trim();

        if (!key || Object.hasOwn(process.env, key)) continue;

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        process.env[key] = value.replaceAll('\\n', '\n');
    }
}

try {
    require('dotenv').config();
} catch {
    loadEnvFileFallback();
}

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const crypto = require('node:crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
// Vercel terminates TLS in front of us. Without this every request looks like it
// comes from the proxy, so all users would share a single rate-limit bucket.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

let storedPasswordHash = null;

(async () => {
    storedPasswordHash = await bcrypt.hash('123456778', 12);
})();

const otpStore = new Map();
let adminOtpEntry = null;
const ADMIN_DEFAULT_OTP = process.env.ADMIN_DEFAULT_OTP;

const CARPOOL_OTP_TTL_MS = 10 * 60 * 1000;
const CARPOOL_SESSION_TTL_MS = 60 * 60 * 1000;
const CARPOOL_TRAVEL_GRACE_MS = 2 * 60 * 60 * 1000;
const CARPOOL_MAX_FUTURE_MS = 30 * 24 * 60 * 60 * 1000;
const CARPOOL_MAX_OTP_ATTEMPTS = 5;
const CARPOOL_CACHE_MS = 5000;
const CARPOOL_DIRECTIONS = new Set(['hostel', 'airport']);
const CARPOOL_WAIT_CHOICES = [15, 30, 60];

const CARPOOL_NOTIFY_TTL_MS = 24 * 60 * 60 * 1000;

const CARPOOL_COLLECTIONS = {
    otps: 'carpool_otps',
    sessions: 'carpool_sessions',
    requests: 'carpool_requests',
    notified: 'carpool_notified'
};

// Carpool state lives in Firestore so it survives across serverless invocations.
// These maps only back local runs started without Firebase credentials.
const carpoolMemory = new Map(Object.values(CARPOOL_COLLECTIONS).map(name => [name, new Map()]));

const smtpConfig = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    } : null
};

const mailer = smtpConfig.host && smtpConfig.auth ? nodemailer.createTransport(smtpConfig) : null;

let firestore = null;
try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (projectId && clientEmail && privateKey) {
        const apps = getApps();
        if (!apps || !apps.length) {
            initializeApp({
                credential: cert({
                    projectId,
                    clientEmail,
                    privateKey: privateKey.replaceAll('\\n', '\n')
                })
            });
        }
        firestore = getFirestore();
    }
} catch (e) {
    console.error("Firestore init error:", e);
    firestore = null;
}



async function loadStudentsFromFirestore() {
    if (!firestore) return null;
    const snapshot = await firestore.collection('students').get();
    const students = [];
    snapshot.forEach(doc => {
        const record = doc.data() || {};
        if (!record.usn) record.usn = doc.id;
        students.push(record);
    });
    students.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return students;
}

function makeToken() {
    return crypto.randomBytes(24).toString('hex');
}

function maskEmail(email) {
    return String(email || '').replace(/(.{2})([^@]*)(@.*)/, '$1***$3');
}

function timingSafeMatch(provided, expected) {
    const a = Buffer.from(String(provided ?? ''));
    const b = Buffer.from(String(expected ?? ''));
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
}

async function carpoolSet(collection, id, data) {
    if (firestore) {
        await firestore.collection(collection).doc(id).set(data);
        return;
    }
    carpoolMemory.get(collection).set(id, { ...data });
}

async function carpoolGet(collection, id) {
    if (firestore) {
        const snapshot = await firestore.collection(collection).doc(id).get();
        return snapshot.exists ? snapshot.data() : null;
    }
    const value = carpoolMemory.get(collection).get(id);
    return value ? { ...value } : null;
}

async function carpoolDelete(collection, id) {
    if (firestore) {
        await firestore.collection(collection).doc(id).delete();
        return;
    }
    carpoolMemory.get(collection).delete(id);
}

async function carpoolList(collection) {
    if (firestore) {
        const snapshot = await firestore.collection(collection).get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
    return [...carpoolMemory.get(collection).entries()].map(([id, value]) => ({ id, ...value }));
}

// A journey stays on the board until shortly after its travel time, so a flight
// booked days ahead does not disappear while the student waits for it.
function isRequestActive(request, now = Date.now()) {
    const travelTime = Number(request.time);
    if (!Number.isFinite(travelTime)) return false;
    return travelTime > now - CARPOOL_TRAVEL_GRACE_MS;
}

let carpoolRequestCache = { at: 0, rows: [] };

function invalidateCarpoolCache() {
    carpoolRequestCache = { at: 0, rows: [] };
}

async function listActiveCarpoolRequests() {
    const now = Date.now();
    if (now - carpoolRequestCache.at < CARPOOL_CACHE_MS) {
        return carpoolRequestCache.rows.filter(row => isRequestActive(row, now));
    }
    const rows = (await carpoolList(CARPOOL_COLLECTIONS.requests))
        .filter(row => isRequestActive(row, now))
        .sort((a, b) => Number(a.time) - Number(b.time));
    carpoolRequestCache = { at: now, rows };
    return rows;
}

let lastCarpoolPurge = 0;

async function purgeExpiredCarpoolData() {
    const now = Date.now();
    if (now - lastCarpoolPurge < 60 * 1000) return;
    lastCarpoolPurge = now;

    try {
        const [otps, sessions, requests, notified] = await Promise.all([
            carpoolList(CARPOOL_COLLECTIONS.otps),
            carpoolList(CARPOOL_COLLECTIONS.sessions),
            carpoolList(CARPOOL_COLLECTIONS.requests),
            carpoolList(CARPOOL_COLLECTIONS.notified)
        ]);

        // A "we already emailed this pair" record may only be dropped once neither
        // side has a live journey. Expiring it on a timer instead would let the
        // same pair be emailed twice about the same trip.
        const activeUsns = new Set(
            requests.filter(row => isRequestActive(row, now)).map(row => row.usn)
        );
        const notifyGrace = now - CARPOOL_NOTIFY_TTL_MS;

        const stale = [
            ...otps.filter(row => Number(row.expiresAt) <= now).map(row => [CARPOOL_COLLECTIONS.otps, row.id]),
            ...sessions.filter(row => Number(row.expiresAt) <= now).map(row => [CARPOOL_COLLECTIONS.sessions, row.id]),
            ...requests.filter(row => !isRequestActive(row, now)).map(row => [CARPOOL_COLLECTIONS.requests, row.id]),
            ...notified
                .filter(row => Number(row.notifiedAt) <= notifyGrace)
                .filter(row => !(row.usns || []).some(usn => activeUsns.has(usn)))
                .map(row => [CARPOOL_COLLECTIONS.notified, row.id])
        ];

        if (stale.length) {
            await Promise.all(stale.map(([collection, id]) => carpoolDelete(collection, id)));
            invalidateCarpoolCache();
        }

        for (const [key, entry] of otpStore.entries()) {
            if (entry.expiresAt <= now) otpStore.delete(key);
        }
    } catch (e) {
        console.error('Carpool purge failed:', e);
    }
}

// A datetime-local value carries no offset. Every carpool time is a Bangalore
// wall-clock time, so assume IST instead of whatever zone the server runs in.
function parseCarpoolTime(value) {
    if (typeof value !== 'string') return null;
    let raw = value.trim();
    if (!raw) return null;
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) raw = `${raw}:00`;
        raw = `${raw}+05:30`;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatIstTime(ms) {
    return new Date(Number(ms)).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
}

function sanitizeFlightCode(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9 -]/g, '')
        .trim()
        .slice(0, 10);
}

function normalizeWaitMinutes(value) {
    const parsed = Number(value);
    return CARPOOL_WAIT_CHOICES.includes(parsed) ? parsed : 30;
}

function displayName(row) {
    return row.name || `Student ${String(row.usn || '0000').slice(-4)}`;
}

function serializeRequest(request, viewerUsn) {
    const isYou = request.usn === viewerUsn;
    return {
        id: request.id,
        name: displayName(request),
        photo: request.photo || '',
        direction: request.direction,
        time: new Date(Number(request.time)).toISOString(),
        flightCode: request.flightCode || '',
        isYou,
        // Only the owner needs their own tolerance, to draw their match window.
        ...(isYou ? { waitMinutes: normalizeWaitMinutes(request.waitMinutes) } : {})
    };
}

function buildMatches(requests) {
    const matches = [];
    for (let i = 0; i < requests.length; i += 1) {
        for (let j = i + 1; j < requests.length; j += 1) {
            const a = requests[i];
            const b = requests[j];
            if (a.usn === b.usn) continue;
            if (a.direction !== b.direction) continue;
            // Both travellers have to be willing to sit out the gap between them.
            const windowMinutes = Math.min(normalizeWaitMinutes(a.waitMinutes), normalizeWaitMinutes(b.waitMinutes));
            const gapMinutes = Math.abs(Number(a.time) - Number(b.time)) / 60000;
            if (gapMinutes > windowMinutes) continue;
            matches.push({
                id: [a.id, b.id].sort().join('.'),
                direction: a.direction,
                gapMinutes: Math.round(gapMinutes),
                windowMinutes,
                users: [a, b]
            });
        }
    }
    return matches;
}

// One notification per pair of students, not per request, so editing a trip
// doesn't re-announce a match the two of them already heard about.
function matchPairKey(usnA, usnB) {
    return [String(usnA), String(usnB)].sort().join('_');
}

// Returns true only for the caller that wins the claim. Used to guarantee any
// given carpool email goes out at most once.
async function claimMatchNotification(key, usns) {
    const record = { notifiedAt: Date.now(), usns };

    if (firestore) {
        try {
            await firestore.collection(CARPOOL_COLLECTIONS.notified).doc(key).create(record);
            return true;
        } catch (err) {
            if (err?.code === 6 || /ALREADY_EXISTS/i.test(err?.message || '')) return false;
            throw err;
        }
    }
    const map = carpoolMemory.get(CARPOOL_COLLECTIONS.notified);
    if (map.has(key)) return false;
    map.set(key, record);
    return true;
}

// Heads-up only: no contact details travel in this email. Those are shared
// solely by the owner tapping Connect.
async function sendMatchAlert(recipient, other, match) {
    const heading = match.direction === 'airport'
        ? 'to BLR airport'
        : 'from BLR airport back to campus';

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: recipient.email,
        subject: `NST Carpool: ${displayName(other)} is travelling near your time`,
        text: [
            `Hi ${displayName(recipient)},`,
            ``,
            `${displayName(other)} is heading ${heading} around the same time as you.`,
            ``,
            `Their time: ${formatIstTime(other.time)}${other.flightCode ? ` (${other.flightCode})` : ''}`,
            `Your time:  ${formatIstTime(recipient.time)}${recipient.flightCode ? ` (${recipient.flightCode})` : ''}`,
            `Gap between you: about ${match.gapMinutes} min`,
            ``,
            `Open the carpool board to share your details with them:`,
            `${process.env.PUBLIC_BASE_URL || ''}/carpool`,
            ``,
            `We haven't given either of you the other's contact details. That only`,
            `happens when you tap Connect yourself.`,
            ``,
            `- NST Carpool`
        ].join('\n')
    });
}

async function notifyNewMatches(usn, requests) {
    if (!mailer) return;

    const matches = buildMatches(requests).filter(match =>
        match.users.some(user => user.usn === usn)
    );

    for (const match of matches) {
        const [a, b] = match.users;
        let claimed = false;
        try {
            claimed = await claimMatchNotification(`alert_${matchPairKey(a.usn, b.usn)}`, [a.usn, b.usn]);
        } catch (err) {
            console.error('Carpool match notify claim failed:', err);
            continue;
        }
        if (!claimed) continue;

        // The claim is kept even if a send throws: a throw doesn't prove the mail
        // wasn't delivered, and re-sending is worse than missing one.
        try {
            await sendMatchAlert(a, b, match);
        } catch (err) {
            console.error('Carpool match alert send failed:', err);
        }
        try {
            await sendMatchAlert(b, a, match);
        } catch (err) {
            console.error('Carpool match alert send failed:', err);
        }
    }
}

async function requireCarpoolSession(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
        if (!token) return res.status(401).json({ error: 'Verification required' });

        const session = await carpoolGet(CARPOOL_COLLECTIONS.sessions, token);
        if (!session) return res.status(401).json({ error: 'Verification required' });
        if (Number(session.expiresAt) <= Date.now()) {
            await carpoolDelete(CARPOOL_COLLECTIONS.sessions, token);
            return res.status(401).json({ error: 'Verification expired' });
        }

        req.carpoolToken = token;
        req.carpoolUser = session;
        next();
    } catch (e) {
        console.error('Carpool session lookup failed:', e);
        res.status(500).json({ error: 'Session check failed' });
    }
}

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: true,
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

app.use(express.json());

app.use('/api', (req, res, next) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });
    next();
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many attempts' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Rate limit exceeded' },
});

const otpRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 6,
    message: { error: 'Too many code requests. Try again in a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 12,
    message: { error: 'Too many attempts. Try again in a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

app.use((req, res, next) => {
    if (req.path.endsWith('.json') || req.path.endsWith('.txt')) {
        return res.status(403).json({ error: 'Access denied' });
    }
    next();
});

app.use((req, res, next) => {
    const blocked = ['/students_cleaned_year2.json', '/abc.txt', '/server.js', '/package.json', '/package-lock.json', '/.env'];
    if (blocked.includes(req.path.toLowerCase())) {
        return res.status(403).json({ error: 'Access denied' });
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    dotfiles: 'deny'
}));

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'Password required' });
        const isValid = await bcrypt.compare(password, storedPasswordHash);
        if (!isValid) {
            await new Promise(r => setTimeout(r, 1000));
            return res.status(401).json({ error: 'Invalid password' });
        }
        const token = jwt.sign({ a: true, t: Date.now() }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ success: true, token });
    } catch (e) {
        console.error("Login error:", e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/login', authLimiter, async (req, res) => {
    try {
        const otp = String(crypto.randomInt(100000, 1000000));
        adminOtpEntry = {
            otp,
            expiresAt: Date.now() + 10 * 60 * 1000
        };

        if (mailer && process.env.SMTP_FROM) {
            await mailer.sendMail({
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
                to: process.env.SMTP_USER,
                subject: 'NST Admin OTP',
                text: `Your admin OTP is ${otp}. It expires in 10 minutes.`
            });
        }

        res.json({
            success: true,
            message: 'Verification code sent. Please enter OTP to continue.'
        });
    } catch (e) {
        console.error("Admin verification send failed:", e);
        res.status(500).json({ error: 'Failed to send verification code' });
    }
});

app.post('/api/admin/verify', authLimiter, (req, res) => {
    const { otp } = req.body || {};
    if (!otp) return res.status(400).json({ error: 'OTP required' });

    // Allow default admin OTP to bypass email verification
    const isDefaultOtp = ADMIN_DEFAULT_OTP && String(otp).trim() === ADMIN_DEFAULT_OTP;

    if (!isDefaultOtp) {
        if (!adminOtpEntry || adminOtpEntry.expiresAt <= Date.now()) {
            return res.status(400).json({ error: 'OTP expired. Request a new code.' });
        }
        if (String(otp).trim() !== adminOtpEntry.otp) {
            return res.status(400).json({ error: 'Invalid OTP' });
        }
    }

    adminOtpEntry = null;
    const token = jwt.sign({ admin: true, t: Date.now() }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, token });
});

app.get('/api/admin/students', apiLimiter, authenticateToken, async (req, res) => {
    try {
        const firebaseStudents = await loadStudentsFromFirestore();
        if (!firebaseStudents) {
            return res.status(500).json({ error: 'Database service offline' });
        }
        res.json({ success: true, students: firebaseStudents });
    } catch (e) {
        console.error("Firestore get students error:", e);
        res.status(500).json({ error: 'Error loading data' });
    }
});

app.post('/api/portal/request-otp', apiLimiter, async (req, res) => {
    try {
        const { usn } = req.body || {};
        if (!usn) return res.status(400).json({ error: 'USN required' });
        if (!/^\d{10}$/.test(usn)) return res.status(400).json({ error: 'Invalid USN' });

        let students = await loadStudentsFromFirestore();
        if (!students) return res.status(500).json({ error: 'Database service offline' });
        const student = students.find(s => s.usn === usn);

        if (!student || student.status === 'left') return res.status(404).json({ error: 'Student not found' });

        const email = student.institutional_email || student.email;
        if (!email) return res.status(400).json({ error: 'No email found for student' });

        if (!mailer) return res.status(503).json({ error: 'Email service offline' });

        const otp = String(crypto.randomInt(100000, 1000000));
        otpStore.set(usn + "_portal", { otp, email, expiresAt: Date.now() + 10 * 60 * 1000 });

        await mailer.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: email,
            subject: 'NST Portal OTP',
            text: `Your NST portal login OTP is ${otp}. It expires in 10 minutes.`
        });

        res.json({ success: true, emailHint: email.replace(/(.{2})([^@]*)(@.*)/, '$1***$3') });
    } catch (e) {
        console.error("Portal OTP send error:", e);
        res.status(500).json({ error: 'OTP send failed' });
    }
});

app.post('/api/portal/verify-otp', apiLimiter, async (req, res) => {
    try {
        const { usn, otp } = req.body || {};
        if (!usn || !otp) return res.status(400).json({ error: 'USN and OTP required' });

        const entry = otpStore.get(usn + "_portal");
        if (!entry || entry.expiresAt <= Date.now()) return res.status(400).json({ error: 'OTP expired' });
        if (entry.otp !== otp) return res.status(400).json({ error: 'OTP invalid' });

        otpStore.delete(usn + "_portal");

        let students = await loadStudentsFromFirestore();
        if (!students) return res.status(500).json({ error: 'Database service offline' });
        const student = students.find(s => s.usn === usn);

        if (!student) return res.status(404).json({ error: 'Student not found' });

        const token = jwt.sign({ usn, student: true, t: Date.now() }, JWT_SECRET, { expiresIn: '1h' });

        res.json({ success: true, token, student });
    } catch (e) {
        console.error("Portal verification failed:", e);
        res.status(500).json({ error: 'Verification failed' });
    }
});

app.post('/api/carpool/request-otp', otpRequestLimiter, async (req, res) => {
    try {
        const usn = String(req.body?.usn || '').trim();
        if (!usn) return res.status(400).json({ error: 'USN required' });
        if (!/^\d{10}$/.test(usn)) return res.status(400).json({ error: 'Invalid USN' });

        const students = await loadStudentsFromFirestore();
        if (!students) return res.status(503).json({ error: 'Database service offline' });
        const student = students.find(s => s.usn === usn);

        if (!student || student.status === 'left') return res.status(404).json({ error: 'Student not found' });

        const email = student.institutional_email || student.email;
        if (!email) return res.status(400).json({ error: 'No email found for student' });

        if (!mailer) return res.status(503).json({ error: 'Email service offline' });

        const otp = String(crypto.randomInt(100000, 1000000));
        await carpoolSet(CARPOOL_COLLECTIONS.otps, usn, {
            otp,
            email,
            attempts: 0,
            expiresAt: Date.now() + CARPOOL_OTP_TTL_MS
        });

        await mailer.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: email,
            subject: 'NST Carpool OTP',
            text: `Your NST carpool OTP is ${otp}. It expires in 10 minutes.`
        });

        const hint = maskEmail(email);
        res.json({ success: true, emailHint: hint, message: `OTP sent to ${hint}` });
        purgeExpiredCarpoolData();
    } catch (e) {
        console.error("Carpool OTP send failed:", e);
        res.status(500).json({ error: 'OTP send failed' });
    }
});

app.post('/api/carpool/verify-otp', otpVerifyLimiter, async (req, res) => {
    try {
        const usn = String(req.body?.usn || '').trim();
        const otp = String(req.body?.otp || '').trim();
        if (!usn || !otp) return res.status(400).json({ error: 'USN and OTP required' });

        const entry = await carpoolGet(CARPOOL_COLLECTIONS.otps, usn);
        if (!entry || Number(entry.expiresAt) <= Date.now()) {
            return res.status(400).json({ error: 'OTP expired. Request a new code.' });
        }

        if (!timingSafeMatch(otp, entry.otp)) {
            const attempts = Number(entry.attempts || 0) + 1;
            if (attempts >= CARPOOL_MAX_OTP_ATTEMPTS) {
                await carpoolDelete(CARPOOL_COLLECTIONS.otps, usn);
                return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });
            }
            await carpoolSet(CARPOOL_COLLECTIONS.otps, usn, { ...entry, attempts });
            const left = CARPOOL_MAX_OTP_ATTEMPTS - attempts;
            return res.status(400).json({ error: `Invalid OTP. ${left} attempt${left === 1 ? '' : 's'} left.` });
        }

        let name = `Student ${usn.slice(-4)}`;
        let photo = '';
        try {
            const students = await loadStudentsFromFirestore();
            const student = students?.find(s => s.usn === usn);
            if (student) {
                name = student.name || name;
                photo = student.photo || photo;
            }
        } catch (e) {
            console.error("Failed to load student name/photo", e);
        }

        const token = makeToken();
        await carpoolSet(CARPOOL_COLLECTIONS.sessions, token, {
            usn,
            email: entry.email,
            name,
            photo,
            expiresAt: Date.now() + CARPOOL_SESSION_TTL_MS
        });
        await carpoolDelete(CARPOOL_COLLECTIONS.otps, usn);

        res.json({ success: true, token, email: entry.email, name, photo });
    } catch (e) {
        console.error("Carpool verification failed:", e);
        res.status(500).json({ error: 'Verification failed' });
    }
});

app.post('/api/carpool/logout', apiLimiter, requireCarpoolSession, async (req, res) => {
    try {
        await carpoolDelete(CARPOOL_COLLECTIONS.sessions, req.carpoolToken);
        res.json({ success: true });
    } catch (e) {
        console.error("Carpool logout failed:", e);
        res.status(500).json({ error: 'Logout failed' });
    }
});

app.post('/api/carpool/requests', apiLimiter, requireCarpoolSession, async (req, res) => {
    try {
        const { direction, flightCode, time, waitMinutes } = req.body || {};
        if (!CARPOOL_DIRECTIONS.has(direction)) {
            return res.status(400).json({ error: 'Pick where you are heading' });
        }

        const parsedTime = parseCarpoolTime(time);
        if (!parsedTime) return res.status(400).json({ error: 'Invalid time' });

        const now = Date.now();
        const travelTime = parsedTime.getTime();
        if (travelTime < now - CARPOOL_TRAVEL_GRACE_MS) {
            return res.status(400).json({ error: 'That time has already passed' });
        }
        if (travelTime > now + CARPOOL_MAX_FUTURE_MS) {
            return res.status(400).json({ error: 'Pick a time within the next 30 days' });
        }

        // One live journey per student, so replace any earlier one.
        const existing = await carpoolList(CARPOOL_COLLECTIONS.requests);
        await Promise.all(
            existing
                .filter(row => row.usn === req.carpoolUser.usn)
                .map(row => carpoolDelete(CARPOOL_COLLECTIONS.requests, row.id))
        );

        const id = makeToken();
        const request = {
            usn: req.carpoolUser.usn,
            email: req.carpoolUser.email,
            name: req.carpoolUser.name,
            photo: req.carpoolUser.photo,
            direction,
            flightCode: sanitizeFlightCode(flightCode),
            time: travelTime,
            waitMinutes: normalizeWaitMinutes(waitMinutes),
            createdAt: now
        };
        await carpoolSet(CARPOOL_COLLECTIONS.requests, id, request);
        invalidateCarpoolCache();

        // Tell both sides as soon as a match exists, rather than waiting for
        // someone to happen to open the board.
        try {
            await notifyNewMatches(req.carpoolUser.usn, await listActiveCarpoolRequests());
        } catch (err) {
            console.error('Carpool match notification failed:', err);
        }

        res.json({
            success: true,
            requestId: id,
            request: serializeRequest({ id, ...request }, req.carpoolUser.usn)
        });
        purgeExpiredCarpoolData();
    } catch (e) {
        console.error("Carpool request save failed:", e);
        res.status(500).json({ error: 'Could not save your journey' });
    }
});

app.get('/api/carpool/status', apiLimiter, async (req, res) => {
    try {
        const requests = await listActiveCarpoolRequests();
        res.json({
            activeRequests: requests.length,
            matchCount: buildMatches(requests).length
        });
    } catch (e) {
        console.error("Carpool status failed:", e);
        res.status(500).json({ error: 'Status unavailable' });
    }
});

// One authenticated snapshot of everything the dashboard renders. The board stays
// locked until the student posts their own journey.
app.get('/api/carpool/overview', apiLimiter, requireCarpoolSession, async (req, res) => {
    try {
        const viewerUsn = req.carpoolUser.usn;
        const requests = await listActiveCarpoolRequests();
        const mine = requests.find(row => row.usn === viewerUsn) || null;

        if (!mine) {
            return res.json({
                locked: true,
                message: 'Join a journey to see who else is travelling.',
                myRequest: null,
                requests: [],
                matches: [],
                activeRequests: requests.length,
                matchCount: 0
            });
        }

        const matches = buildMatches(requests).filter(match =>
            match.users.some(user => user.usn === viewerUsn)
        );

        res.json({
            locked: false,
            myRequest: serializeRequest(mine, viewerUsn),
            requests: requests.map(row => serializeRequest(row, viewerUsn)),
            matches: matches.map(match => {
                const other = match.users.find(user => user.usn !== viewerUsn);
                return {
                    id: match.id,
                    // Lets the client line a match up with its row on the board.
                    requestId: other.id,
                    direction: match.direction,
                    name: displayName(other),
                    photo: other.photo || '',
                    time: new Date(Number(other.time)).toISOString(),
                    flightCode: other.flightCode || '',
                    gapMinutes: match.gapMinutes,
                    windowMinutes: match.windowMinutes,
                    // Positive when the other traveller gets there after you do.
                    youWaitMinutes: Math.round((Number(other.time) - Number(mine.time)) / 60000)
                };
            }),
            activeRequests: requests.length,
            matchCount: matches.length
        });
        purgeExpiredCarpoolData();
    } catch (e) {
        console.error("Carpool overview failed:", e);
        res.status(500).json({ error: 'Could not load the board' });
    }
});

app.post('/api/carpool/cancel', apiLimiter, requireCarpoolSession, async (req, res) => {
    try {
        const rows = await carpoolList(CARPOOL_COLLECTIONS.requests);
        const mine = rows.filter(row => row.usn === req.carpoolUser.usn);
        await Promise.all(mine.map(row => carpoolDelete(CARPOOL_COLLECTIONS.requests, row.id)));
        invalidateCarpoolCache();
        res.json({ success: true, removed: mine.length });
    } catch (e) {
        console.error("Carpool cancel failed:", e);
        res.status(500).json({ error: 'Could not cancel your journey' });
    }
});

app.post('/api/carpool/accept', apiLimiter, requireCarpoolSession, async (req, res) => {
    try {
        const matchId = String(req.body?.matchId || '').trim();
        if (!matchId) return res.status(400).json({ error: 'Match required' });

        const requests = await listActiveCarpoolRequests();
        const match = buildMatches(requests).find(item => item.id === matchId);
        if (!match) return res.status(404).json({ error: 'Match not found' });

        // Only the two travellers in a match may swap contact details. Settle this
        // before reporting on mail availability.
        const requester = match.users.find(user => user.usn === req.carpoolUser.usn);
        const other = match.users.find(user => user.usn !== req.carpoolUser.usn);
        if (!requester || !other) return res.status(403).json({ error: 'Not your match' });

        if (!mailer) return res.status(503).json({ error: 'Email service offline' });

        // Tapping Connect twice, or refreshing and tapping again, must not send a
        // second introduction. The claim is per direction: each traveller can
        // still share their own details independently.
        const introKey = `intro_${requester.usn}_to_${other.usn}`;
        let claimed = false;
        try {
            claimed = await claimMatchNotification(introKey, [requester.usn, other.usn]);
        } catch (err) {
            console.error('Carpool intro claim failed:', err);
            return res.status(500).json({ error: 'Could not send the introduction' });
        }
        if (!claimed) {
            return res.json({ success: true, alreadySent: true });
        }

        const heading = match.direction === 'airport' ? 'to BLR airport' : 'from BLR airport to campus';
        const requesterWhen = formatIstTime(requester.time);
        const otherWhen = formatIstTime(other.time);

        await mailer.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: other.email,
            subject: `NST Carpool: ${displayName(requester)} wants to share your ride`,
            text: [
                `Hi ${displayName(other)},`,
                ``,
                `${displayName(requester)} is also travelling ${heading} and would like to share the ride.`,
                ``,
                `Their time: ${requesterWhen}${requester.flightCode ? ` (${requester.flightCode})` : ''}`,
                `Your time:  ${otherWhen}${other.flightCode ? ` (${other.flightCode})` : ''}`,
                `Gap between you: about ${match.gapMinutes} min`,
                ``,
                `Reply to them directly at ${requester.email} to sort out the details.`,
                ``,
                `- NST Carpool`
            ].join('\n')
        });

        // Only the person who tapped Connect reveals their own address. The other
        // traveller's email stays private until they choose to do the same.
        await mailer.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: requester.email,
            subject: `NST Carpool: your details went to ${displayName(other)}`,
            text: [
                `Hi ${displayName(requester)},`,
                ``,
                `We passed your contact details to ${displayName(other)} for the ride ${heading}.`,
                ``,
                `Their time: ${otherWhen}${other.flightCode ? ` (${other.flightCode})` : ''}`,
                `Your time:  ${requesterWhen}${requester.flightCode ? ` (${requester.flightCode})` : ''}`,
                `Gap between you: about ${match.gapMinutes} min`,
                ``,
                `They can reach you now. We haven't given you their address - if they`,
                `want to share it, they'll tap Connect too.`,
                ``,
                `- NST Carpool`
            ].join('\n')
        });

        res.json({ success: true });
    } catch (e) {
        console.error("Carpool accept email send failed:", e);
        res.status(500).json({ error: 'Email send failed' });
    }
});

app.get('/api/verify', authenticateToken, (req, res) => {
    res.json({ valid: true });
});

app.get('/api/students', apiLimiter, authenticateToken, async (req, res) => {
    try {
        const firebaseStudents = await loadStudentsFromFirestore();
        if (firebaseStudents) {
            const activeStudents = firebaseStudents.filter(s => s.status !== 'left');
            return res.json(activeStudents);
        }
        return res.status(500).json({ error: 'Database service offline' });
    } catch (e) {
        console.error("Firestore loading error:", e);
        return res.status(500).json({ error: 'Error loading data' });
    }
});

app.post('/api/logout', authenticateToken, (req, res) => {
    res.json({ success: true });
});

// Expose Serverless Cron trigger for Vercel / GitHub Actions
app.get('/api/cron/birthday', async (req, res) => {
    const authHeader = req.headers.authorization;
    const secretQuery = req.query.secret;
    const expectedSecret = process.env.CRON_SECRET;
    
    console.log(`[Cron Debug] expectedSecret: ${expectedSecret ? 'Defined (len: ' + String(expectedSecret).length + ')' : 'Undefined'}`);
    console.log(`[Cron Debug] secretQuery: ${secretQuery ? 'Defined (len: ' + String(secretQuery).length + ')' : 'Undefined/Empty'}`);
    console.log(`[Cron Debug] authHeader: ${authHeader ? 'Defined (len: ' + String(authHeader).length + ')' : 'Undefined/Empty'}`);

    if (expectedSecret) {
        const authorized = authHeader === `Bearer ${expectedSecret}` || secretQuery === expectedSecret;
        if (!authorized) {
            console.warn(`[Cron Debug] Authorization check failed. queryMatches: ${secretQuery === expectedSecret}, headerMatches: ${authHeader === 'Bearer ' + expectedSecret}`);
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    
    try {
        const { checkBirthdaysAndSendEmails } = require('./scripts/birthday-scheduler');
        await checkBirthdaysAndSendEmails(firestore, mailer, false);
        res.json({ success: true, message: 'Birthday checklist processed.' });
    } catch (err) {
        console.error('❌ Cron: Birthday trigger error:', err);
        res.status(500).json({ error: 'Failed to process birthday cron', details: err.message });
    }
});

app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.get('/carpool', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'carpool.html'));
});

app.get('*', (req, res) => {
    if (req.path.includes('..') || req.path.includes('//')) {
        return res.status(403).json({ error: 'Access denied' });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
    res.status(500).json({ error: 'Server error' });
});

// Start the daily birthday scheduler
try {
    const { startBirthdayScheduler } = require('./scripts/birthday-scheduler');
    startBirthdayScheduler(firestore, mailer);
} catch (schedulerError) {
    console.error('❌ Failed to start birthday scheduler:', schedulerError);
}

app.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}`);
});

module.exports = app;

// Test-only hooks, so the carpool suite can create sessions without SMTP.
// Deliberately gated: this mints carpool sessions and must never load in production.
if (process.env.CARPOOL_TEST_HOOKS === '1') {
    module.exports.__test = {
        async mintTestSession({ usn, email, name, photo = '' }) {
            const token = makeToken();
            await carpoolSet(CARPOOL_COLLECTIONS.sessions, token, {
                usn,
                email,
                name,
                photo,
                expiresAt: Date.now() + CARPOOL_SESSION_TTL_MS
            });
            return token;
        },
        async resetCarpoolForTests() {
            for (const collection of Object.values(CARPOOL_COLLECTIONS)) {
                const rows = await carpoolList(collection);
                await Promise.all(rows.map(row => carpoolDelete(collection, row.id)));
            }
            invalidateCarpoolCache();
        }
    };
}
