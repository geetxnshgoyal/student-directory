'use strict';

// The yearbook shares the carpool's session outright - same keys, same token -
// so a student signed in on one page is already signed in on the other.
const CP_KEYS = ['cp_token', 'cp_usn', 'cp_email', 'cp_name', 'cp_photo', 'cp_req_id', 'cp_req_time'];

const state = {
    token: localStorage.getItem('cp_token') || null,
    name: localStorage.getItem('cp_name') || '',
    usnForOtp: '',
    me: null,
    students: [],
    limits: { quote: 160, about: 600, note: 500 },
    photoChunk: 30
};

const $ = (id) => document.getElementById(id);

const authView = $('auth-view');
const bookView = $('book-view');
const wallGrid = $('wall-grid');
const panel = $('panel');
const panelBody = $('panel-body');

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function initialOf(name) {
    return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}

function showView(view) {
    authView.classList.toggle('active', view === 'auth');
    bookView.classList.toggle('active', view === 'book');
}

function setStatus(el, message, kind = '') {
    el.textContent = message;
    el.className = `status-msg ${kind}`;
}

async function api(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
            ...(options.headers || {})
        }
    });

    let data = {};
    try {
        data = await res.json();
    } catch {
        // A proxy error page or an empty body. The status still tells us enough.
    }

    if (res.status === 401) {
        signOutLocally();
        throw new Error('Your session expired. Sign in again.');
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
}

/* ============ Sign in ============ */

$('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const usn = $('usn-input').value.trim();
    const status = $('login-status');

    if (!/^\d{10}$/.test(usn)) {
        return setStatus(status, 'That should be 10 digits.', 'error');
    }

    setStatus(status, 'Sending your code...');
    try {
        const data = await api('/api/carpool/request-otp', {
            method: 'POST',
            body: JSON.stringify({ usn })
        });
        state.usnForOtp = usn;
        $('email-hint').textContent = data.emailHint || 'your college email';
        $('login-form').classList.remove('active');
        $('otp-form').classList.add('active');
        $('otp-input').focus();
        setStatus(status, '');
    } catch (err) {
        setStatus(status, err.message, 'error');
    }
});

$('back-to-login').addEventListener('click', () => {
    $('otp-form').classList.remove('active');
    $('login-form').classList.add('active');
    setStatus($('otp-status'), '');
});

$('otp-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const otp = $('otp-input').value.trim();
    const status = $('otp-status');

    if (!/^\d{6}$/.test(otp)) {
        return setStatus(status, 'That should be 6 digits.', 'error');
    }

    setStatus(status, 'Checking...');
    try {
        const data = await api('/api/carpool/verify-otp', {
            method: 'POST',
            body: JSON.stringify({ usn: state.usnForOtp, otp })
        });

        state.token = data.token;
        state.name = data.name || '';
        localStorage.setItem('cp_token', data.token);
        localStorage.setItem('cp_usn', state.usnForOtp);
        localStorage.setItem('cp_email', data.email || '');
        localStorage.setItem('cp_name', state.name);
        localStorage.setItem('cp_photo', data.photo || '');

        setStatus(status, '');
        showView('book');
        await loadOverview();
    } catch (err) {
        setStatus(status, err.message, 'error');
    }
});

function signOutLocally() {
    state.token = null;
    for (const key of CP_KEYS) localStorage.removeItem(key);
    closePanel();
    showView('auth');
}

$('signout-btn').addEventListener('click', async () => {
    try {
        await api('/api/carpool/logout', { method: 'POST' });
    } catch {
        // Already gone server-side, or offline. Either way, drop it locally.
    }
    signOutLocally();
});

/* ============ Portraits ============ */
//
// Portraits arrive in batches as cards scroll into view. /api sets no-store, so
// the browser will not keep them; this map is the cache, and it means scrolling
// back up costs nothing.

const photoCache = new Map();
const photoQueue = new Set();
let photoTimer = null;

const photoObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.dataset.photoId;
        photoObserver.unobserve(entry.target);
        if (!id) continue;
        if (photoCache.has(id)) {
            paintPhoto(id);
            continue;
        }
        photoQueue.add(id);
    }
    if (photoQueue.size) schedulePhotoFetch();
}, { rootMargin: '400px 0px' });

function schedulePhotoFetch() {
    if (photoTimer) return;
    // A short debounce so a fast scroll past forty cards becomes two requests
    // rather than forty.
    photoTimer = setTimeout(flushPhotoQueue, 80);
}

async function flushPhotoQueue() {
    photoTimer = null;
    if (!photoQueue.size) return;

    const batch = [...photoQueue].slice(0, state.photoChunk);
    for (const id of batch) photoQueue.delete(id);

    try {
        const data = await api(`/api/yearbook/photos?ids=${encodeURIComponent(batch.join(','))}`);
        for (const id of batch) {
            // Remember the misses too, as an empty string, so a student with no
            // portrait is not asked for again on every scroll.
            photoCache.set(id, data.photos?.[id] || '');
            paintPhoto(id);
        }
    } catch (err) {
        // A failed chunk leaves the initial showing, which is a real fallback
        // rather than a broken image. Put the ids back for the next pass.
        console.error('Portrait fetch failed:', err);
        for (const id of batch) photoQueue.add(id);
    }

    if (photoQueue.size) schedulePhotoFetch();
}

function paintPhoto(id) {
    const src = photoCache.get(id);
    if (!src) return;
    for (const img of document.querySelectorAll(`img[data-photo-id="${CSS.escape(id)}"]`)) {
        if (img.src === src) continue;
        img.src = src;
        img.hidden = false;
        img.classList.add('loaded');
        const initial = img.parentElement?.querySelector('.portrait-initial');
        if (initial) initial.hidden = true;
    }
}

// For the one portrait a panel needs, when the grid has not reached it yet.
async function ensurePhoto(id) {
    if (photoCache.has(id)) return paintPhoto(id);
    try {
        const data = await api(`/api/yearbook/photos?ids=${encodeURIComponent(id)}`);
        photoCache.set(id, data.photos?.[id] || '');
        paintPhoto(id);
    } catch (err) {
        console.error('Portrait fetch failed:', err);
    }
}

/* ============ The wall ============ */

async function loadOverview() {
    wallGrid.setAttribute('aria-busy', 'true');
    try {
        const data = await api('/api/yearbook/overview');
        state.me = data.me;
        state.students = data.students || [];
        state.limits = data.limits || state.limits;
        state.photoChunk = data.photoChunk || state.photoChunk;

        renderMine();
        buildBatchFilter();
        renderWall();
    } catch (err) {
        wallGrid.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    } finally {
        wallGrid.setAttribute('aria-busy', 'false');
    }
}

function renderMine() {
    const me = state.me || {};
    $('mine-heading').textContent = me.name || state.name || 'You';
    $('me-initial').textContent = initialOf(me.name || state.name);

    const quote = $('me-quote');
    if (me.quote) {
        quote.textContent = me.quote;
        quote.classList.remove('quiet');
    } else {
        quote.textContent = "You haven't written your line yet.";
        quote.classList.add('quiet');
    }

    const photo = $('me-photo');
    photo.dataset.photoId = me.id || '';
    if (me.id) ensurePhoto(me.id);

    const badge = $('pending-badge');
    badge.textContent = String(me.pending || 0);
    badge.hidden = !me.pending;
}

function buildBatchFilter() {
    const select = $('batch-filter');
    const batches = [...new Set(state.students.map(s => s.batch).filter(Boolean))].sort();
    const current = select.value;
    select.innerHTML = '<option value="">All batches</option>'
        + batches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    select.value = current;
}

function visibleStudents() {
    const term = $('search-input').value.trim().toLowerCase();
    const batch = $('batch-filter').value;
    return state.students.filter(student => {
        if (batch && student.batch !== batch) return false;
        if (term && !String(student.name).toLowerCase().includes(term)) return false;
        return true;
    });
}

function renderWall() {
    const students = visibleStudents();

    $('count-label').textContent = students.length === state.students.length
        ? `${state.students.length} students`
        : `${students.length} of ${state.students.length}`;

    $('wall-empty').hidden = students.length > 0;

    photoObserver.disconnect();
    wallGrid.innerHTML = students.map(cardMarkup).join('');

    for (const plate of wallGrid.querySelectorAll('.card-plate')) photoObserver.observe(plate);
    // Anything already fetched paints straight away; the observer only has to
    // deal with what is genuinely new.
    for (const student of students) if (photoCache.has(student.id)) paintPhoto(student.id);
}

function cardMarkup(student) {
    const notes = student.notes
        ? `<span class="card-notes">${student.notes} note${student.notes === 1 ? '' : 's'}</span>`
        : '<span class="card-notes quiet">unsigned</span>';

    return `
        <button type="button" class="card${student.isYou ? ' is-you' : ''}" data-id="${escapeHtml(student.id)}">
            <div class="card-plate" data-photo-id="${escapeHtml(student.id)}">
                <span class="portrait-initial" aria-hidden="true">${escapeHtml(initialOf(student.name))}</span>
                <img data-photo-id="${escapeHtml(student.id)}" alt="" loading="lazy" hidden>
            </div>
            <div class="card-body">
                <div class="card-name">${escapeHtml(student.name)}</div>
                ${student.quote ? `<div class="card-quote">${escapeHtml(student.quote)}</div>` : ''}
                <div class="card-foot">
                    <span class="card-batch">${escapeHtml(student.batch || '')}</span>
                    ${student.isYou ? '<span class="tag-you">You</span>' : notes}
                </div>
            </div>
        </button>`;
}

wallGrid.addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (card) openProfile(card.dataset.id);
});

$('search-input').addEventListener('input', renderWall);
$('batch-filter').addEventListener('change', renderWall);

/* ============ Panel ============ */

function openPanel(html) {
    panelBody.innerHTML = html;
    panel.hidden = false;
    document.body.style.overflow = 'hidden';
    $('panel-close').focus();
}

function closePanel() {
    panel.hidden = true;
    panelBody.innerHTML = '';
    document.body.style.overflow = '';
}

$('panel-close').addEventListener('click', closePanel);
panel.addEventListener('click', (event) => {
    if (event.target === panel) closePanel();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) closePanel();
});

/* ============ A student's page ============ */

async function openProfile(id) {
    if (!id) return;
    openPanel('<p class="empty">Opening...</p>');

    try {
        const data = await api(`/api/yearbook/students/${encodeURIComponent(id)}`);
        panelBody.innerHTML = profileMarkup(data);
        ensurePhoto(id);
        wireProfile(id, data);
    } catch (err) {
        panelBody.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    }
}

function profileMarkup(data) {
    const s = data.student;
    const notes = (data.notes || []).map(noteMarkup).join('');

    return `
        <div class="profile-head">
            <div class="profile-portrait">
                <span class="portrait-initial" aria-hidden="true">${escapeHtml(initialOf(s.name))}</span>
                <img data-photo-id="${escapeHtml(s.id)}" alt="" hidden>
            </div>
            <div>
                <h2 class="profile-name" id="panel-title">${escapeHtml(s.name)}</h2>
                <div class="profile-meta">${escapeHtml(s.batch || 'NST Bangalore')}</div>
            </div>
        </div>

        ${s.quote ? `<p class="profile-quote">${escapeHtml(s.quote)}</p>` : ''}
        ${s.about ? `<p class="profile-about">${escapeHtml(s.about)}</p>` : ''}
        ${!s.quote && !s.about ? '<p class="empty" style="padding:14px 0 22px">They haven\'t written their page yet.</p>' : ''}

        <hr class="rule">

        <div class="sub-head">
            <h3 class="sub-title">Signed by</h3>
            <span class="count mono">${(data.notes || []).filter(n => n.approved).length}</span>
        </div>
        ${notes || '<p class="empty" style="padding:8px 0 18px">Nobody has signed this page yet.</p>'}

        ${s.isYou ? '' : composerMarkup(data.myNote)}`;
}

function noteMarkup(note) {
    const pending = !note.approved;
    return `
        <div class="note${pending ? ' pending' : ''}">
            <div class="note-text">${escapeHtml(note.text)}</div>
            <div class="note-sign">
                <span class="note-from">&mdash; ${escapeHtml(note.from)}</span>
                ${pending ? '<span class="note-flag">Waiting for them</span>' : ''}
            </div>
        </div>`;
}

function composerMarkup(myNote) {
    const existing = myNote?.text || '';
    return `
        <hr class="rule">
        <div class="sub-head">
            <h3 class="sub-title">${existing ? 'Your note' : 'Sign their page'}</h3>
            <span class="char-count" id="note-count">0/${state.limits.note}</span>
        </div>
        ${existing && !myNote.approved
            ? '<p class="hint" style="margin-bottom:10px">Waiting for them to put it up. Only the two of you can see it.</p>'
            : ''}
        <textarea id="note-text" maxlength="${state.limits.note}"
            placeholder="Something you'll both want to read in ten years."></textarea>
        <div class="form-actions">
            <button type="button" id="note-save" class="btn btn-primary btn-sm">${existing ? 'Update note' : 'Sign it'}</button>
            ${existing ? '<button type="button" id="note-delete" class="btn btn-danger btn-sm">Delete</button>' : ''}
            <span class="status-msg" id="note-status"></span>
        </div>
        <p class="hint">Notes are signed with your name and only appear on their page once they put it up. Editing one sends it back for approval.</p>`;
}

function wireProfile(id, data) {
    const box = $('note-text');
    if (!box) return;

    const count = $('note-count');
    const status = $('note-status');
    box.value = data.myNote?.text || '';

    const updateCount = () => {
        count.textContent = `${box.value.length}/${state.limits.note}`;
        count.classList.toggle('over', box.value.length >= state.limits.note);
    };
    box.addEventListener('input', updateCount);
    updateCount();

    $('note-save').addEventListener('click', async () => {
        if (!box.value.trim()) return setStatus(status, 'Write something first.', 'error');
        setStatus(status, 'Saving...');
        try {
            await api(`/api/yearbook/students/${encodeURIComponent(id)}/note`, {
                method: 'PUT',
                body: JSON.stringify({ text: box.value })
            });
            setStatus(status, 'Sent. They decide when it goes up.', 'ok');
            await openProfile(id);
        } catch (err) {
            setStatus(status, err.message, 'error');
        }
    });

    $('note-delete')?.addEventListener('click', async () => {
        setStatus(status, 'Removing...');
        try {
            await api(`/api/yearbook/students/${encodeURIComponent(id)}/note`, { method: 'DELETE' });
            await openProfile(id);
        } catch (err) {
            setStatus(status, err.message, 'error');
        }
    });
}

/* ============ Your own entry ============ */

$('edit-me-btn').addEventListener('click', () => {
    const me = state.me || {};
    openPanel(`
        <h2 class="profile-name" id="panel-title" style="padding-right:30px">Your page</h2>
        <p class="hint" style="margin-bottom:18px">This is what the rest of the batch sees.</p>

        <div class="field">
            <label for="quote-input">Your line
                <span class="char-count" id="quote-count"></span>
            </label>
            <input type="text" id="quote-input" maxlength="${state.limits.quote}"
                placeholder="One sentence that sounds like you.">
        </div>

        <div class="field">
            <label for="about-input">A bit more
                <span class="char-count" id="about-count"></span>
            </label>
            <textarea id="about-input" maxlength="${state.limits.about}"
                placeholder="Optional. What you got up to, what you'll miss, where you're headed."></textarea>
        </div>

        <div class="check-row">
            <input type="checkbox" id="hidden-input">
            <label for="hidden-input">Keep me off the yearbook. Your card disappears from the wall and nobody can open
                or sign your page.</label>
        </div>

        <div class="form-actions">
            <button type="button" id="me-save" class="btn btn-primary btn-sm">Save</button>
            <span class="status-msg" id="me-status"></span>
        </div>`);

    const quote = $('quote-input');
    const about = $('about-input');
    const hidden = $('hidden-input');
    const status = $('me-status');

    quote.value = me.quote || '';
    about.value = me.about || '';
    hidden.checked = Boolean(me.hidden);

    const counter = (input, label, max) => {
        const update = () => { label.textContent = `${input.value.length}/${max}`; };
        input.addEventListener('input', update);
        update();
    };
    counter(quote, $('quote-count'), state.limits.quote);
    counter(about, $('about-count'), state.limits.about);

    $('me-save').addEventListener('click', async () => {
        setStatus(status, 'Saving...');
        try {
            await api('/api/yearbook/me', {
                method: 'PUT',
                body: JSON.stringify({ quote: quote.value, about: about.value, hidden: hidden.checked })
            });
            setStatus(status, 'Saved.', 'ok');
            await loadOverview();
            closePanel();
        } catch (err) {
            setStatus(status, err.message, 'error');
        }
    });
});

/* ============ Notes left for you ============ */

$('review-btn').addEventListener('click', openReview);

async function openReview() {
    if (!state.me?.id) return;
    openPanel('<p class="empty">Loading...</p>');

    try {
        const data = await api(`/api/yearbook/students/${encodeURIComponent(state.me.id)}`);
        const notes = data.notes || [];
        const pending = notes.filter(note => !note.approved);
        const up = notes.filter(note => note.approved);

        panelBody.innerHTML = `
            <h2 class="profile-name" id="panel-title" style="padding-right:30px">Notes for you</h2>
            <p class="hint" style="margin-bottom:20px">Nothing here is visible to anyone else until you put it up. You
                can take one down again at any time, or delete it outright.</p>

            <div class="sub-head">
                <h3 class="sub-title">Waiting</h3>
                <span class="count mono">${pending.length}</span>
            </div>
            ${pending.map(reviewNoteMarkup).join('') || '<p class="empty" style="padding:8px 0 14px">Nothing waiting.</p>'}

            <hr class="rule">
            <div class="sub-head">
                <h3 class="sub-title">On your page</h3>
                <span class="count mono">${up.length}</span>
            </div>
            ${up.map(reviewNoteMarkup).join('') || '<p class="empty" style="padding:8px 0">Nothing up yet.</p>'}`;

        panelBody.querySelectorAll('[data-approve]').forEach(btn => {
            btn.addEventListener('click', () => actOnNote(
                `/api/yearbook/notes/${encodeURIComponent(btn.dataset.author)}/approve`,
                { method: 'POST', body: JSON.stringify({ approved: btn.dataset.approve === 'true' }) }
            ));
        });
        panelBody.querySelectorAll('[data-remove]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!confirm('Delete this note? It cannot be brought back.')) return;
                actOnNote(`/api/yearbook/notes/${encodeURIComponent(btn.dataset.remove)}`, { method: 'DELETE' });
            });
        });
    } catch (err) {
        panelBody.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    }
}

function reviewNoteMarkup(note) {
    return `
        <div class="note${note.approved ? '' : ' pending'}">
            <div class="note-text">${escapeHtml(note.text)}</div>
            <div class="note-sign">
                <span class="note-from">&mdash; ${escapeHtml(note.from)}</span>
                <span class="note-actions">
                    <button type="button" class="btn btn-ghost btn-sm" data-approve="${note.approved ? 'false' : 'true'}"
                        data-author="${escapeHtml(note.authorId)}">${note.approved ? 'Take down' : 'Put it up'}</button>
                    <button type="button" class="btn btn-danger btn-sm" data-remove="${escapeHtml(note.authorId)}">Delete</button>
                </span>
            </div>
        </div>`;
}

async function actOnNote(path, options) {
    try {
        await api(path, options);
        await loadOverview();
        await openReview();
    } catch (err) {
        panelBody.insertAdjacentHTML('afterbegin',
            `<p class="status-msg error">${escapeHtml(err.message)}</p>`);
    }
}

/* ============ Theme ============ */

document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try {
            localStorage.setItem('cp_theme', next);
        } catch {
            // Private mode. The theme still applies for this visit.
        }
    });
});

/* ============ Boot ============ */

if (state.token) {
    showView('book');
    loadOverview();
} else {
    showView('auth');
}
