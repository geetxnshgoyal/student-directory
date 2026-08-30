// Shared rules for the yearbook.
//
// The yearbook shows the batch to the batch, which is a wider audience than the
// directory has ever had - that one is admin-only. So two things are decided
// here rather than in a route: what a student is allowed to write, and what a
// student is allowed to be identified by.
//
// Nothing in here talks to Firestore. It is all pure, so the rules can be
// tested without credentials.

const crypto = require('node:crypto');

const ENTRY_COLLECTION = 'yearbook_entries';
const NOTE_COLLECTION = 'yearbook_notes';

// The line under the portrait. One line - newlines are folded away - because a
// paragraph here would break the card grid.
const MAX_QUOTE = 160;
// The longer note on a profile. Paragraph breaks survive.
const MAX_ABOUT = 600;
// What one student writes on another's page.
const MAX_NOTE = 500;

// A yearbook entry is only ever addressed by this, never by USN. The carpool
// board already refuses to put a USN on the wire, and the yearbook is read by
// more people than the board is, so the same rule holds: the client gets an
// opaque, non-reversible handle and the server maps it back against the roster.
//
// Derived rather than stored, so there is no id field to keep in sync and no
// second source of truth. It moves if JWT_SECRET is rotated, which is harmless
// - nothing persists an id - and JWT_SECRET has to be stable in production
// anyway or every session breaks.
function publicId(usn, secret) {
    return crypto
        .createHmac('sha256', String(secret))
        .update(`yearbook:${String(usn)}`)
        .digest('hex')
        .slice(0, 16);
}

function isPublicId(value) {
    return /^[0-9a-f]{16}$/.test(String(value ?? ''));
}

// One note per pair, so the doc id is the pair. Two students cannot end up with
// duplicate notes to each other, a second write is an edit rather than a
// pile-up, and nobody can bury someone under fifty messages - the cap comes free
// with the key instead of needing a counter to enforce it.
function noteDocId(toUsn, fromUsn) {
    return `${String(toUsn)}_${String(fromUsn)}`;
}

// C0 and C1 controls, minus the newline and tab worth keeping. A stray one of
// these is either a paste artefact or someone probing the renderer.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Zero-width characters and bidirectional overrides. They render as nothing and
// can make displayed text read differently from stored text, which is not a
// trick a yearbook needs to support.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function stripUnsafe(value) {
    return String(value ?? '').replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '');
}

function cleanLine(value, max) {
    return stripUnsafe(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Keeps paragraph breaks, drops the runs of blank lines people use to push
// their entry down the page.
function cleanBlock(value, max) {
    return stripUnsafe(value)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max);
}

// Every entry field is optional and every one may be cleared, so these return a
// string rather than null: there is no invalid quote, only a long one, and
// truncating beats refusing someone's save over a character count.
const normalizeQuote = (value) => cleanLine(value, MAX_QUOTE);
const normalizeAbout = (value) => cleanBlock(value, MAX_ABOUT);

// A note is the one field that can be rejected. An empty one is a slip rather
// than a request to clear anything, and there is a separate delete for that.
function normalizeNote(value) {
    const text = cleanBlock(value, MAX_NOTE);
    return text.length > 0 ? text : null;
}

const ENTRY_RULES = {
    quote: { normalize: normalizeQuote },
    about: { normalize: normalizeAbout },
    // Opting out takes the student off the grid entirely. The directory is
    // admin-only; the yearbook is not, and someone who would rather not be in
    // front of the whole batch should not have to ask an admin to be removed.
    hidden: { normalize: (value) => value === true || value === 'true' }
};

// `partial` is the mode every save uses: the editor sends the fields it has, and
// an absent key means "leave it alone" rather than "blank it".
function validateEntryPayload(body, { partial = true } = {}) {
    const value = {};
    for (const [field, rule] of Object.entries(ENTRY_RULES)) {
        if (partial && !Object.hasOwn(body || {}, field)) continue;
        value[field] = rule.normalize(body?.[field]);
    }
    return { ok: true, value };
}

module.exports = {
    ENTRY_COLLECTION,
    NOTE_COLLECTION,
    MAX_QUOTE,
    MAX_ABOUT,
    MAX_NOTE,
    publicId,
    isPublicId,
    noteDocId,
    normalizeQuote,
    normalizeAbout,
    normalizeNote,
    validateEntryPayload
};
