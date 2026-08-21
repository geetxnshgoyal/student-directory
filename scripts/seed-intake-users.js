#!/usr/bin/env node
//
// Creates and manages the intake-portal accounts for the volunteers collecting
// the first-year batch.
//
//   node scripts/seed-intake-users.js add "Aarpan Lohora" "Vikas Sharma"
//   node scripts/seed-intake-users.js add --file volunteers.txt
//   node scripts/seed-intake-users.js list
//   node scripts/seed-intake-users.js reset aarpan
//   node scripts/seed-intake-users.js disable aarpan
//   node scripts/seed-intake-users.js enable aarpan
//
// Passwords are printed once, at creation, and only the bcrypt hash is stored.
// There is deliberately no way to read one back - a lost password is reissued
// with `reset`, not recovered.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {
    // server.js has its own fallback loader; for a CLI, a clear error is enough.
}

const bcrypt = require('bcryptjs');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { INTAKE_USERS_COLLECTION, FIRST_YEAR_COLLECTION } = require('./first-year-intake');

// No 0/O or 1/l/I: these get read aloud and typed on a phone keyboard, and a
// password nobody can transcribe is a support ticket waiting to happen.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
const PASSWORD_LENGTH = 12;

function generatePassword() {
    let out = '';
    for (let i = 0; i < PASSWORD_LENGTH; i++) {
        out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
    }
    return out;
}

function usernameFor(name) {
    const base = String(name)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z\s]/g, '')
        .trim()
        .split(/\s+/)[0];
    return base || 'volunteer';
}

function connect() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKey) {
        console.error('Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY in .env');
        process.exit(1);
    }

    if (getApps().length === 0) {
        initializeApp({
            credential: cert({ projectId, clientEmail, privateKey: privateKey.replaceAll('\\n', '\n') })
        });
    }
    return getFirestore();
}

async function add(db, names) {
    if (names.length === 0) {
        console.error('Give at least one name, or --file <path> with one name per line.');
        process.exit(1);
    }

    const created = [];

    for (const name of names) {
        let username = usernameFor(name);

        // Two volunteers called Aryan both want "aryan"; the second becomes
        // aryan2 rather than quietly taking over the first one's account.
        let suffix = 1;
        while ((await db.collection(INTAKE_USERS_COLLECTION).doc(username).get()).exists) {
            suffix += 1;
            username = `${usernameFor(name)}${suffix}`;
        }

        const password = generatePassword();
        await db.collection(INTAKE_USERS_COLLECTION).doc(username).set({
            username,
            name: name.trim(),
            password_hash: await bcrypt.hash(password, 10),
            must_reset: true,
            active: true,
            createdAt: new Date().toISOString()
        });

        created.push({ name: name.trim(), username, password });
    }

    console.log('\nCreated ' + created.length + ' account(s). Copy these now - they are not stored anywhere.\n');
    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad('NAME', 30) + pad('USERNAME', 18) + 'TEMP PASSWORD');
    console.log('-'.repeat(64));
    created.forEach(c => console.log(pad(c.name, 30) + pad(c.username, 18) + c.password));
    console.log('\nEach volunteer is asked to set their own password on first sign-in.');
    console.log('Portal: /intake\n');
}

async function list(db) {
    const [users, students] = await Promise.all([
        db.collection(INTAKE_USERS_COLLECTION).get(),
        db.collection(FIRST_YEAR_COLLECTION).get()
    ]);

    const counts = {};
    students.forEach(doc => {
        const by = doc.data()?.added_by;
        if (by) counts[by] = (counts[by] || 0) + 1;
    });

    if (users.empty) return console.log('No intake accounts yet. Create some with `add`.');

    const rows = [];
    users.forEach(doc => {
        const u = doc.data() || {};
        rows.push({
            username: doc.id,
            name: u.name || '',
            state: u.active === false ? 'disabled' : (u.must_reset ? 'temp password' : 'active'),
            added: counts[doc.id] || 0,
            lastLogin: u.lastLoginAt ? u.lastLoginAt.slice(0, 16).replace('T', ' ') : 'never'
        });
    });
    rows.sort((a, b) => b.added - a.added || a.username.localeCompare(b.username));

    const pad = (s, n) => String(s).padEnd(n);
    console.log('\n' + pad('USERNAME', 18) + pad('NAME', 28) + pad('STATE', 15) + pad('ADDED', 7) + 'LAST LOGIN');
    console.log('-'.repeat(85));
    rows.forEach(r => console.log(pad(r.username, 18) + pad(r.name, 28) + pad(r.state, 15) + pad(r.added, 7) + r.lastLogin));
    console.log('\n' + students.size + ' first-year record(s) in ' + FIRST_YEAR_COLLECTION + '\n');
}

async function reset(db, username) {
    const ref = db.collection(INTAKE_USERS_COLLECTION).doc(username);
    if (!(await ref.get()).exists) {
        console.error(`No account called "${username}". Run \`list\` to see them.`);
        process.exit(1);
    }

    const password = generatePassword();
    await ref.set({
        password_hash: await bcrypt.hash(password, 10),
        must_reset: true
    }, { merge: true });

    console.log(`\nNew temporary password for ${username}:  ${password}`);
    console.log('They will be asked to change it on the next sign-in.\n');
}

async function setActive(db, username, active) {
    const ref = db.collection(INTAKE_USERS_COLLECTION).doc(username);
    if (!(await ref.get()).exists) {
        console.error(`No account called "${username}".`);
        process.exit(1);
    }

    await ref.set({ active }, { merge: true });
    // requireIntake re-reads this on every request, so it takes effect at once
    // rather than when their token happens to expire.
    console.log(`${username} is now ${active ? 'active' : 'disabled'}.`);
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const db = connect();

    switch (command) {
        case 'add': {
            const fileFlag = rest.indexOf('--file');
            const names = fileFlag === -1
                ? rest
                : fs.readFileSync(rest[fileFlag + 1], 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            return add(db, names);
        }
        case 'list':
            return list(db);
        case 'reset':
            return reset(db, String(rest[0] || '').toLowerCase());
        case 'disable':
            return setActive(db, String(rest[0] || '').toLowerCase(), false);
        case 'enable':
            return setActive(db, String(rest[0] || '').toLowerCase(), true);
        default:
            console.log(fs.readFileSync(__filename, 'utf8')
                .split('\n')
                .slice(1)
                .filter((line, i, all) => all.slice(0, i + 1).every(l => l.startsWith('//')))
                .map(l => l.replace(/^\/\/ ?/, ''))
                .join('\n'));
    }
}

main().catch(e => {
    console.error(e.message || e);
    process.exit(1);
});
