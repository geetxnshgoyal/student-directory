/**
 * Fill in the batch on first-year records that were entered before the official
 * list existed.
 *
 * Every record added during the blind period carries an empty batch. This walks
 * them, runs the same lookup the write path uses, and fills in what it can. A
 * name the list cannot decide is reported and left alone rather than guessed at.
 *
 * Dry run by default. Pass --apply to write.
 */

const path = require('node:path');

try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch { /* the server's own fallback loader covers this */ }

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { FIRST_YEAR_COLLECTION } = require('./first-year-intake');
const { lookupBatch } = require('./first-year-batch-list');

const APPLY = process.argv.includes('--apply');

function connect() {
    if (!getApps().length) {
        initializeApp({
            credential: cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replaceAll('\\n', '\n')
            })
        });
    }
    return getFirestore();
}

(async () => {
    const db = connect();
    const snapshot = await db.collection(FIRST_YEAR_COLLECTION).get();

    const planned = [];
    const unresolved = [];
    let alreadySet = 0;

    snapshot.forEach((doc) => {
        const record = doc.data() || {};
        if (record.batch) { alreadySet++; return; }

        const found = lookupBatch(record.name);
        if (found.status === 'none' || found.status === 'ambiguous') {
            unresolved.push({ usn: doc.id, name: record.name, why: found.status, options: found.candidates || [] });
            return;
        }
        planned.push({ usn: doc.id, name: record.name, batch: found.batch, section: found.section, how: found.status });
    });

    console.log(`${snapshot.size} first-year records, ${alreadySet} already batched.\n`);

    if (planned.length) {
        console.log(APPLY ? 'FILLING IN' : 'WOULD FILL IN (dry run)');
        planned.forEach((p) => console.log(`  ${p.usn}  ${(p.name || '').padEnd(24)} -> ${p.batch} ${p.section}  (${p.how})`));
    } else {
        console.log('Nothing to fill in.');
    }

    if (unresolved.length) {
        console.log('\nLEFT ALONE - these need a person to decide:');
        unresolved.forEach((u) => {
            const detail = u.why === 'none'
                ? 'not on the official list'
                : 'could be ' + u.options.map((c) => `${c.name} [${c.label}]`).join(' / ');
            console.log(`  ${u.usn}  ${(u.name || '').padEnd(24)} ${detail}`);
        });
    }

    if (!APPLY) {
        console.log('\nDry run. Re-run with --apply to write these.');
        return;
    }

    let batch = db.batch();
    planned.forEach((p, i) => {
        batch.update(db.collection(FIRST_YEAR_COLLECTION).doc(p.usn), {
            batch: p.batch,
            section: p.section,
            batch_match: p.how,
            updatedAt: new Date().toISOString()
        });
        if ((i + 1) % 400 === 0) { batch.commit(); batch = db.batch(); }
    });
    if (planned.length) await batch.commit();
    console.log(`\nWrote ${planned.length} record(s).`);
})().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
