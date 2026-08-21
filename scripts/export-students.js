/**
 * Export a filtered slice of the student directory to CSV.
 *
 * The admin panel already filters by gender and branch on screen; this is the
 * same thing for when you need the rows in a file - a mail merge, a headcount
 * for a report, a hostel list.
 *
 * Output goes to exports/, which is gitignored, and never to stdout. That is
 * deliberate: student names and addresses in a terminal end up in shell history,
 * CI logs and chat transcripts, and there is no reason to put them there when a
 * file does the job. The script prints counts only.
 *
 *   node scripts/export-students.js --gender=female
 *   node scripts/export-students.js --gender=female --fields=name,institutional_email
 *   node scripts/export-students.js --branch=CSE --out=exports/cse.csv
 *   node scripts/export-students.js --count-only
 *
 * Needs the same FIREBASE_* credentials in .env that the server uses.
 */

const fs = require('node:fs');
const path = require('node:path');

try {
    require('dotenv').config();
} catch {
    // server.js has a hand-rolled fallback; for a dev script, dotenv or nothing.
}

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const DEFAULT_FIELDS = ['name', 'usn', 'institutional_email'];
const EXPORT_DIR = path.join(__dirname, '..', 'exports');

function parseArgs(argv) {
    const args = {};
    for (const raw of argv.slice(2)) {
        const match = raw.match(/^--([^=]+)(?:=(.*))?$/);
        if (!match) continue;
        args[match[1]] = match[2] === undefined ? true : match[2];
    }
    return args;
}

function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    // Guard against CSV injection: a cell starting with these is executed as a
    // formula when the file is opened in Excel or Sheets.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

async function main() {
    const args = parseArgs(process.argv);

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!projectId || !clientEmail || !privateKey) {
        console.error('Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY in .env');
        process.exit(1);
    }

    if (!getApps().length) {
        initializeApp({
            credential: cert({ projectId, clientEmail, privateKey: privateKey.replaceAll('\\n', '\n') })
        });
    }

    const snapshot = await getFirestore().collection('students').get();
    let students = snapshot.docs.map(doc => {
        const record = doc.data() || {};
        if (!record.usn) record.usn = doc.id;
        return record;
    });
    const total = students.length;

    // Same comparison the admin panel uses, so the file and the screen agree.
    for (const key of ['gender', 'branch', 'batch']) {
        if (typeof args[key] === 'string' && args[key]) {
            const wanted = args[key].toLowerCase();
            students = students.filter(s => String(s[key] || '').toLowerCase() === wanted);
        }
    }

    students.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    const filters = ['gender', 'branch', 'batch']
        .filter(k => typeof args[k] === 'string' && args[k])
        .map(k => `${k}=${args[k]}`)
        .join(' ') || 'none';
    console.log(`Directory: ${total} students, ${students.length} matched (filters: ${filters})`);

    const missing = students.filter(s => !s.institutional_email).length;
    if (missing) console.log(`Note: ${missing} matched student(s) have no institutional_email on record.`);

    if (args['count-only']) return;

    const fields = typeof args.fields === 'string' && args.fields
        ? args.fields.split(',').map(f => f.trim()).filter(Boolean)
        : DEFAULT_FIELDS;

    const stamp = new Date().toISOString().slice(0, 10);
    const outPath = path.resolve(
        typeof args.out === 'string' && args.out
            ? args.out
            : path.join(EXPORT_DIR, `students-${filters === 'none' ? 'all' : filters.replaceAll(/[^a-z0-9]+/gi, '-')}-${stamp}.csv`)
    );

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const rows = [fields.join(',')];
    for (const student of students) rows.push(fields.map(f => csvCell(student[f])).join(','));
    fs.writeFileSync(outPath, rows.join('\n') + '\n', { mode: 0o600 });

    console.log(`Wrote ${students.length} rows to ${path.relative(process.cwd(), outPath)}`);
    console.log('This file contains personal data. exports/ is gitignored; delete it when you are done.');
}

main().catch(err => {
    console.error('Export failed:', err.message);
    process.exit(1);
});
