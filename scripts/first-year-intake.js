// Shared rules for the first-year intake portal.
//
// The incoming batch is collected by a handful of student volunteers on their
// phones, so every value lands here before it reaches Firestore: the portal is
// open to more people than the admin dashboard ever was, and a bad birthday
// string silently breaks the birthday cron a year from now.

const FIRST_YEAR_COLLECTION = 'students_2030';
const INTAKE_USERS_COLLECTION = 'intake_users';
const INTAKE_AUDIT_COLLECTION = 'intake_audit';

// The official batch split is released later in the year. Until then every
// record carries an empty batch and the form keeps the field disabled, so
// nobody guesses a value we would have to unpick afterwards.
const FIRST_YEAR_BATCH = '';
const FIRST_YEAR_YEAR = 1;

// Photos are kept at the best quality the storage allows, not the smallest
// that works. The hard limit is Firestore's 1MB per document, counted against
// the base64 text rather than the decoded image - so the real budget is
// 1MB / 1.33. Reserving room for the thumbnail and every other field leaves
// ~580KB of JPEG, which comfortably holds a 1440x1440 capture at quality 0.92.
// The browser walks a quality ladder down from there and only ever gives up
// resolution if a photo genuinely will not fit.
const MAX_PHOTO_BYTES = 580 * 1024;

// The grid lists every record at once, so the full-size capture never travels
// with a list response. The browser saves a 160px thumbnail off the same canvas
// - enough for a sharp 60px avatar on a retina screen - and only that one is
// sent, keeping a 150-student page well under a megabyte.
const MAX_THUMB_BYTES = 60 * 1024;
const PHOTO_PREFIX_RE = /^data:image\/(jpeg|webp);base64,/;

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const GENDERS = ['male', 'female', 'other'];

// Fields the record is not considered finished without. Saving is still allowed
// when they are blank - a volunteer who cannot get a blood group on the spot
// should not be stuck holding up the queue - but the admin view flags the gap.
const EXPECTED_FIELDS = ['gender', 'birthday', 'blood_group', 'mobile_number', 'photo'];

function cleanString(value, max = 200) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// First-year USNs are not published yet, so this stays deliberately loose:
// alphanumeric, the length range every USN the college has issued falls into.
// It also has to be a legal Firestore document id, which rules out slashes.
function normalizeUsn(value) {
    const usn = cleanString(value, 20).toUpperCase().replace(/\s/g, '');
    if (!/^[A-Z0-9]{6,15}$/.test(usn)) return null;
    return usn;
}

function normalizeName(value) {
    const name = cleanString(value, 80);
    if (name.length < 2) return null;
    if (!/^[\p{L}][\p{L}\s.'-]*$/u.test(name)) return null;
    return name;
}

function normalizeGender(value) {
    const gender = cleanString(value, 10).toLowerCase();
    return GENDERS.includes(gender) ? gender : '';
}

// Stored as DD-MM-YYYY because that is what the existing directory holds and
// what the birthday scheduler splits on. The form sends an ISO date, so the
// conversion happens here rather than in the browser where it could be skipped.
function normalizeBirthday(value) {
    const raw = cleanString(value, 10);
    if (!raw) return '';

    let year;
    let month;
    let day;

    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);

    if (iso) {
        [, year, month, day] = iso;
    } else if (dmy) {
        [, day, month, year] = dmy;
    } else {
        return null;
    }

    const date = new Date(Number(year), Number(month) - 1, Number(day));
    const realDate = date.getFullYear() === Number(year)
        && date.getMonth() === Number(month) - 1
        && date.getDate() === Number(day);
    if (!realDate) return null;

    // Catches a mistyped year rather than any real birthday: an incoming
    // first-year is a teenager, so anything outside this window is a slip.
    if (Number(year) < 1995 || Number(year) > 2015) return null;

    return `${day}-${month}-${year}`;
}

function normalizeBloodGroup(value) {
    const raw = cleanString(value, 12);
    if (!raw) return '';

    const compact = raw
        .toUpperCase()
        .replace(/\s+/g, '')
        .replaceAll('POSITIVE', '+')
        .replaceAll('NEGATIVE', '-')
        .replace(/\+VE$/, '+')
        .replace(/-VE$/, '-')
        .replace(/POS$/, '+')
        .replace(/NEG$/, '-');

    return BLOOD_GROUPS.includes(compact) ? compact : null;
}

// Accepts what a volunteer actually types - spaces, +91, a leading 0 - and
// stores the bare ten digits the rest of the directory already uses.
function normalizeMobile(value) {
    const digits = cleanString(value, 20).replace(/\D/g, '');
    if (!digits) return '';

    const local = digits.replace(/^(91|0)/, '');
    if (!/^[6-9]\d{9}$/.test(local)) return null;
    return local;
}

function normalizeEmail(value) {
    const email = cleanString(value, 120).toLowerCase();
    if (!email) return '';
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return null;
    return email;
}

// Only the two hosts the directory links to, and only over https - a free-text
// URL field on a page this many people can reach is not worth the risk.
function normalizeProfileUrl(value, host) {
    const raw = cleanString(value, 200);
    if (!raw) return '';

    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed;
    try {
        parsed = new URL(withScheme);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== host && !hostname.endsWith(`.${host}`)) return null;

    return parsed.toString();
}

// The browser already downscales and re-encodes on a canvas, which drops EXIF
// along with it. Server side we confirm the shape and the size rather than
// re-encoding, so the function stays free of a native image dependency.
function normalizeDataUri(value, maxBytes) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (!PHOTO_PREFIX_RE.test(raw)) return null;

    const base64 = raw.slice(raw.indexOf(',') + 1);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

    const bytes = Math.floor(base64.length * 3 / 4);
    // The floor only catches a truncated or empty data URI. It is deliberately
    // low: a flat, evenly lit photo compresses far harder than you would guess,
    // and a real capture must never be turned away for being efficient.
    if (bytes < 200 || bytes > maxBytes) return null;

    return raw;
}

const normalizePhoto = (value) => normalizeDataUri(value, MAX_PHOTO_BYTES);
const normalizeThumb = (value) => normalizeDataUri(value, MAX_THUMB_BYTES);

const FIELD_RULES = {
    name: { normalize: normalizeName, label: 'Name', required: true },
    gender: { normalize: normalizeGender, label: 'Gender' },
    birthday: { normalize: normalizeBirthday, label: 'Date of birth' },
    blood_group: { normalize: normalizeBloodGroup, label: 'Blood group' },
    mobile_number: { normalize: normalizeMobile, label: 'Mobile number' },
    email: { normalize: normalizeEmail, label: 'Personal email' },
    institutional_email: { normalize: normalizeEmail, label: 'College email' },
    github: { normalize: (v) => normalizeProfileUrl(v, 'github.com'), label: 'GitHub' },
    linkedin: { normalize: (v) => normalizeProfileUrl(v, 'linkedin.com'), label: 'LinkedIn' },
    photo: { normalize: normalizePhoto, label: 'Photo', required: true },
    photo_thumb: { normalize: normalizeThumb, label: 'Photo thumbnail', required: true }
};

// `partial` drives the edit path: only the keys actually sent get validated, so
// correcting one typo cannot blank out the rest of the record.
function validateStudentPayload(body, { partial = false } = {}) {
    const errors = [];
    const value = {};

    for (const [field, rule] of Object.entries(FIELD_RULES)) {
        const sent = Object.hasOwn(body || {}, field);
        if (partial && !sent) continue;

        const normalized = rule.normalize(body?.[field]);
        if (normalized === null) {
            errors.push(`${rule.label} is not valid`);
            continue;
        }
        if (rule.required && !normalized) {
            errors.push(`${rule.label} is required`);
            continue;
        }
        value[field] = normalized;
    }

    return { ok: errors.length === 0, value, errors };
}

function missingFields(record) {
    return EXPECTED_FIELDS.filter(field => !record?.[field]);
}

module.exports = {
    FIRST_YEAR_COLLECTION,
    INTAKE_USERS_COLLECTION,
    INTAKE_AUDIT_COLLECTION,
    FIRST_YEAR_BATCH,
    FIRST_YEAR_YEAR,
    MAX_PHOTO_BYTES,
    MAX_THUMB_BYTES,
    BLOOD_GROUPS,
    GENDERS,
    EXPECTED_FIELDS,
    normalizeUsn,
    normalizeBirthday,
    normalizeBloodGroup,
    validateStudentPayload,
    missingFields
};
