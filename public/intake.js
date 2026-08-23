// First-year intake portal.
//
// Runs on a volunteer's phone: sign in, photograph a student, type what they
// can get out of them, save. Everything is scoped to the batch-2030 collection
// and the volunteer's own entries; the existing directory is not reachable from
// here at all.

const TOKEN_KEY = 'intakeToken';

// Must match MAX_PHOTO_BYTES / MAX_THUMB_BYTES in scripts/first-year-intake.js.
// The ladder below is walked against these, so a capture that reaches the
// server has already been proven to fit.
const MAX_PHOTO_BYTES = 580 * 1024;
const MAX_THUMB_BYTES = 60 * 1024;

// Best quality first. Only if a photo genuinely will not fit does this give up
// resolution, and even the last rung is a respectable 720px portrait.
const QUALITY_LADDER = [
    { size: 1440, quality: 0.94 },
    { size: 1440, quality: 0.90 },
    { size: 1280, quality: 0.90 },
    { size: 1280, quality: 0.85 },
    { size: 1080, quality: 0.85 },
    { size: 900, quality: 0.82 },
    { size: 720, quality: 0.80 }
];

const THUMB_SIZE = 160;
const THUMB_QUALITY = 0.85;

const el = (id) => document.getElementById(id);

const loginSection = el('login-section');
const resetSection = el('reset-section');
const appSection = el('app-section');
const studentForm = el('student-form');
const mineGrid = el('mine-grid');
const video = el('camera-preview');
const photoPreview = el('photo-preview');
const photoPlaceholder = el('capture-placeholder');
const photoBadge = el('photo-badge');
const canvas = el('capture-canvas');

let stream = null;
let facingMode = 'environment';
let capture = null;      // { photo, photo_thumb, label }
let editingUsn = null;

// ===== helpers =====

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Same arithmetic the server uses, so the ladder and the limit agree.
const dataUriBytes = (uri) => Math.floor((uri.length - uri.indexOf(',') - 1) * 3 / 4);

const readableSize = (bytes) => `${Math.round(bytes / 1024)} KB`;

function message(boxId, text, isError = false) {
    const box = el(boxId);
    if (!box) return;
    if (!text) return box.classList.add('hidden');

    box.querySelector('span').textContent = text;
    box.classList.remove('hidden');
    box.style.background = isError ? 'var(--error-light)' : 'var(--success-light)';
    box.style.color = isError ? 'var(--error)' : 'var(--success)';
}

const token = () => localStorage.getItem(TOKEN_KEY);

async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token() ? { Authorization: `Bearer ${token()}` } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
    });

    let data = {};
    try {
        data = await res.json();
    } catch {
        // A proxy timeout or a 502 arrives as HTML; treat it as a plain failure.
    }

    if (res.status === 401 || res.status === 403) {
        signOut();
        throw new Error(data.error || 'Session expired. Sign in again.');
    }

    // 428 is the server saying the temporary password still has to be changed.
    if (res.status === 428) {
        showReset();
        throw new Error(data.error || 'Set a new password to continue');
    }

    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
}

function show(section) {
    for (const s of [loginSection, resetSection, appSection]) s.classList.add('hidden');
    section.classList.remove('hidden');
}

const showReset = () => show(resetSection);

function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    stopCamera();
    show(loginSection);
}

// ===== auth =====

el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = el('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    message('login-message', '');

    try {
        const data = await api('/api/intake/login', {
            method: 'POST',
            body: {
                username: el('intake-username').value.trim(),
                password: el('intake-password').value
            }
        });

        localStorage.setItem(TOKEN_KEY, data.token);
        el('intake-password').value = '';

        if (data.mustReset) {
            showReset();
        } else {
            await startApp(data.name);
        }
    } catch (err) {
        message('login-message', err.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign in';
    }
});

el('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = el('reset-new').value;

    if (next !== el('reset-confirm').value) {
        return message('reset-message', 'The two new passwords do not match', true);
    }

    const btn = el('reset-btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    message('reset-message', '');

    try {
        const data = await api('/api/intake/change-password', {
            method: 'POST',
            body: { currentPassword: el('reset-current').value, newPassword: next }
        });

        localStorage.setItem(TOKEN_KEY, data.token);
        el('reset-form').reset();
        await startApp();
    } catch (err) {
        message('reset-message', err.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save password';
    }
});

el('intake-logout').addEventListener('click', signOut);

async function startApp(name) {
    show(appSection);

    if (!name) {
        try {
            const session = await api('/api/intake/session');
            if (session.mustReset) return showReset();
            name = session.name;
        } catch {
            return;
        }
    }

    el('whoami').textContent = name;
    loadMine();
}

// ===== tabs =====

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => {
            const active = b === btn;
            b.classList.toggle('active', active);
            b.setAttribute('aria-selected', String(active));
        });
        el('tab-add').classList.toggle('hidden', btn.dataset.tab !== 'add');
        el('tab-mine').classList.toggle('hidden', btn.dataset.tab !== 'mine');

        // The camera keeps the torch and the sensor busy, so it is released the
        // moment the form is not on screen.
        if (btn.dataset.tab !== 'add') stopCamera();
        if (btn.dataset.tab === 'mine') loadMine();
    });
});

// ===== camera =====

function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
    video.srcObject = null;
    video.classList.add('hidden');
    el('camera-shoot').classList.add('hidden');
    el('camera-flip').classList.add('hidden');
    el('camera-start').classList.remove('hidden');
}

async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
        return message('form-message', 'This browser cannot open a camera. Use Chrome or Safari on a phone.', true);
    }

    stopCamera();

    try {
        // Asks for far more resolution than is kept: the extra pixels are what
        // make the downscale sharp rather than soft.
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode,
                width: { ideal: 2560 },
                height: { ideal: 2560 }
            },
            audio: false
        });
    } catch (err) {
        const reason = err?.name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow it in your browser settings and try again.'
            : 'Could not open the camera. Check nothing else is using it.';
        return message('form-message', reason, true);
    }

    video.srcObject = stream;
    video.classList.toggle('is-front', facingMode === 'user');
    video.classList.remove('hidden');
    photoPreview.classList.add('hidden');
    photoPlaceholder.classList.add('hidden');

    el('camera-start').classList.add('hidden');
    el('camera-shoot').classList.remove('hidden');
    el('camera-flip').classList.remove('hidden');
    el('camera-retake').classList.add('hidden');
    message('form-message', '');
}

// Draws the largest centred square the sensor gives us, then re-encodes down
// the ladder until the result fits the storage budget.
function captureFromVideo() {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;

    const side = Math.min(w, h);
    const sx = (w - side) / 2;
    const sy = (h - side) / 2;

    for (const rung of QUALITY_LADDER) {
        const size = Math.min(rung.size, side);
        canvas.width = size;
        canvas.height = size;

        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);

        const photo = canvas.toDataURL('image/jpeg', rung.quality);
        const bytes = dataUriBytes(photo);
        if (bytes > MAX_PHOTO_BYTES) continue;

        // The thumbnail comes off the already-downscaled canvas, so the grid
        // never has to carry the full capture.
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = THUMB_SIZE;
        thumbCanvas.height = THUMB_SIZE;
        const thumbCtx = thumbCanvas.getContext('2d');
        thumbCtx.imageSmoothingEnabled = true;
        thumbCtx.imageSmoothingQuality = 'high';
        thumbCtx.drawImage(canvas, 0, 0, THUMB_SIZE, THUMB_SIZE);

        const photo_thumb = thumbCanvas.toDataURL('image/jpeg', THUMB_QUALITY);
        if (dataUriBytes(photo_thumb) > MAX_THUMB_BYTES) continue;

        return { photo, photo_thumb, label: `${size}px · ${readableSize(bytes)}` };
    }

    return null;
}

el('camera-start').addEventListener('click', startCamera);

el('camera-flip').addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    startCamera();
});

el('camera-shoot').addEventListener('click', () => {
    const shot = captureFromVideo();
    if (!shot) {
        return message('form-message', 'The camera was not ready. Give it a second and try again.', true);
    }

    capture = shot;
    photoPreview.src = shot.photo;
    photoPreview.classList.remove('hidden');
    photoBadge.textContent = shot.label;
    photoBadge.classList.remove('hidden');

    stopCamera();
    el('camera-start').classList.add('hidden');
    el('camera-retake').classList.remove('hidden');
    message('form-message', '');
});

el('camera-retake').addEventListener('click', () => {
    capture = null;
    photoPreview.classList.add('hidden');
    photoBadge.classList.add('hidden');
    el('camera-retake').classList.add('hidden');
    startCamera();
});

// ===== form =====

function readForm() {
    return {
        usn: el('f-usn').value.trim(),
        name: el('f-name').value.trim(),
        gender: el('f-gender').value,
        birthday: el('f-birthday').value,
        blood_group: el('f-blood').value,
        mobile_number: el('f-mobile').value.trim(),
        email: el('f-email').value.trim(),
        institutional_email: el('f-inst-email').value.trim(),
        github: el('f-github').value.trim(),
        linkedin: el('f-linkedin').value.trim(),
        // Only meaningful when the name matched more than one student; the
        // server ignores it otherwise and derives the batch itself.
        section: el('f-section').value
    };
}

// ===== batch, from the official list =====

// The batch is never typed in. It is looked up from the published roster by
// name, because names are the only key that list gives us. This is a preview:
// the server runs the same lookup again when the record is saved, so a stale
// or tampered form cannot decide anybody's batch.
let batchTimer = null;

function clearBatch(text) {
    el('f-batch').value = text;
    el('batch-hint').textContent = 'Filled in from the official list as you type the name.';
    el('f-section').classList.add('hidden');
    el('f-section').innerHTML = '<option value="">Which one?</option>';
}

function applyBatch(result) {
    const picker = el('f-section');

    // Three students are called Shivam Kumar and they are in three different
    // batches. No amount of matching fixes that, so the volunteer is asked.
    if (result.status === 'ambiguous') {
        el('f-batch').value = 'Pick one below';
        el('batch-hint').textContent =
            result.candidates.length + ' students on the list share that name, in different batches.';
        picker.innerHTML = '<option value="">Which one?</option>' + result.candidates
            .map((c) => '<option value="' + c.label + '">' + c.name + ' — ' + c.label + '</option>')
            .join('');
        picker.classList.remove('hidden');
        return;
    }

    picker.classList.add('hidden');
    picker.innerHTML = '<option value="">Which one?</option>';

    // Not being on the list is not a reason to lose the photo and the blood
    // group. It saves without a batch and someone sorts it out later.
    if (result.status === 'none') {
        el('f-batch').value = 'Not on the list';
        el('batch-hint').textContent = 'This name is not on the official list. The record still saves without a batch.';
        return;
    }

    el('f-batch').value = result.label;
    el('batch-hint').textContent = result.status === 'exact'
        ? 'Matched ' + result.matched[0] + '.'
        : 'Closest match is ' + result.matched[0] + '. Check that is the right student.';
}

async function lookupBatchFor(name) {
    if (!name.trim()) return clearBatch('Enter a name first');
    try {
        applyBatch(await api('/api/intake/batch-lookup?name=' + encodeURIComponent(name)));
    } catch {
        // A failed preview is not worth blocking on - the save resolves the
        // batch server-side regardless of what this field is showing.
        clearBatch('Checked on save');
    }
}

el('f-name').addEventListener('input', () => {
    clearTimeout(batchTimer);
    batchTimer = setTimeout(() => lookupBatchFor(el('f-name').value), 250);
});

function resetForm() {
    studentForm.reset();
    el('f-batch').value = 'Enter a name first';
    el('batch-hint').textContent = 'Filled in from the official list as you type the name.';
    el('f-section').classList.add('hidden');
    el('f-section').innerHTML = '<option value="">Which one?</option>';
    el('f-usn').disabled = false;
    capture = null;
    editingUsn = null;

    photoPreview.classList.add('hidden');
    photoPreview.removeAttribute('src');
    photoBadge.classList.add('hidden');
    photoPlaceholder.classList.remove('hidden');
    el('camera-retake').classList.add('hidden');
    el('camera-start').classList.remove('hidden');
    el('cancel-edit').classList.add('hidden');
    el('save-btn').textContent = 'Save student';
    stopCamera();
}

el('cancel-edit').addEventListener('click', () => {
    resetForm();
    message('form-message', '');
});

studentForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const fields = readForm();

    if (!fields.usn) return message('form-message', 'USN is required', true);
    if (!fields.name) return message('form-message', 'Name is required', true);
    if (!editingUsn && !capture) {
        return message('form-message', 'Take the student’s photo before saving', true);
    }

    // Only the fields the volunteer can realistically get on the spot are
    // required; the rest are chased later rather than blocking the queue.
    const thin = ['gender', 'birthday', 'blood_group', 'mobile_number'].filter(f => !fields[f]);
    if (thin.length && !editingUsn) {
        const ok = confirm(`Saving without: ${thin.join(', ')}.\n\nSave anyway?`);
        if (!ok) return;
    }

    const btn = el('save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    message('form-message', '');

    try {
        const payload = { ...fields };
        if (capture) {
            payload.photo = capture.photo;
            payload.photo_thumb = capture.photo_thumb;
        }

        if (editingUsn) {
            // The USN is the document key, so an edit never carries it.
            delete payload.usn;
            await api(`/api/intake/students/${encodeURIComponent(editingUsn)}`, { method: 'PATCH', body: payload });
            message('form-message', `Updated ${fields.name}`);
        } else {
            await api('/api/intake/students', { method: 'POST', body: payload });
            message('form-message', `Saved ${fields.name}. Ready for the next student.`);
        }

        resetForm();
        loadMine();
    } catch (err) {
        message('form-message', err.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = editingUsn ? 'Update student' : 'Save student';
    }
});

// ===== my entries =====

async function loadMine() {
    try {
        const data = await api('/api/intake/students');
        const students = data.students || [];
        el('mine-count').textContent = students.length;

        if (students.length === 0) {
            mineGrid.innerHTML = '<p class="empty-note">Nothing yet. Add your first student from the other tab.</p>';
            return;
        }

        mineGrid.innerHTML = students.map(s => {
            const missing = s.missing || [];
            const flags = missing.length
                ? missing.map(f => `<span class="flag">no ${esc(f.replace('_', ' ').replace('number', 'no.'))}</span>`).join('')
                : '<span class="flag ok">complete</span>';

            const avatar = s.photo_thumb
                ? `<img class="entry-photo" src="${esc(s.photo_thumb)}" alt="">`
                : `<div class="entry-photo avatar-initial">${esc((s.name || '?').charAt(0).toUpperCase())}</div>`;

            return `
                <div class="entry-card">
                    ${avatar}
                    <div class="entry-body">
                        <p class="entry-name">${esc(s.name || 'Unknown')}</p>
                        <span class="entry-usn">${esc(s.usn || '')}</span>
                        <div class="entry-flags">${flags}</div>
                    </div>
                    <button type="button" class="action-btn secondary entry-edit"
                            data-edit="${esc(s.usn || '')}">Edit</button>
                </div>`;
        }).join('');
    } catch (err) {
        mineGrid.innerHTML = `<p class="empty-note">${esc(err.message)}</p>`;
    }
}

el('mine-refresh').addEventListener('click', loadMine);

mineGrid.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-edit]');
    if (!btn) return;

    try {
        const { student } = await api(`/api/intake/students/${encodeURIComponent(btn.dataset.edit)}`);

        resetForm();
        editingUsn = student.usn;

        el('f-usn').value = student.usn || '';
        el('f-usn').disabled = true;      // the document key cannot move
        el('f-name').value = student.name || '';
        lookupBatchFor(student.name || '');
        el('f-gender').value = student.gender || '';
        el('f-blood').value = student.blood_group || '';
        el('f-mobile').value = student.mobile_number || '';
        el('f-email').value = student.email || '';
        el('f-inst-email').value = student.institutional_email || '';
        el('f-github').value = student.github || '';
        el('f-linkedin').value = student.linkedin || '';

        // Stored DD-MM-YYYY; the date input wants YYYY-MM-DD.
        if (student.birthday) {
            const [d, m, y] = String(student.birthday).split('-');
            if (d && m && y) el('f-birthday').value = `${y}-${m}-${d}`;
        }

        if (student.photo) {
            photoPreview.src = student.photo;
            photoPreview.classList.remove('hidden');
            photoPlaceholder.classList.add('hidden');
            photoBadge.textContent = 'saved photo';
            photoBadge.classList.remove('hidden');
            el('camera-start').classList.remove('hidden');
        }

        el('cancel-edit').classList.remove('hidden');
        el('save-btn').textContent = 'Update student';

        document.querySelector('.tab-btn[data-tab="add"]').click();
        message('form-message', `Editing ${student.name}. Retake the photo only if you need to.`);
    } catch (err) {
        message('form-message', err.message, true);
    }
});

// ===== theme =====
// Shares the cp_theme key with the carpool and admin pages, so one choice
// covers all three. The initial value is set inline in <head> to avoid a flash.
document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = next;
        try {
            localStorage.setItem('cp_theme', next);
        } catch {
            // Private browsing; the choice just won't persist.
        }
    });
});

// The camera must not stay live in a backgrounded tab.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
});

if (token()) {
    startApp();
} else {
    show(loginSection);
}
