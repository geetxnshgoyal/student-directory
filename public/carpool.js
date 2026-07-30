
const API_BASE = '/api/carpool';
const POLL_MS = 15000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const CP_KEYS = ['cp_token', 'cp_usn', 'cp_email', 'cp_name', 'cp_photo', 'cp_req_id', 'cp_req_time'];

// State
let state = {
    token: localStorage.getItem('cp_token') || null,
    usn: localStorage.getItem('cp_usn') || null,
    email: localStorage.getItem('cp_email') || null,
    name: localStorage.getItem('cp_name') || null,
    photo: localStorage.getItem('cp_photo') || null,
    direction: null,
    myRequest: null,
    screen: 'auth',
    pollTimer: null,
    resendTimer: null,
    resendSeconds: 0
};

const acceptedMatches = new Set();
let lastMatchesSignature = null;
let lastBoardSignature = null;

// DOM Elements
const views = {
    auth: document.getElementById('auth-view'),
    dashboard: document.getElementById('dashboard-view')
};

const forms = {
    login: document.getElementById('login-form'),
    otp: document.getElementById('otp-form'),
    trip: document.getElementById('create-request-form')
};

const inputs = {
    usn: document.getElementById('usn-input'),
    otp: document.getElementById('otp-input'),
    time: document.getElementById('time-input'),
    flight: document.getElementById('flight-input'),
    wait: document.getElementById('wait-input')
};

const sections = {
    home: document.getElementById('home-dashboard'),
    form: document.getElementById('trip-details-form'),
    board: document.getElementById('status-board')
};

const status = {
    login: document.getElementById('login-status'),
    otp: document.getElementById('otp-status')
};

// Utilities
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[ch]);
}

function safePhotoUrl(value) {
    const url = String(value || '').trim();
    return /^(https:\/\/|data:image\/)/i.test(url) ? url : '';
}

function setStatus(el, msg, type) {
    if (!el) return;
    el.textContent = msg || '';
    el.className = `status-msg ${type || 'neutral'}`;
}

function clearCarpoolStorage() {
    // Only touch our own keys - the student portal shares this origin, and the
    // theme choice should survive signing out.
    for (const key of CP_KEYS) localStorage.removeItem(key);
}

// Theme. The initial value is set by an inline script in <head> to avoid a flash.
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

// The form collects Bangalore wall-clock time. Pin the offset explicitly so the
// server and every other device agree on the actual instant.
function istInputToIso(value) {
    if (!value) return null;
    const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
    const parsed = new Date(`${withSeconds}+05:30`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function istInputNow() {
    return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

// Back the other way, to prefill the form when editing an existing trip.
function isoToIstInput(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

const TIME_FMT = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true };
const DATE_FMT = { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' };

function formatTime(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '--:--' : date.toLocaleTimeString('en-IN', TIME_FMT);
}

function formatDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-IN', DATE_FMT);
}

// "02:40 pm" -> "02:40" + a small-caps suffix, so mono times stay tight.
function timeHtml(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '--:--';
    const [clock, suffix] = date.toLocaleTimeString('en-IN', TIME_FMT).split(' ');
    return escapeHtml(clock) + (suffix ? `<span class="tsuffix">${escapeHtml(suffix)}</span>` : '');
}

function formatDateLong(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'long' });
}

// Keeps a generated line stable across polls instead of reshuffling every refresh.
function seededIndex(seed, length) {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 1000003;
    return hash % length;
}

async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
            ...options.headers
        }
    });

    if (res.status === 401 && state.token) {
        handleSessionExpiry();
        throw new Error('session-expired');
    }

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data || {};
}

function handleSessionExpiry() {
    stopPolling();
    clearCarpoolStorage();
    state.token = null;
    state.myRequest = null;
    showAuth();
    setStatus(status.login, 'Your session expired. Please verify again.', 'error');
}

// Navigation / View Logic
function showAuth() {
    state.screen = 'auth';
    views.auth.classList.add('active');
    views.dashboard.classList.remove('active');
    forms.login.classList.add('active');
    forms.otp.classList.remove('active');
    stopResendTimer();
}

function showDashboard() {
    views.auth.classList.remove('active');
    views.dashboard.classList.add('active');
    renderProfile();
    showSelector();
    startPolling();
}

function showSelector() {
    state.screen = 'selector';
    sections.home.classList.remove('hidden');
    sections.form.classList.add('hidden');
    sections.board.classList.add('hidden');
}

function showForm(mode = 'create') {
    state.screen = 'form';
    state.formMode = mode;
    sections.home.classList.add('hidden');
    sections.form.classList.remove('hidden');
    sections.board.classList.add('hidden');

    const isHostel = state.direction === 'hostel';
    const editing = mode === 'edit';

    document.getElementById('form-eyebrow').textContent = editing ? 'Change your trip' : 'Step 2 of 2';
    document.getElementById('form-title').textContent = isHostel ? 'Airport → Hostel' : 'Hostel → Airport';
    document.getElementById('time-label').textContent = isHostel ? 'Landing time at BLR' : 'Pickup time at campus';
    document.getElementById('trip-submit-label').textContent = editing ? 'Save changes' : 'Post my trip';
    setStatus(document.getElementById('trip-status'), '', 'neutral');
    inputs.time.min = istInputNow();

    if (editing && state.myRequest) {
        inputs.time.value = isoToIstInput(state.myRequest.time);
        inputs.flight.value = state.myRequest.flightCode || '';
        inputs.wait.value = String(state.myRequest.waitMinutes || 30);
    } else {
        inputs.time.value = '';
        inputs.flight.value = '';
        inputs.wait.value = '30';
    }
}

function showBoard() {
    state.screen = 'board';
    sections.home.classList.add('hidden');
    sections.form.classList.add('hidden');
    sections.board.classList.remove('hidden');
}

function renderProfile() {
    document.getElementById('user-usn').textContent = state.name || state.usn || 'Student';
    document.getElementById('user-email').textContent = state.email || '';

    const avatar = document.getElementById('user-avatar');
    const photo = safePhotoUrl(state.photo);
    avatar.replaceChildren();

    if (photo) {
        const img = document.createElement('img');
        img.src = photo;
        img.alt = '';
        img.className = 'avatar-img';
        img.addEventListener('error', () => {
            avatar.replaceChildren();
            avatar.textContent = initials();
        });
        avatar.appendChild(img);
    } else {
        avatar.textContent = initials();
    }
}

function initials() {
    const name = (state.name || '').trim();
    if (name) return name.slice(0, 1).toUpperCase();
    return String(state.usn || 'U').slice(-2);
}

// Auth Handlers
forms.login.addEventListener('submit', async (e) => {
    e.preventDefault();
    const usn = inputs.usn.value.trim();
    if (!usn) return;

    const btn = forms.login.querySelector('button[type="submit"]');
    btn.disabled = true;
    setStatus(status.login, 'Finding student...', 'neutral');

    try {
        const data = await api('/request-otp', {
            method: 'POST',
            body: JSON.stringify({ usn })
        });

        state.usn = usn;
        setStatus(status.login, '', 'neutral');
        document.getElementById('email-hint').textContent = data.emailHint || 'your official email';
        forms.login.classList.remove('active');
        forms.otp.classList.add('active');
        inputs.otp.value = '';
        inputs.otp.focus();
        startResendTimer();
    } catch (err) {
        setStatus(status.login, err.message || 'Could not send the code', 'error');
    } finally {
        btn.disabled = false;
    }
});

function startResendTimer() {
    stopResendTimer();
    state.resendSeconds = 30;

    const btn = document.getElementById('resend-otp-btn');
    const timerDisplay = document.getElementById('resend-timer');
    btn.disabled = true;
    timerDisplay.textContent = `(${state.resendSeconds}s)`;

    state.resendTimer = setInterval(() => {
        state.resendSeconds -= 1;
        timerDisplay.textContent = `(${state.resendSeconds}s)`;

        if (state.resendSeconds <= 0) {
            stopResendTimer();
            timerDisplay.textContent = '';
            btn.disabled = false;
        }
    }, 1000);
}

function stopResendTimer() {
    if (state.resendTimer) clearInterval(state.resendTimer);
    state.resendTimer = null;
}

document.getElementById('resend-otp-btn').addEventListener('click', async () => {
    const btn = document.getElementById('resend-otp-btn');
    btn.disabled = true;
    setStatus(status.otp, 'Resending OTP...', 'neutral');

    try {
        const data = await api('/request-otp', {
            method: 'POST',
            body: JSON.stringify({ usn: state.usn })
        });
        if (data.emailHint) document.getElementById('email-hint').textContent = data.emailHint;
        setStatus(status.otp, 'OTP resent.', 'success');
        startResendTimer();
    } catch (err) {
        setStatus(status.otp, err.message || 'Failed to resend OTP', 'error');
        btn.disabled = false;
    }
});

forms.otp.addEventListener('submit', async (e) => {
    e.preventDefault();
    const otp = inputs.otp.value.trim();
    if (!otp) return;

    const btn = forms.otp.querySelector('button[type="submit"]');
    btn.disabled = true;
    setStatus(status.otp, 'Verifying...', 'neutral');

    try {
        const data = await api('/verify-otp', {
            method: 'POST',
            body: JSON.stringify({ usn: state.usn, otp })
        });

        state.token = data.token;
        state.email = data.email || '';
        state.name = data.name || '';
        state.photo = data.photo || '';

        localStorage.setItem('cp_token', state.token);
        localStorage.setItem('cp_usn', state.usn);
        localStorage.setItem('cp_email', state.email);
        localStorage.setItem('cp_name', state.name);
        localStorage.setItem('cp_photo', state.photo);

        stopResendTimer();
        setStatus(status.otp, '', 'neutral');
        showDashboard();
    } catch (err) {
        if (err.message !== 'session-expired') {
            setStatus(status.otp, err.message || 'Verification failed', 'error');
        }
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('back-to-login').addEventListener('click', () => {
    stopResendTimer();
    setStatus(status.otp, '', 'neutral');
    forms.otp.classList.remove('active');
    forms.login.classList.add('active');
});

document.getElementById('logout-btn').addEventListener('click', async () => {
    stopPolling();
    try {
        await api('/logout', { method: 'POST' });
    } catch {
        // Session may already be gone server-side; clearing locally is enough.
    }
    clearCarpoolStorage();
    location.reload();
});

// Trip Logic
document.querySelectorAll('.trip-card').forEach(card => {
    card.addEventListener('click', () => {
        state.direction = card.dataset.type;
        showForm();
    });
});

document.getElementById('back-to-selection').addEventListener('click', () => {
    if (state.myRequest) {
        showBoard();
    } else {
        showSelector();
    }
});

document.getElementById('edit-request-btn').addEventListener('click', () => {
    if (!state.myRequest) return;
    state.direction = state.myRequest.direction;
    showForm('edit');
});

forms.trip.addEventListener('submit', async (e) => {
    e.preventDefault();

    const tripStatus = document.getElementById('trip-status');
    const isoTime = istInputToIso(inputs.time.value);
    if (!isoTime) {
        setStatus(tripStatus, 'Pick a valid date and time', 'error');
        return;
    }

    const btn = forms.trip.querySelector('button[type="submit"]');
    const label = document.getElementById('trip-submit-label');
    const original = label.textContent;
    btn.disabled = true;
    label.textContent = state.formMode === 'edit' ? 'Saving...' : 'Posting...';
    setStatus(tripStatus, '', 'neutral');

    try {
        const data = await api('/requests', {
            method: 'POST',
            body: JSON.stringify({
                direction: state.direction,
                time: isoTime,
                flightCode: inputs.flight.value,
                waitMinutes: inputs.wait.value
            })
        });

        state.myRequest = data.request || null;
        acceptedMatches.clear();
        lastMatchesSignature = null;
        lastBoardSignature = null;
        if (state.myRequest) {
            renderTripHead(state.myRequest);
            showBoard();
        }
        await refreshOverview();
    } catch (err) {
        if (err.message !== 'session-expired') {
            setStatus(tripStatus, err.message || 'Failed to create request', 'error');
        }
    } finally {
        btn.disabled = false;
        label.textContent = original;
    }
});

document.getElementById('cancel-request-btn').addEventListener('click', async () => {
    const btn = document.getElementById('cancel-request-btn');
    const original = btn.textContent;
    btn.textContent = 'Cancelling...';
    btn.disabled = true;

    try {
        await api('/cancel', { method: 'POST' });
        state.myRequest = null;
        acceptedMatches.clear();
        lastMatchesSignature = null;
        lastBoardSignature = null;
        showSelector();
        await refreshOverview();
    } catch (err) {
        if (err.message !== 'session-expired') {
            alert(err.message || 'Could not cancel your journey');
        }
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
});

// Live data
document.getElementById('refresh-board-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('rotating');
    try {
        await refreshOverview();
    } finally {
        setTimeout(() => btn.classList.remove('rotating'), 500);
    }
});

function startPolling() {
    stopPolling();
    refreshOverview();
    // Plain polling: EventSource cannot send an Authorization header, and the
    // serverless host drops long-lived streams anyway.
    state.pollTimer = setInterval(() => {
        if (!document.hidden) refreshOverview();
    }, POLL_MS);
}

function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.token) refreshOverview();
});

async function refreshOverview() {
    if (!state.token) return;
    try {
        applyOverview(await api('/overview'));
    } catch (err) {
        if (err.message !== 'session-expired') console.error('Board refresh failed:', err);
    }
}

function applyOverview(data) {
    state.myRequest = data.myRequest || null;

    const total = data.activeRequests ?? 0;
    setText('public-count', total);
    setText('pick-count', total);

    if (state.myRequest) {
        const matches = data.matches || [];
        const requests = data.requests || [];
        setText('match-count', matches.length);
        renderTripHead(state.myRequest);
        renderRail(state.myRequest, matches, requests);
        renderBoard(requests);
        renderMatches(matches);
        // Don't yank the student out of a form they are filling in.
        if (state.screen !== 'form') showBoard();
    } else {
        if (state.screen !== 'form') showSelector();
    }
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function initial(name) {
    return String(name || '?').trim().slice(0, 1).toUpperCase();
}

function faceMarkup(person, className) {
    const photo = safePhotoUrl(person.photo);
    if (photo) {
        return `<span class="${className}"><img src="${escapeHtml(photo)}" alt=""></span>`;
    }
    return `<span class="${className}">${escapeHtml(initial(person.name))}</span>`;
}

function renderTripHead(mine) {
    const arriving = mine.direction === 'hostel';
    setText('rail-eyebrow', arriving ? 'Arriving at BLR' : 'Departing for BLR');

    const timeEl = document.getElementById('rail-time');
    if (timeEl) timeEl.innerHTML = timeHtml(mine.time);

    const meta = document.getElementById('rail-meta');
    if (!meta) return;
    const flight = mine.flightCode
        ? ` &middot; <span class="mono">${escapeHtml(mine.flightCode)}</span>`
        : '';
    meta.innerHTML = `${escapeHtml(formatDateLong(mine.time))}${flight}`;
}

const PLANE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26" aria-hidden="true">
    <path d="M21.6 12c0 .62-.5 1.06-1.16 1.08l-5.03.18-3.2 5.42c-.19.32-.53.52-.9.52H9.6l1.55-6.03-4.05.15-1.45 2.05c-.14.2-.37.32-.61.32H3.6l1.06-3.69L3.6 8.31h1.44c.24 0 .47.12.61.32L7.1 10.68l4.05.15L9.6 4.8h1.71c.37 0 .71.2.9.52l3.2 5.42 5.03.18c.66.02 1.16.46 1.16 1.08z"/>
</svg>`;

/* The rail: your time at centre, your wait tolerance as a lit band, and
   everyone heading the same way pinned by how far off they are. */
function renderRail(mine, matches, requests) {
    const rail = document.getElementById('rail');
    if (!rail) return;

    const tolerance = Number(mine.waitMinutes) || 30;
    const span = Math.max(60, tolerance * 2);
    const myTime = new Date(mine.time).getTime();
    const matchedIds = new Set(matches.map(m => m.requestId).filter(Boolean));

    const pos = (mins) => 50 + (mins / span) * 50;

    const neighbours = requests
        .filter(r => !r.isYou && r.direction === mine.direction)
        .map(r => ({ ...r, delta: Math.round((new Date(r.time).getTime() - myTime) / 60000) }))
        .filter(r => Math.abs(r.delta) <= span)
        .sort((a, b) => a.delta - b.delta);

    const bandLeft = pos(-tolerance);
    const bandWidth = pos(tolerance) - bandLeft;

    const pins = neighbours.map(n => {
        const matched = matchedIds.has(n.id);
        const sign = n.delta > 0 ? '+' : '';
        const title = `${n.name} · ${formatTime(n.time)} · ${sign}${n.delta} min`;
        return `
            <span class="rail-pin ${matched ? 'is-match' : 'is-near'}"
                  style="left:${pos(n.delta).toFixed(2)}%"
                  title="${escapeHtml(title)}">
                ${faceMarkup(n, 'pin-dot')}
            </span>`;
    }).join('');

    // Ruler ticks give the axis texture even when nobody else is on it.
    const step = span >= 90 ? 30 : 15;
    let ticks = '';
    for (let m = -span; m <= span; m += step) {
        if (m === 0) continue;
        ticks += `<span class="rail-tick" style="left:${pos(m).toFixed(2)}%"></span>`;
    }

    rail.innerHTML = `
        <div class="rail-glow" style="left:${bandLeft.toFixed(2)}%;width:${bandWidth.toFixed(2)}%"></div>
        <div class="rail-axis"></div>
        ${ticks}
        <span class="rail-gate" style="left:${bandLeft.toFixed(2)}%"></span>
        <span class="rail-gate" style="left:${(bandLeft + bandWidth).toFixed(2)}%"></span>
        ${pins}
        <span class="rail-pin is-you" style="left:50%">
            <span class="pin-label">You</span>
            <span class="pin-plane">${PLANE_SVG}</span>
        </span>
        <div class="rail-dim" style="left:${bandLeft.toFixed(2)}%;width:${bandWidth.toFixed(2)}%">
            <span class="rail-dim-label">&plusmn;${tolerance} min window</span>
        </div>
        <div class="rail-scale">
            <span class="at-start">&minus;${span} min</span>
            <span class="at-mid">${escapeHtml(formatTime(mine.time))}</span>
            <span class="at-end">+${span} min</span>
        </div>
    `;

    const legend = document.getElementById('rail-legend');
    if (!legend) return;

    const inWindow = matches.length;
    const nearby = neighbours.length - inWindow;

    if (inWindow > 0) {
        legend.innerHTML = `<strong>${inWindow} ${inWindow === 1 ? 'match' : 'matches'}</strong> inside your `
            + `${tolerance}-minute window${nearby > 0 ? `, and ${nearby} just outside it` : ''}.`;
    } else if (nearby > 0) {
        legend.innerHTML = `No matches yet. <strong>${nearby}</strong> `
            + `${nearby === 1 ? 'student is' : 'students are'} travelling nearby but outside your `
            + `${tolerance}-minute window.`;
    } else {
        legend.innerHTML = `You're on the board. We'll pin anyone heading the same way within `
            + `<strong>${tolerance} minutes</strong> of you.`;
    }
}

function renderBoard(requests) {
    const list = document.getElementById('public-board-list');
    if (!list) return;

    const sorted = [...requests].sort((a, b) => new Date(a.time) - new Date(b.time));
    const signature = JSON.stringify(sorted.map(r => [r.id, r.time, r.name, r.direction, r.flightCode]));
    if (signature === lastBoardSignature) return;
    lastBoardSignature = signature;

    if (!sorted.length) {
        list.innerHTML = `
            <div class="empty">
                <p class="empty-title">Nobody else yet</p>
                <p class="empty-text">You're first on the board. We'll add students as they post their trips.</p>
            </div>`;
        return;
    }

    list.innerHTML = sorted.map(r => {
        const arriving = r.direction === 'hostel';
        return `
            <div class="board-row ${arriving ? 'to-hostel' : 'to-airport'}${r.isYou ? ' is-you' : ''}">
                ${faceMarkup(r, 'board-face')}
                <div class="board-body">
                    <div class="board-name">
                        ${escapeHtml(r.name)}${r.isYou ? '<span class="tag-you">You</span>' : ''}
                    </div>
                    <div class="board-dir">
                        ${arriving ? 'To hostel' : 'To airport'}${r.flightCode ? ` &middot; ${escapeHtml(r.flightCode)}` : ''}
                    </div>
                </div>
                <div class="board-when">
                    <div class="board-time">${timeHtml(r.time)}</div>
                    <div class="board-date">${escapeHtml(formatDate(r.time))}</div>
                </div>
            </div>`;
    }).join('');
}

const funnyMessages = {
    userWaiting: [
        (user, match, mins) => `You land first. ${mins} minutes to grab a chai before ${match} shows up.`,
        (user, match, mins) => `${mins} minutes of reels while you wait on ${match}.`,
        (user, match, mins) => `${match} is ${mins} minutes behind you. Worth the wait to split the fare.`,
        (user, match, mins) => `You're early by ${mins} minutes. Find a charging point, ${user}.`,
        (user, match, mins) => `${mins} minutes ahead of ${match}. Pick the pickup point and tell them.`
    ],
    matchWaiting: [
        (user, match, mins) => `${match} gets there ${mins} minutes before you and is happy to wait.`,
        (user, match, mins) => `${match} is early by ${mins} minutes. Tell them where to stand.`,
        (user, match, mins) => `No rush, ${user}. ${match} has ${mins} minutes to kill.`,
        (user, match, mins) => `${match} lands ${mins} minutes ahead. They'll hold the cab.`,
        (user, match, mins) => `${mins} minutes earlier than you, and still willing to share.`
    ]
};

function getFunnyMessage(match) {
    const user = (state.name || 'Student').split(' ')[0];
    const other = String(match.name || 'Someone').split(' ')[0];
    const mins = Math.abs(Number(match.gapMinutes) || 0);

    if (mins === 0) return `Same time, same direction. Split it with ${other}.`;

    const pool = Number(match.youWaitMinutes) > 0 ? funnyMessages.userWaiting : funnyMessages.matchWaiting;
    return pool[seededIndex(String(match.id), pool.length)](user, other, mins);
}

function renderMatches(matches) {
    const list = document.getElementById('matches-list');
    if (!list) return;

    const rows = Array.isArray(matches) ? matches : [];
    const signature = JSON.stringify([rows.map(m => [m.id, m.time, m.name]), [...acceptedMatches]]);
    if (signature === lastMatchesSignature) return;
    lastMatchesSignature = signature;

    if (!rows.length) {
        const when = state.myRequest ? formatTime(state.myRequest.time) : 'your time';
        list.innerHTML = `
            <div class="empty">
                <p class="empty-title">No matches yet</p>
                <p class="empty-text">
                    We're watching for anyone heading your way near
                    <span class="mono">${escapeHtml(when)}</span>. This board updates on its own.
                </p>
            </div>`;
        return;
    }

    list.innerHTML = rows.map(m => {
        const sent = acceptedMatches.has(m.id);
        const firstName = String(m.name || 'them').split(' ')[0];
        const gap = Math.abs(Number(m.gapMinutes) || 0);
        const gapText = gap === 0 ? 'Same time' : `${gap} min apart`;

        return `
            <article class="match">
                <div class="match-top">
                    <div class="match-who">
                        ${faceMarkup(m, 'board-face')}
                        <div>
                            <div class="match-name">${escapeHtml(m.name)}</div>
                            <div class="match-sub">
                                <span>${m.direction === 'hostel' ? 'To hostel' : 'To airport'}</span>
                                ${m.flightCode ? `<span class="mono">${escapeHtml(m.flightCode)}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="match-when">
                        <div class="match-time">${timeHtml(m.time)}</div>
                        <div class="match-gap">${escapeHtml(gapText)}</div>
                    </div>
                </div>

                <p class="match-note">${escapeHtml(getFunnyMessage(m))}</p>

                <button class="btn ${sent ? 'btn-quiet' : 'btn-primary'} btn-connect${sent ? ' is-sent' : ''}"
                        data-match-id="${escapeHtml(m.id)}"${sent ? ' disabled' : ''}>
                    <span class="btn-label">${sent ? 'Introduction sent' : `Share my details with ${escapeHtml(firstName)}`}</span>
                </button>
            </article>`;
    }).join('');
}

document.getElementById('matches-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-match-id]');
    if (btn && !btn.disabled) acceptMatch(btn);
});

async function acceptMatch(btn) {
    const matchId = btn.dataset.matchId;
    const label = btn.querySelector('.btn-label') || btn;
    const original = label.textContent;
    btn.disabled = true;
    label.textContent = 'Sending...';

    try {
        await api('/accept', {
            method: 'POST',
            body: JSON.stringify({ matchId })
        });
        acceptedMatches.add(matchId);
        label.textContent = 'Email sent!';
        btn.classList.add('is-sent');
    } catch (err) {
        if (err.message === 'session-expired') return;
        label.textContent = err.message || 'Failed';
        btn.disabled = false;
        setTimeout(() => { label.textContent = original; }, 2500);
    }
}

// Start
function init() {
    inputs.time.min = istInputNow();
    if (state.token) {
        showDashboard();
    } else {
        showAuth();
    }
}

init();
