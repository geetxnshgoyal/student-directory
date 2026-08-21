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
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const crypto = require('node:crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const {
    getFlightProvider,
    computeReadyTime,
    computeLeaveTime,
    normaliseFlightNumber,
    isValidFlightNumber,
    isValidFlightDate,
    isDomesticFlight,
    ORIGIN_CITIES
} = require('./scripts/flight-provider');
const {
    SCHEDULE_COLLECTION,
    recordBoard,
    scheduleLookup,
    pruneSchedule
} = require('./scripts/flight-schedule');
const { getTravelEstimator } = require('./scripts/travel-time');
const bcrypt = require('bcryptjs');
const {
    FIRST_YEAR_COLLECTION,
    INTAKE_USERS_COLLECTION,
    INTAKE_AUDIT_COLLECTION,
    FIRST_YEAR_BATCH,
    FIRST_YEAR_YEAR,
    validateStudentPayload,
    normalizeUsn: normalizeIntakeUsn,
    missingFields
} = require('./scripts/first-year-intake');

const app = express();
// Vercel terminates TLS in front of us. Without this every request looks like it
// comes from the proxy, so all users would share a single rate-limit bucket.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

const otpStore = new Map();
let adminOtpEntry = null;
const ADMIN_DEFAULT_OTP = process.env.ADMIN_DEFAULT_OTP;
const DEMO_USN = process.env.DEMO_USN || '';
const DEMO_OTP = process.env.DEMO_OTP || '';

const CARPOOL_OTP_TTL_MS = 10 * 60 * 1000;
const CARPOOL_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const CARPOOL_TRAVEL_GRACE_MS = 2 * 60 * 60 * 1000;
const CARPOOL_MAX_FUTURE_MS = 30 * 24 * 60 * 60 * 1000;
const CARPOOL_MAX_OTP_ATTEMPTS = 5;
const CARPOOL_CACHE_MS = 5000;
const CARPOOL_DIRECTIONS = new Set(['hostel', 'airport']);
const CARPOOL_WAIT_CHOICES = [15, 30, 60, 240];
// How long after touchdown the traveller expects to be at the kerb.
const CARPOOL_BUFFER_CHOICES = [10, 20, 25, 35, 45];
const CARPOOL_DEFAULT_BUFFER = 25;
// Outbound: how early you want to be at the airport, and the drive itself.
// 180 covers wanting time in the lounge; 120 is the usual domestic cushion.
const CARPOOL_REACH_CHOICES = [90, 120, 150, 180];
const CARPOOL_DEFAULT_REACH = 120;
// Hostel to KIA is about 1h30 clear, and 1h45 or worse once traffic bites.
const CARPOOL_TRAVEL_CHOICES = [75, 90, 105, 120];
const CARPOOL_DEFAULT_TRAVEL = 90;

const CARPOOL_NOTIFY_TTL_MS = 24 * 60 * 60 * 1000;

const CARPOOL_COLLECTIONS = {
    otps: 'carpool_otps',
    sessions: 'carpool_sessions',
    requests: 'carpool_requests',
    notified: 'carpool_notified',
    // Not carpool data as such, but it rides the same store helpers and the
    // same in-memory fallback, so it lives with them.
    flightSchedule: SCHEDULE_COLLECTION
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

// Skyscanner by default, which needs no key but does need the network. Set
// FLIGHT_PROVIDER=stub to work offline against canned flights.
const flightProvider = getFlightProvider();
// Live traffic when GOOGLE_MAPS_API_KEY and HOSTEL_LATLNG are set, a flat
// estimate otherwise. Advisory either way: the student can always override it.
const travelEstimator = getTravelEstimator();

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

// flight-schedule.js stays storage agnostic so it can be tested against a plain
// Map; this is the adapter onto whatever the carpool helpers are backed by.
const flightScheduleStore = {
    get: id => carpoolGet(CARPOOL_COLLECTIONS.flightSchedule, id),
    set: (id, data) => carpoolSet(CARPOOL_COLLECTIONS.flightSchedule, id, data),
    delete: id => carpoolDelete(CARPOOL_COLLECTIONS.flightSchedule, id),
    list: () => carpoolList(CARPOOL_COLLECTIONS.flightSchedule)
};

/**
 * The live board first, the learned timetable second.
 *
 * Skyscanner only carries today and tomorrow. Beyond that the board simply has
 * no row, so rather than telling a student their real flight does not exist we
 * fall back to the schedule the nightly snapshot has been building. What comes
 * back is flagged estimated:true so the UI can say so out loud.
 */
async function lookupFlight(number, date, direction = 'Arrival') {
    const live = await flightProvider.lookup(number, date, direction);
    if (live) return live;
    try {
        return await scheduleLookup(flightScheduleStore, number, date, direction);
    } catch (err) {
        // A schedule miss must never turn a working lookup into a 503.
        console.error('Schedule fallback failed:', err);
        return null;
    }
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

function normalizeBufferMinutes(value) {
    const parsed = Number(value);
    return CARPOOL_BUFFER_CHOICES.includes(parsed) ? parsed : CARPOOL_DEFAULT_BUFFER;
}

function normalizeReachMinutes(value) {
    const parsed = Number(value);
    return CARPOOL_REACH_CHOICES.includes(parsed) ? parsed : CARPOOL_DEFAULT_REACH;
}

function normalizeTravelMinutes(value) {
    const parsed = Number(value);
    return CARPOOL_TRAVEL_CHOICES.includes(parsed) ? parsed : CARPOOL_DEFAULT_TRAVEL;
}

function normalizeWaitMinutes(value) {
    const parsed = Number(value);
    return CARPOOL_WAIT_CHOICES.includes(parsed) ? parsed : 30;
}

function displayName(row) {
    return row.name || `Student ${String(row.usn || '0000').slice(-4)}`;
}

function serializeFlight(flight) {
    if (!flight) return null;
    const arrival = flight.actualArrival ?? flight.estimatedArrival ?? flight.scheduledArrival;
    return {
        number: flight.number,
        airline: flight.airline || null,
        status: flight.status || 'unknown',
        from: flight.origin?.name || flight.origin?.code || null,
        terminal: flight.terminal || null,
        // Often absent. The UI shows it when present and never depends on it.
        belt: flight.belt || null,
        direction: flight.direction || 'arrival',
        to: flight.destination?.name || flight.destination?.code || null,
        scheduledArrival: Number.isFinite(flight.scheduledArrival)
            ? new Date(flight.scheduledArrival).toISOString() : null,
        scheduledDeparture: Number.isFinite(flight.scheduledDeparture)
            ? new Date(flight.scheduledDeparture).toISOString() : null,
        arrival: Number.isFinite(arrival) ? new Date(arrival).toISOString() : null,
        delayedBy: Number.isFinite(arrival) && Number.isFinite(flight.scheduledArrival)
            ? Math.round((arrival - flight.scheduledArrival) / 60000) : 0
    };
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
        flight: serializeFlight(request.flight),
        isYou,
        // Only the owner needs their own tolerance, to draw their match window.
        ...(isYou ? {
            waitMinutes: normalizeWaitMinutes(request.waitMinutes),
            bufferMinutes: request.bufferMinutes ?? null,
            reachMinutes: request.reachMinutes ?? null,
            travelMinutes: request.travelMinutes ?? null
        } : {})
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

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
}

// Indian mobiles are stored in a few shapes; normalise to a wa.me target.
function whatsappNumber(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) digits = `91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return digits;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits.length >= 11 && digits.length <= 15 ? digits : '';
}

function whatsappLink(recipient, other, match) {
    const number = whatsappNumber(other.mobile);
    if (!number) return '';

    const where = match.direction === 'airport' ? 'to BLR airport' : 'to the hostel from BLR airport';
    const message =
        `Hi ${displayName(other).split(' ')[0]}! This is ${displayName(recipient).split(' ')[0]} from NST. ` +
        `We're both heading ${where} around ${formatIstTime(other.time)}. Want to split a cab?`;

    return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

// One shell for every carpool email, so nothing goes out as bare plain text.
function carpoolEmailShell({ accent, avatarHtml, eyebrow, title, subtitle, rows, bodyLine, ctaHtml, footnote }) {
    const rowHtml = rows.map(([label, value]) => `
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #E9ECF1;font-size:13px;color:#838A96;">${escapeHtml(label)}</td>
          <td style="padding:9px 0;border-bottom:1px solid #E9ECF1;font-size:14px;color:#171A1F;font-weight:600;text-align:right;font-family:'SF Mono',Menlo,monospace;">${escapeHtml(value)}</td>
        </tr>`).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E2E5EA;border-radius:16px;overflow:hidden;">

        <tr><td style="background:${accent};padding:34px 32px 28px 32px;text-align:center;">
          ${avatarHtml}
          <div style="color:rgba(255,255,255,0.75);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:16px 0 6px 0;">${escapeHtml(eyebrow)}</div>
          <div style="color:#ffffff;font-size:25px;font-weight:700;">${escapeHtml(title)}</div>
          <div style="color:rgba(255,255,255,0.8);font-size:14px;margin-top:5px;">${escapeHtml(subtitle)}</div>
        </td></tr>

        <tr><td style="padding:28px 32px 8px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">${rowHtml}</table>
        </td></tr>

        <tr><td style="padding:24px 32px 6px 32px;" align="center">
          <div style="font-size:15px;color:#545A66;line-height:1.6;">${escapeHtml(bodyLine)}</div>
        </td></tr>

        ${ctaHtml}

        <tr><td style="padding:22px 32px 30px 32px;" align="center">
          <a href="${escapeHtml(process.env.PUBLIC_BASE_URL || '')}/carpool" style="font-size:13px;color:#1F4C7A;font-weight:600;text-decoration:none;">Open the carpool board &rarr;</a>
        </td></tr>

        <tr><td style="background:#EDEFF3;padding:18px 32px;text-align:center;border-top:1px solid #E2E5EA;">
          <div style="font-size:11px;color:#838A96;line-height:1.6;">${escapeHtml(footnote)}</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

function otpEmailHtml(otp) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#FFFFFF;border:1px solid #E2E5EA;border-radius:16px;overflow:hidden;">
        <tr><td style="background:#1F4C7A;padding:26px 32px;text-align:center;">
          <div style="color:rgba(255,255,255,0.75);font-size:11px;letter-spacing:2px;text-transform:uppercase;">NST Carpool</div>
          <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:6px;">Your sign-in code</div>
        </td></tr>
        <tr><td style="padding:34px 32px 10px 32px;" align="center">
          <div style="font-family:'SF Mono',Menlo,monospace;font-size:38px;font-weight:700;letter-spacing:10px;color:#171A1F;padding-left:10px;">${escapeHtml(otp)}</div>
          <div style="font-size:13px;color:#838A96;margin-top:16px;">This code expires in 10 minutes.</div>
        </td></tr>
        <tr><td style="background:#EDEFF3;padding:16px 32px;text-align:center;border-top:1px solid #E2E5EA;margin-top:20px;">
          <div style="font-size:11px;color:#838A96;line-height:1.6;">If you didn't try to sign in to NST Carpool, you can ignore this email.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function avatarFor(person, cid) {
    const initial = escapeHtml(displayName(person).trim().charAt(0).toUpperCase() || '?');
    return person.photo && String(person.photo).startsWith('data:image')
        ? `<img src="cid:${cid}" width="76" height="76" alt="" style="width:76px;height:76px;border-radius:50%;object-fit:cover;border:3px solid #ffffff;display:block;margin:0 auto;">`
        : `<div style="width:76px;height:76px;border-radius:50%;background:rgba(255,255,255,0.18);border:3px solid #ffffff;margin:0 auto;text-align:center;line-height:76px;font-size:30px;font-weight:700;color:#ffffff;">${initial}</div>`;
}

function photoAttachment(person, cid) {
    if (!person.photo || !String(person.photo).startsWith('data:image')) return [];
    try {
        return [{
            filename: 'photo.jpg',
            content: Buffer.from(String(person.photo).split(';base64,').pop(), 'base64'),
            cid
        }];
    } catch (e) {
        console.error('Carpool photo attach failed:', e);
        return [];
    }
}

function whatsappCta(recipient, other, match) {
    const wa = whatsappLink(recipient, other, match);
    if (!wa) {
        return `<tr><td style="padding:0 32px 8px 32px;" align="center">
                  <div style="font-size:13px;color:#838A96;">We don't have a mobile number on file for ${escapeHtml(displayName(other))}, so open the board to get in touch.</div>
                </td></tr>`;
    }
    return `<tr><td style="padding:0 32px 8px 32px;" align="center">
              <a href="${escapeHtml(wa)}" style="display:inline-block;background:#25D366;color:#ffffff;padding:15px 34px;border-radius:10px;font-weight:700;font-size:16px;text-decoration:none;">
                Message ${escapeHtml(displayName(other).split(' ')[0])} on WhatsApp
              </a>
              <div style="font-size:12px;color:#838A96;margin-top:12px;">Opens WhatsApp with a message ready to send.</div>
            </td></tr>`;
}

function tripRows(recipient, other, match) {
    return [
        ['Their time', formatIstTime(other.time) + (other.flightCode ? ` \u00b7 ${other.flightCode}` : '')],
        ['Your time', formatIstTime(recipient.time) + (recipient.flightCode ? ` \u00b7 ${recipient.flightCode}` : '')],
        ['Gap between you', `about ${match.gapMinutes} min`]
    ];
}

function directionAccent(direction) {
    return direction === 'hostel' ? '#2E6B5E' : '#8C2F39';
}

async function sendMatchAlert(recipient, other, match) {
    const heading = match.direction === 'airport'
        ? 'to BLR airport'
        : 'from BLR airport back to the hostel';
    const cid = 'carpool_photo';
    const wa = whatsappLink(recipient, other, match);

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: recipient.email,
        subject: `NST Carpool: ${displayName(other)} is travelling near your time`,
        attachments: photoAttachment(other, cid),
        html: carpoolEmailShell({
            accent: directionAccent(match.direction),
            avatarHtml: avatarFor(other, cid),
            eyebrow: 'You have a ride match',
            title: displayName(other),
            subtitle: `is travelling ${heading} with you`,
            rows: tripRows(recipient, other, match),
            bodyLine: 'Split the fare. Say hello and sort out a pickup point.',
            ctaHtml: whatsappCta(recipient, other, match),
            footnote: "You're both on the NST Carpool board for the same trip, so we shared your numbers to let you arrange the ride. Cancel your trip on the board to stop these emails."
        }),
        text: [
            `Hi ${displayName(recipient)},`,
            ``,
            `${displayName(other)} is heading ${heading} around the same time as you.`,
            ``,
            `Their time: ${formatIstTime(other.time)}${other.flightCode ? ` (${other.flightCode})` : ''}`,
            `Your time:  ${formatIstTime(recipient.time)}${recipient.flightCode ? ` (${recipient.flightCode})` : ''}`,
            `Gap between you: about ${match.gapMinutes} min`,
            ``,
            wa ? `Message them on WhatsApp: ${wa}` : `Open the board to get in touch.`,
            ``,
            `Board: ${process.env.PUBLIC_BASE_URL || ''}/carpool`,
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

// A capture at full quality is up to ~800KB of base64, well past the 100kb
// default. Only the intake write routes get the bigger ceiling; every other
// endpoint keeps the tighter default, which is the useful part of the limit.
app.use('/api/intake/students', express.json({ limit: '1500kb' }));

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

// Three different logins mint tokens: the shared directory password, the admin
// OTP, and a student's own portal OTP. Verifying the signature alone is not
// enough - without this, a student's token opens the admin directory.
function tokenRole(user) {
    if (user?.admin) return 'admin';
    if (user?.a) return 'directory';
    if (user?.student) return 'student';
    if (user?.intake) return 'intake';
    return null;
}

function requireRole(...allowed) {
    return (req, res, next) => {
        authenticateToken(req, res, () => {
            const role = tokenRole(req.user);
            if (!role || !allowed.includes(role)) {
                return res.status(403).json({ error: 'Not allowed' });
            }
            req.role = role;
            next();
        });
    };
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
    index: 'carpool.html',
    dotfiles: 'deny'
}));


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

app.get('/api/admin/students', apiLimiter, requireRole('admin'), async (req, res) => {
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



// ===== First-year intake portal =====
//
// A separate, lower-privilege login for the student volunteers collecting the
// incoming batch. They can add records and correct their own; nothing here can
// delete, and nothing here can touch the existing directory.

// Keyed by username, not IP. Fifteen volunteers on one campus network share an
// address, so an IP-keyed limiter would lock out the whole room the moment one
// person mistyped a password five times.
const intakeLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => String(req.body?.username || '').toLowerCase().slice(0, 40) || 'anonymous',
    // The key is a username, not an address, so the built-in IP check does not apply.
    validate: { ip: false },
    message: { error: 'Too many attempts for this account. Try again in a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const intakeWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Slow down a moment, then try again.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Compared against when the username does not exist, so a wrong username and a
// wrong password take the same time to answer and the form cannot be used to
// enumerate who has an account.
const INTAKE_DUMMY_HASH = '$2a$10$pGdLl9BmR67fLQebAdA2Eek.ETuMmoY01NlFQU.OYD8s0M62rIBCe';

function signIntakeToken(username, name) {
    return jwt.sign({ intake: true, u: username, n: name || username }, JWT_SECRET, { expiresIn: '8h' });
}

// The volunteer's record is re-read on every request rather than trusting the
// token alone. Disabling someone has to take effect now, not whenever their
// eight-hour token happens to expire.
function requireIntake({ allowPasswordReset = false } = {}) {
    return (req, res, next) => {
        requireRole('intake')(req, res, async () => {
            if (!firestore) return res.status(503).json({ error: 'Database service offline' });
            try {
                const username = String(req.user?.u || '');
                const snap = await firestore.collection(INTAKE_USERS_COLLECTION).doc(username).get();
                if (!snap.exists) return res.status(403).json({ error: 'Account not found' });

                const user = snap.data() || {};
                if (user.active === false) return res.status(403).json({ error: 'Account disabled' });
                if (user.must_reset && !allowPasswordReset) {
                    return res.status(428).json({ error: 'Set a new password to continue', mustReset: true });
                }

                req.intakeUser = { ...user, username };
                next();
            } catch (e) {
                console.error('Intake session lookup failed:', e);
                res.status(500).json({ error: 'Session check failed' });
            }
        });
    };
}

// Never fails the request it is recording - an unwritable audit line is worth a
// log entry, not a lost student record.
async function logIntakeAction(action, usn, by, details = {}) {
    if (!firestore) return;
    try {
        await firestore.collection(INTAKE_AUDIT_COLLECTION).add({
            action, usn, by, at: new Date().toISOString(), ...details
        });
    } catch (e) {
        console.error('Intake audit write failed:', e);
    }
}

// List responses carry the thumbnail only. The full-quality capture is fetched
// one record at a time, when a card is actually opened.
function withoutFullPhoto(record) {
    const { photo, ...rest } = record || {};
    return { ...rest, has_photo: Boolean(photo) };
}

app.post('/api/intake/login', intakeLoginLimiter, async (req, res) => {
    if (!firestore) return res.status(503).json({ error: 'Database service offline' });

    const username = String(req.body?.username || '').trim().toLowerCase().slice(0, 40);
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    try {
        const snap = await firestore.collection(INTAKE_USERS_COLLECTION).doc(username).get();
        const user = snap.exists ? snap.data() : null;
        const matches = await bcrypt.compare(password, user?.password_hash || INTAKE_DUMMY_HASH);

        if (!user || !matches || user.active === false) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        await snap.ref.set({ lastLoginAt: new Date().toISOString() }, { merge: true });

        res.json({
            success: true,
            token: signIntakeToken(username, user.name),
            name: user.name || username,
            mustReset: Boolean(user.must_reset)
        });
    } catch (e) {
        console.error('Intake login failed:', e);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/intake/session', apiLimiter, requireIntake({ allowPasswordReset: true }), (req, res) => {
    res.json({
        success: true,
        username: req.intakeUser.username,
        name: req.intakeUser.name || req.intakeUser.username,
        mustReset: Boolean(req.intakeUser.must_reset)
    });
});

app.post('/api/intake/change-password', apiLimiter, requireIntake({ allowPasswordReset: true }), async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    if (newPassword.length > 100) return res.status(400).json({ error: 'New password is too long' });
    if (newPassword === currentPassword) return res.status(400).json({ error: 'New password must be different from the old one' });

    try {
        const matches = await bcrypt.compare(currentPassword, req.intakeUser.password_hash || INTAKE_DUMMY_HASH);
        if (!matches) return res.status(401).json({ error: 'Current password is wrong' });

        await firestore.collection(INTAKE_USERS_COLLECTION).doc(req.intakeUser.username).set({
            password_hash: await bcrypt.hash(newPassword, 10),
            must_reset: false,
            passwordChangedAt: new Date().toISOString()
        }, { merge: true });

        await logIntakeAction('password_change', '', req.intakeUser.username);

        // A fresh token, so the client is not left holding one minted while the
        // account was still in must-reset.
        res.json({ success: true, token: signIntakeToken(req.intakeUser.username, req.intakeUser.name) });
    } catch (e) {
        console.error('Intake password change failed:', e);
        res.status(500).json({ error: 'Could not change password' });
    }
});

app.post('/api/intake/students', intakeWriteLimiter, requireIntake(), async (req, res) => {
    const usn = normalizeIntakeUsn(req.body?.usn);
    if (!usn) return res.status(400).json({ error: 'Enter a valid USN (6-15 letters or digits)' });

    const { ok, value, errors } = validateStudentPayload(req.body);
    if (!ok) return res.status(400).json({ error: errors[0], errors });

    try {
        // The two collections are separate, but a USN copied off an existing
        // senior's card would be a mess to untangle later, so it is refused now.
        const senior = await firestore.collection('students').doc(usn).get();
        if (senior.exists) {
            return res.status(409).json({ error: usn + ' already belongs to ' + (senior.data()?.name || 'a senior student') });
        }

        const now = new Date().toISOString();
        const record = {
            ...value,
            usn,
            batch: FIRST_YEAR_BATCH,
            year: FIRST_YEAR_YEAR,
            status: 'active',
            added_by: req.intakeUser.username,
            added_by_name: req.intakeUser.name || req.intakeUser.username,
            createdAt: now,
            updatedAt: now
        };

        // create(), not set(): two volunteers photographing the same student at
        // once should collide loudly rather than silently overwrite each other.
        await firestore.collection(FIRST_YEAR_COLLECTION).doc(usn).create(record);
        await logIntakeAction('create', usn, req.intakeUser.username, { name: record.name });

        res.status(201).json({ success: true, usn, missing: missingFields(record) });
    } catch (e) {
        if (e?.code === 6 || /already exists/i.test(e?.message || '')) {
            return res.status(409).json({ error: usn + ' has already been added' });
        }
        console.error('Intake create failed:', e);
        res.status(500).json({ error: 'Could not save student' });
    }
});

app.get('/api/intake/students', apiLimiter, requireIntake(), async (req, res) => {
    try {
        // Sorted here rather than in the query: an orderBy alongside the
        // equality filter would need a composite index created first.
        const snap = await firestore.collection(FIRST_YEAR_COLLECTION)
            .where('added_by', '==', req.intakeUser.username)
            .get();

        const students = [];
        snap.forEach(doc => {
            const record = doc.data() || {};
            students.push({ ...withoutFullPhoto(record), missing: missingFields(record) });
        });
        students.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

        res.json({ success: true, students });
    } catch (e) {
        console.error('Intake list failed:', e);
        res.status(500).json({ error: 'Could not load your entries' });
    }
});

app.get('/api/intake/students/:usn', apiLimiter, requireIntake(), async (req, res) => {
    const usn = normalizeIntakeUsn(req.params.usn);
    if (!usn) return res.status(400).json({ error: 'Invalid USN' });

    try {
        const doc = await firestore.collection(FIRST_YEAR_COLLECTION).doc(usn).get();
        if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

        const record = doc.data() || {};
        if (record.added_by !== req.intakeUser.username) {
            return res.status(403).json({ error: 'You can only open entries you added' });
        }

        res.json({ success: true, student: record });
    } catch (e) {
        console.error('Intake fetch failed:', e);
        res.status(500).json({ error: 'Could not load that student' });
    }
});

app.patch('/api/intake/students/:usn', intakeWriteLimiter, requireIntake(), async (req, res) => {
    const usn = normalizeIntakeUsn(req.params.usn);
    if (!usn) return res.status(400).json({ error: 'Invalid USN' });

    // Only known field names survive validation, so a request cannot reach in
    // and rewrite usn, added_by or the timestamps.
    const { ok, value, errors } = validateStudentPayload(req.body, { partial: true });
    if (!ok) return res.status(400).json({ error: errors[0], errors });
    if (Object.keys(value).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    try {
        const ref = firestore.collection(FIRST_YEAR_COLLECTION).doc(usn);
        const doc = await ref.get();
        if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

        const record = doc.data() || {};
        if (record.added_by !== req.intakeUser.username) {
            return res.status(403).json({ error: 'You can only edit entries you added' });
        }

        await ref.set({ ...value, updatedAt: new Date().toISOString() }, { merge: true });
        await logIntakeAction('update', usn, req.intakeUser.username, { fields: Object.keys(value) });

        res.json({ success: true, usn, missing: missingFields({ ...record, ...value }) });
    } catch (e) {
        console.error('Intake update failed:', e);
        res.status(500).json({ error: 'Could not update student' });
    }
});

// ===== Admin: first-year batch =====

app.get('/api/admin/first-year', apiLimiter, requireRole('admin'), async (req, res) => {
    if (!firestore) return res.status(503).json({ error: 'Database service offline' });
    try {
        const snap = await firestore.collection(FIRST_YEAR_COLLECTION).get();

        const students = [];
        snap.forEach(doc => {
            const record = doc.data() || {};
            students.push({ ...withoutFullPhoto(record), missing: missingFields(record) });
        });
        students.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

        res.json({ success: true, students });
    } catch (e) {
        console.error('First-year list failed:', e);
        res.status(500).json({ error: 'Error loading data' });
    }
});

app.get('/api/admin/first-year/:usn', apiLimiter, requireRole('admin'), async (req, res) => {
    if (!firestore) return res.status(503).json({ error: 'Database service offline' });
    const usn = normalizeIntakeUsn(req.params.usn);
    if (!usn) return res.status(400).json({ error: 'Invalid USN' });

    try {
        const doc = await firestore.collection(FIRST_YEAR_COLLECTION).doc(usn).get();
        if (!doc.exists) return res.status(404).json({ error: 'Student not found' });
        res.json({ success: true, student: doc.data() });
    } catch (e) {
        console.error('First-year fetch failed:', e);
        res.status(500).json({ error: 'Error loading student' });
    }
});

// Deleting is deliberately admin-only: volunteers add and correct their own,
// but a bad record can only be removed from here.
app.delete('/api/admin/first-year/:usn', apiLimiter, requireRole('admin'), async (req, res) => {
    if (!firestore) return res.status(503).json({ error: 'Database service offline' });
    const usn = normalizeIntakeUsn(req.params.usn);
    if (!usn) return res.status(400).json({ error: 'Invalid USN' });

    try {
        const ref = firestore.collection(FIRST_YEAR_COLLECTION).doc(usn);
        const doc = await ref.get();
        if (!doc.exists) return res.status(404).json({ error: 'Student not found' });

        const name = doc.data()?.name || '';
        await ref.delete();
        await logIntakeAction('delete', usn, 'admin', { name });

        res.json({ success: true, usn });
    } catch (e) {
        console.error('First-year delete failed:', e);
        res.status(500).json({ error: 'Could not delete student' });
    }
});


app.post('/api/carpool/request-otp', otpRequestLimiter, async (req, res) => {
    try {
        const usn = String(req.body?.usn || '').trim();
        if (!usn) return res.status(400).json({ error: 'USN required' });
        if (!/^\d{10}$/.test(usn)) return res.status(400).json({ error: 'Invalid USN' });

        // Demo account: skip the DB lookup and the email, just acknowledge.
        if (DEMO_USN && DEMO_OTP && usn === DEMO_USN) {
            return res.json({ success: true, emailHint: 'de***@svyasa-sas.edu.in', message: 'OTP sent to de***@svyasa-sas.edu.in' });
        }

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
            subject: `${otp} is your NST Carpool code`,
            html: otpEmailHtml(otp),
            text: `Your NST carpool code is ${otp}. It expires in 10 minutes.`
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

        // Demo account: validate against the fixed code, no DB lookup.
        if (DEMO_USN && DEMO_OTP && usn === DEMO_USN) {
            if (!timingSafeMatch(otp, DEMO_OTP)) {
                return res.status(400).json({ error: 'Invalid OTP' });
            }
            const demoName = 'Demo';
            const demoEmail = 'demo@svyasa-sas.edu.in';
            const token = makeToken();
            await carpoolSet(CARPOOL_COLLECTIONS.sessions, token, {
                usn: DEMO_USN,
                email: demoEmail,
                name: demoName,
                photo: '',
                mobile: '',
                expiresAt: Date.now() + CARPOOL_SESSION_TTL_MS
            });
            return res.json({ success: true, token, email: demoEmail, name: demoName, photo: '' });
        }

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
        let mobile = '';
        try {
            const students = await loadStudentsFromFirestore();
            const student = students?.find(s => s.usn === usn);
            if (student) {
                name = student.name || name;
                photo = student.photo || photo;
                mobile = student.mobile_number || '';
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
            mobile,
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

// Cities we offer as departure points. Static, so it costs no API calls.
app.get('/api/carpool/flights/cities', apiLimiter, requireCarpoolSession, (req, res) => {
    res.json({ cities: ORIGIN_CITIES });
});

// Arrivals into BLR from one city on one date, filtered to the carriers our
// students actually fly. Two upstream calls, since the airport feed caps each
// request at a 12 hour window.
app.get('/api/carpool/flights/search', apiLimiter, requireCarpoolSession, async (req, res) => {
    const from = String(req.query.from || '').trim().toUpperCase();
    const date = String(req.query.date || '').trim();

    if (!ORIGIN_CITIES.some(city => city.code === from)) {
        return res.status(400).json({ error: 'Pick a departure city from the list' });
    }
    if (!isValidFlightDate(date)) {
        return res.status(400).json({ error: 'Pick a valid date' });
    }

    try {
        const flights = await flightProvider.searchArrivals(from, date);
        res.json({ success: true, flights, provider: flightProvider.name });
    } catch (err) {
        console.error('Flight search failed:', err);
        res.status(503).json({ error: 'Flight search is unavailable. Enter your time manually instead.' });
    }
});

// What the hostel to airport drive is likely to take at a given moment.
app.get('/api/carpool/travel-estimate', apiLimiter, requireCarpoolSession, async (req, res) => {
    const at = Number(req.query.at);
    try {
        const estimate = await travelEstimator.estimate(Number.isFinite(at) ? at : Date.now());
        res.json({ success: true, ...estimate });
    } catch (err) {
        console.error('Travel estimate failed:', err);
        // Advisory only, so a failure degrades to the flat default rather than
        // blocking the form.
        res.json({ success: true, minutes: CARPOOL_DEFAULT_TRAVEL, staticMinutes: CARPOOL_DEFAULT_TRAVEL,
            trafficDelayMinutes: 0, source: 'fallback' });
    }
});

// Departures out of BLR to one city, for the hostel-to-airport direction.
app.get('/api/carpool/flights/departures', apiLimiter, requireCarpoolSession, async (req, res) => {
    const to = String(req.query.to || '').trim().toUpperCase();
    const date = String(req.query.date || '').trim();

    if (!ORIGIN_CITIES.some(city => city.code === to)) {
        return res.status(400).json({ error: 'Pick a destination city from the list' });
    }
    if (!isValidFlightDate(date)) {
        return res.status(400).json({ error: 'Pick a valid date' });
    }

    try {
        const flights = await flightProvider.searchDepartures(to, date);
        res.json({ success: true, flights, provider: flightProvider.name });
    } catch (err) {
        console.error('Departure search failed:', err);
        res.status(503).json({ error: 'Flight search is unavailable. Enter your time manually instead.' });
    }
});

// Schedule lookup for the trip form. One call per posted trip; the live-status
// polling that phase 2 adds reuses the same provider.
app.get('/api/carpool/flights', apiLimiter, requireCarpoolSession, async (req, res) => {
    const number = String(req.query.number || '').trim();
    const date = String(req.query.date || '').trim();

    if (!isValidFlightNumber(number)) {
        return res.status(400).json({ error: 'Enter a flight number like 6E 2134' });
    }
    if (!isValidFlightDate(date)) {
        return res.status(400).json({ error: 'Pick a valid date' });
    }

    try {
        const flight = await lookupFlight(number, date);
        if (!flight) {
            return res.status(404).json({ error: "We couldn't find that flight. Enter your time manually instead." });
        }
        if (!isDomesticFlight(flight)) {
            return res.status(400).json({ error: 'We only cover domestic flights. Enter your time manually instead.' });
        }
        res.json({ success: true, flight, provider: flightProvider.name });
    } catch (err) {
        console.error('Flight lookup failed:', err);
        // Never let the flight API block a student: the form falls back to
        // manual entry on a 503.
        res.status(503).json({ error: 'Flight lookup is unavailable. Enter your time manually instead.' });
    }
});

app.post('/api/carpool/requests', apiLimiter, requireCarpoolSession, async (req, res) => {
    try {
        const { direction, flightCode, time, waitMinutes, flightNumber, flightDate,
            bufferMinutes, reachMinutes, travelMinutes } = req.body || {};
        if (!CARPOOL_DIRECTIONS.has(direction)) {
            return res.status(400).json({ error: 'Pick where you are heading' });
        }

        // A trip is timed one of two ways: from a flight the student picked, or
        // from a time they typed. The flight path only makes sense inbound; a
        // departure is about when you leave the hostel, not when you take off.
        let flight = null;
        let buffer = normalizeBufferMinutes(bufferMinutes);
        let travelTime = null;

        let reach = null;
        let travel = null;

        if (flightNumber) {
            if (!isValidFlightNumber(flightNumber)) {
                return res.status(400).json({ error: 'Enter a flight number like 6E 2134' });
            }
            if (!isValidFlightDate(flightDate)) {
                return res.status(400).json({ error: 'Pick a valid flight date' });
            }

            const inbound = direction === 'hostel';
            try {
                flight = await lookupFlight(flightNumber, flightDate, inbound ? 'Arrival' : 'Departure');
            } catch (err) {
                console.error('Flight lookup failed during trip creation:', err);
                return res.status(503).json({ error: 'Flight lookup is unavailable. Enter your time manually instead.' });
            }
            if (!flight) {
                return res.status(404).json({ error: "We couldn't find that flight. Enter your time manually instead." });
            }
            if (!isDomesticFlight(flight)) {
                return res.status(400).json({ error: 'We only cover domestic flights. Enter your time manually instead.' });
            }

            if (inbound) {
                // Arriving: the useful moment is reaching the kerb.
                travelTime = computeReadyTime(flight, buffer);
            } else {
                // Departing: the useful moment is walking out of the hostel,
                // which is the check-in cushion plus the drive before take-off.
                buffer = null;
                reach = normalizeReachMinutes(reachMinutes);
                travel = normalizeTravelMinutes(travelMinutes);
                travelTime = computeLeaveTime(flight, reach, travel);
            }

            if (!Number.isFinite(travelTime)) {
                return res.status(422).json({ error: "That flight has no time yet. Enter your time manually instead." });
            }
        } else {
            const parsedTime = parseCarpoolTime(time);
            if (!parsedTime) return res.status(400).json({ error: 'Invalid time' });
            travelTime = parsedTime.getTime();
            buffer = null;
        }

        const now = Date.now();
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
            mobile: req.carpoolUser.mobile || '',
            direction,
            // Kept for manual trips and as the display label; a tracked flight
            // fills it from the provider so both paths render identically.
            flightCode: flight ? flight.number : sanitizeFlightCode(flightCode),
            time: travelTime,
            waitMinutes: normalizeWaitMinutes(waitMinutes),
            bufferMinutes: buffer,
            reachMinutes: reach,
            travelMinutes: travel,
            flight: flight || null,
            createdAt: now
        };
        await carpoolSet(CARPOOL_COLLECTIONS.requests, id, request);
        invalidateCarpoolCache();

        res.json({
            success: true,
            requestId: id,
            request: serializeRequest({ id, ...request }, req.carpoolUser.usn)
        });

        // Answer first, then mail. Awaiting two SMTP round trips before
        // responding left the student watching a spinner and ate into the
        // serverless execution budget.
        listActiveCarpoolRequests()
            .then(rows => notifyNewMatches(req.carpoolUser.usn, rows))
            .catch(err => console.error('Carpool match notification failed:', err));

        purgeExpiredCarpoolData();
    } catch (e) {
        console.error("Carpool request save failed:", e);
        res.status(500).json({ error: 'Could not save your journey' });
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





// Expose Serverless Cron trigger for Vercel / GitHub Actions
app.get('/api/cron/birthday', async (req, res) => {
    const authHeader = req.headers.authorization;
    const secretQuery = req.query.secret;
    const expectedSecret = process.env.CRON_SECRET;

    // Fail closed. Without a secret this endpoint would let anyone fire the
    // day's emails.
    if (!expectedSecret) {
        console.error('CRON_SECRET is not configured; refusing to run the birthday job.');
        return res.status(503).json({ error: 'Cron secret not configured' });
    }

    if (authHeader !== `Bearer ${expectedSecret}` && secretQuery !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
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

/**
 * Nightly: fold the board into the learned timetable.
 *
 * Two network calls total - one per direction - because the board already
 * carries both today and tomorrow and the provider caches it. Tomorrow is the
 * more useful of the two: it is a full day, where today is already half flown.
 */
app.get('/api/cron/flight-schedule', async (req, res) => {
    const expectedSecret = process.env.CRON_SECRET;
    if (!expectedSecret) {
        console.error('CRON_SECRET is not configured; refusing to run the flight schedule job.');
        return res.status(503).json({ error: 'Cron secret not configured' });
    }
    if (req.headers.authorization !== `Bearer ${expectedSecret}` && req.query.secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (typeof flightProvider.listBoard !== 'function') {
        return res.status(503).json({
            error: `Provider "${flightProvider.name}" cannot list a whole board; the schedule job needs skyscanner.`
        });
    }

    try {
        const istToday = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const istTomorrow = new Date(Date.now() + 5.5 * 60 * 60 * 1000 + 86400000).toISOString().slice(0, 10);

        const totals = { written: 0, skipped: 0 };
        for (const date of [istToday, istTomorrow]) {
            for (const direction of ['Arrival', 'Departure']) {
                const board = await flightProvider.listBoard(date, direction);
                // Only what we would ever serve. An international row would just
                // be rejected at lookup, so there is no point learning it.
                const domestic = board.filter(isDomesticFlight);
                const result = await recordBoard(flightScheduleStore, domestic);
                totals.written += result.written;
                totals.skipped += result.skipped;
            }
        }

        const { removed } = await pruneSchedule(flightScheduleStore, { today: istToday });
        console.log(`Flight schedule: ${totals.written} observations, ${removed} stale entries dropped.`);
        res.json({ success: true, dates: [istToday, istTomorrow], ...totals, removed });
    } catch (err) {
        console.error('❌ Cron: Flight schedule error:', err);
        res.status(500).json({ error: 'Failed to refresh the flight schedule', details: err.message });
    }
});

app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.get('/carpool', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'carpool.html'));
});

app.get('/intake', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'intake.html'));
});

app.get('*', (req, res) => {
    if (req.path.includes('..') || req.path.includes('//')) {
        return res.status(403).json({ error: 'Access denied' });
    }
    // A missing asset should 404, not quietly return the app shell.
    if (/\.[a-z0-9]{2,5}$/i.test(req.path)) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, 'public', 'carpool.html'));
});

app.use((err, req, res, next) => {
    // body-parser rejects an oversized or malformed payload before any route
    // runs. Without these two cases a volunteer whose photo is too big just
    // gets "Server error", which tells them nothing about what to do next.
    if (err?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'That photo is too large to save. Retake it and try again.' });
    }
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Malformed request' });
    }
    console.error('Unhandled error:', err);
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
        async mintTestSession({ usn, email, name, photo = '', mobile = '' }) {
            const token = makeToken();
            await carpoolSet(CARPOOL_COLLECTIONS.sessions, token, {
                usn,
                email,
                name,
                photo,
                mobile,
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
