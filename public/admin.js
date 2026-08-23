
const loginSection = document.getElementById('login-section');
const dashboardSection = document.getElementById('dashboard-section');
const sendOtpBtn = document.getElementById('send-otp-btn');
const verifyOtpBtn = document.getElementById('verify-otp-btn');
const backToSend = document.getElementById('back-to-send');
const otpView = document.getElementById('otp-verify-view');
const requestView = document.getElementById('otp-request-view');
const messageBox = document.getElementById('message-box');
const studentsGrid = document.getElementById('students-grid');
const logoutBtn = document.getElementById('logout-btn');

// New Controls
const searchInput = document.getElementById('search-input');
const sortSelect = document.getElementById('sort-select');
const genderFilter = document.getElementById('gender-filter');
const batchFilter = document.getElementById('batch-filter');

// Renders a photo, or an initial locally. The old fallback pointed at
// via.placeholder.com, which the Content-Security-Policy blocks - every
// student without a photo showed a broken-image icon, and each one would
// otherwise have leaked a request to a third party.
function avatarMarkup(student, { size = 40, className = '', style = '' } = {}) {
    const name = student.name || 'Unknown';
    const initial = name.trim().charAt(0).toUpperCase() || '?';
    const box = `width:${size}px;height:${size}px;border-radius:50%;${style}`;

    if (student.photo) {
        return `<img src="${student.photo}" class="${className}" alt=""
                     style="${box}object-fit:cover;"
                     onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar-initial ${className}',textContent:'${initial}',style:'${box}'}))">`;
    }
    return `<div class="avatar-initial ${className}" style="${box}">${initial}</div>`;
}


const birthdaysSection = document.getElementById('birthdays-section');
const birthdaysGrid = document.getElementById('birthdays-grid');
const studentModal = document.getElementById('student-modal');
const modalBody = document.getElementById('modal-body');
const closeModal = document.querySelector('.close-modal');
const bloodGroupStats = document.getElementById('blood-group-stats');

let allStudents = [];
let currentBgView = 'grid';

function getMobileNumber(student) {
    return student?.mobile_number || '';
}

function normalizeBloodGroup(value) {
    if (!value) return '';

    const trimmed = String(value).trim();
    if (!trimmed) return '';

    const compact = trimmed
        .toUpperCase()
        .replace(/\s+/g, '')
        .replaceAll('POSITIVE', '+')
        .replaceAll('NEGATIVE', '-');

    const aliases = {
        'OPOS': 'O+',
        'OPOSITIVE': 'O+',
        'O+VE': 'O+',
        'ONEG': 'O-',
        'ONEGATIVE': 'O-',
        'O-VE': 'O-',
        'APOS': 'A+',
        'APOSITIVE': 'A+',
        'A+VE': 'A+',
        'ANEG': 'A-',
        'ANEGATIVE': 'A-',
        'A-VE': 'A-',
        'BPOS': 'B+',
        'BPOSITIVE': 'B+',
        'B+VE': 'B+',
        'BNEG': 'B-',
        'BNEGATIVE': 'B-',
        'B-VE': 'B-',
        'ABPOS': 'AB+',
        'ABPOSITIVE': 'AB+',
        'AB+VE': 'AB+',
        'ABNEG': 'AB-',
        'ABNEGATIVE': 'AB-',
        'AB-VE': 'AB-'
    };

    if (aliases[compact]) return aliases[compact];

    const match = /^(AB|A|B|O)([+-])$/.exec(compact);
    if (match) return `${match[1]}${match[2]}`;

    return trimmed.toUpperCase();
}

function showMessage(msg, isError = false) {
    messageBox.querySelector('span').textContent = msg;
    messageBox.classList.remove('hidden');
    messageBox.style.background = isError ? 'var(--error-light)' : 'var(--success-light)';
    messageBox.style.color = isError ? 'var(--error)' : 'var(--success)';
}

function hideMessage() {
    messageBox.classList.add('hidden');
}

// 1. Send OTP
sendOtpBtn.addEventListener('click', async () => {
    sendOtpBtn.disabled = true;
    sendOtpBtn.textContent = 'Sending...';
    hideMessage();

    try {
        const res = await fetch('/api/admin/login', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            showMessage(data.message);
            requestView.classList.add('hidden');
            otpView.classList.remove('hidden');
        } else {
            showMessage(data.error, true);
        }
    } catch (e) {
        console.error(e);
        showMessage('Failed to send OTP', true);
    } finally {
        sendOtpBtn.disabled = false;
        sendOtpBtn.textContent = 'Send Verification Code';
    }
});

// Sending a mail is pointless when the permanent code is what gets typed
// anyway, so this jumps straight to the code entry without asking the server
// for one. /api/admin/verify already accepts either code, so nothing on the
// server needs to know the difference.
document.getElementById('use-permanent-otp').addEventListener('click', () => {
    hideMessage();
    requestView.classList.add('hidden');
    otpView.classList.remove('hidden');
    document.getElementById('admin-otp').focus();
});

// 2. Verify OTP
verifyOtpBtn.addEventListener('click', async () => {
    const otp = document.getElementById('admin-otp')?.value;
    if (otp?.length !== 6) return showMessage('Enter 6-digit code', true);

    verifyOtpBtn.disabled = true;
    verifyOtpBtn.textContent = 'Verifying...';
    hideMessage();

    try {
        const res = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ otp })
        });
        const data = await res.json();

        if (data.success) {
            localStorage.setItem('adminToken', data.token);
            showDashboard();
        } else {
            showMessage(data.error, true);
        }
    } catch (e) {
        console.error(e);
        showMessage('Verification failed', true);
    } finally {
        verifyOtpBtn.disabled = false;
        verifyOtpBtn.textContent = 'Verify Access';
    }
});

// 3. Load Dashboard
async function showDashboard() {
    const token = localStorage.getItem('adminToken');
    if (!token) return logout();

    loginSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');

    try {
        const res = await fetch('/api/admin/students', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (res.status === 401 || res.status === 403) {
            console.error('Auth error:', res.status);
            logout();
            return;
        }

        if (!res.ok) throw new Error('Failed to fetch data');

        const data = await res.json();

        if (data.success) {
            allStudents = data.students || [];
            try {
                applyFilters(); // Initial render
                if (typeof calculateStats === 'function') calculateStats();
                checkBirthdays();
            } catch (renderError) {
                console.error('Rendering error:', renderError);
                showMessage('Error displaying data', true);
            }
        } else {
            console.error('API returned failure:', data);
            logout();
        }
    } catch (e) {
        console.error('Dashboard error:', e);
        // Only logout if it's a critical error related to auth, otherwise just alert
        // But for safety, keep existing behavior for now, just log it.
        // Actually, if fetch fails (network), we shouldn't logout.
        if (e.message.includes('Auth')) {
            logout();
        } else {
            showMessage('Network error: ' + e.message, true);
        }
    }
}

// ===== Filter & Sort Logic =====

function applyFilters() {
    const query = searchInput.value?.toLowerCase() || '';
    const sortKey = sortSelect.value; // 'name', 'usn', 'batch'
    const genderVal = genderFilter.value; // 'all', 'male', 'female'
    const batchVal = batchFilter.value; // 'all', 'batch 1', 'batch 2'

    // Filter
    let filtered = allStudents.filter(s => {
        if (s.status === 'left') return false;

        const matchesSearch = s.name?.toLowerCase().includes(query) || s.usn?.toLowerCase().includes(query);
        if (!matchesSearch) return false;

        if (genderVal !== 'all' && s.gender?.toLowerCase() !== genderVal) return false;
        if (batchVal !== 'all' && !s.batch?.toLowerCase().includes(batchVal)) return false;

        return true;
    });

    // Sort
    filtered.sort((a, b) => {
        const valA = (a[sortKey] || '').toString().toLowerCase();
        const valB = (b[sortKey] || '').toString().toLowerCase();
        return valA.localeCompare(valB);
    });

    renderStudents(filtered);
}

searchInput.addEventListener('input', applyFilters);
sortSelect.addEventListener('change', applyFilters);
genderFilter.addEventListener('change', applyFilters);
batchFilter.addEventListener('change', applyFilters);

// Click helper on stats cards to filter students
window.filterByStat = function(type) {
    if (type === 'all') {
        genderFilter.value = 'all';
        batchFilter.value = 'all';
    } else if (type === 'male') {
        genderFilter.value = 'male';
        batchFilter.value = 'all';
    } else if (type === 'female') {
        genderFilter.value = 'female';
        batchFilter.value = 'all';
    } else if (type === 'batch 1') {
        genderFilter.value = 'all';
        batchFilter.value = 'batch 1';
    } else if (type === 'batch 2') {
        genderFilter.value = 'all';
        batchFilter.value = 'batch 2';
    }
    applyFilters();
};

// Birthday button - toggle birthday section
document.getElementById('birthday-btn').addEventListener('click', () => {
    birthdaysSection.classList.toggle('hidden');
});

// Blood Stats button - toggle blood group section
document.getElementById('blood-stats-btn').addEventListener('click', () => {
    document.getElementById('blood-group-section').classList.toggle('hidden');
});

// Refresh button - reload all students
document.getElementById('refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('refresh-btn');
    btn.textContent = '⏳ Refreshing...';
    btn.disabled = true;

    try {
        await showDashboard();
        btn.textContent = '✅ Refreshed';
        setTimeout(() => {
            btn.textContent = '🔄 Refresh';
            btn.disabled = false;
        }, 1500);
    } catch (e) {
        console.error(e);
        btn.textContent = '❌ Failed';
        setTimeout(() => {
            btn.textContent = '🔄 Refresh';
            btn.disabled = false;
        }, 1500);
    }
});


studentsGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.student-card');
    if (card) {
        console.log('Clicked student card:', card.dataset.usn);
        if (card.dataset.usn) {
            openStudentModal(card.dataset.usn);
        }
    }
});

birthdaysGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.birthday-card');
    if (card) {
        console.log('Clicked birthday card:', card.dataset.usn);
        if (card.dataset.usn) {
            openStudentModal(card.dataset.usn);
        }
    }
});

function renderStudents(students) {
    const countChip = document.getElementById('student-count');
    if (countChip) {
        countChip.textContent = `${students.length} shown`;
        countChip.classList.remove('hidden');
    }

    if (students.length === 0) {
        studentsGrid.innerHTML = '<p style="text-align:center; width:100%; color: var(--text-secondary);">No students found.</p>';
        return;
    }


    studentsGrid.innerHTML = students.map(s => `
            <div class="student-card" data-usn="${s.usn || ''}" style="cursor: pointer;">
                ${avatarMarkup(s, { size: 60, className: 'mini-photo' })}
                <div class="student-info">
                    <h4>
                        ${s.name || 'Unknown Name'} 
                        ${s.status === 'left' ? '<span style="color:var(--error); font-size:0.8em; margin-left:5px;">(Left Batch)</span>' : ''}
                    </h4>
                    <p class="sc-usn">${s.usn || 'No USN'}</p>
                    <div class="sc-email" title="${s.email || ''}">${s.email || 'No email'}</div>
                    <div class="sc-mobile">${getMobileNumber(s) || 'No mobile'}</div>
                </div>
            </div>
        `).join('');
}

// ===== Stats Logic =====

function calculateStats() {
    const activeStudents = allStudents.filter(s => s.status !== 'left');
    const total = activeStudents.length;

    const males = activeStudents.filter(s => s.gender?.toLowerCase() === 'male').length;
    const females = activeStudents.filter(s => s.gender?.toLowerCase() === 'female').length;
    const batch1 = activeStudents.filter(s => s.batch?.toLowerCase().includes('1')).length;
    const batch2 = activeStudents.filter(s => s.batch?.toLowerCase().includes('2')).length;

    const bloodGroupOrder = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
    const bloodGroupCounts = {
        'O+': 0, 'O-': 0, 'A+': 0, 'A-': 0,
        'B+': 0, 'B-': 0, 'AB+': 0, 'AB-': 0,
        'Not Set': 0
    };
    activeStudents.forEach(student => {
        const bloodGroup = normalizeBloodGroup(student.blood_group);
        const key = bloodGroup || 'Not Set';
        bloodGroupCounts[key] = (bloodGroupCounts[key] || 0) + 1;
    });

    const statsBar = document.getElementById('stats-bar');
    if (!statsBar) return;

    statsBar.innerHTML = `
        <div class="stat-card" style="cursor: pointer;" onclick="filterByStat('all')">
            <div class="stat-value">${total}</div>
            <div class="stat-label">Total Students</div>
        </div>
        <div class="stat-card" style="cursor: pointer;" onclick="filterByStat('male')">
            <div class="stat-value">${males}</div>
            <div class="stat-label">Male</div>
        </div>
        <div class="stat-card" style="cursor: pointer;" onclick="filterByStat('female')">
            <div class="stat-value">${females}</div>
            <div class="stat-label">Female</div>
        </div>
        <div class="stat-card" style="cursor: pointer;" onclick="filterByStat('batch 1')">
            <div class="stat-value">${batch1}</div>
            <div class="stat-label">Batch 1</div>
        </div>
        <div class="stat-card" style="cursor: pointer;" onclick="filterByStat('batch 2')">
            <div class="stat-value">${batch2}</div>
            <div class="stat-label">Batch 2</div>
        </div>
    `;
    statsBar.classList.remove('hidden');

    if (!bloodGroupStats) return;

    const orderedBloodGroups = Object.entries(bloodGroupCounts).sort(([groupA], [groupB]) => {
        const indexA = bloodGroupOrder.indexOf(groupA);
        const indexB = bloodGroupOrder.indexOf(groupB);

        if (indexA !== -1 || indexB !== -1) {
            if (indexA === -1) return 1;
            if (indexB === -1) return -1;
            return indexA - indexB;
        }

        if (groupA === 'Not Set') return 1;
        if (groupB === 'Not Set') return -1;
        return groupA.localeCompare(groupB);
    });

    // Outer shell of the panel
    bloodGroupStats.innerHTML = `
        <div class="blood-group-header">
            <div class="blood-group-header-text">
                <h3>Blood Groups</h3>
                <p>Student counts and distribution</p>
            </div>
            <div class="blood-group-toggle">
                <button id="bg-view-grid" class="view-toggle-btn ${currentBgView === 'grid' ? 'active' : ''}" title="Grid View">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="3" width="7" height="7"></rect>
                        <rect x="14" y="3" width="7" height="7"></rect>
                        <rect x="14" y="14" width="7" height="7"></rect>
                        <rect x="3" y="14" width="7" height="7"></rect>
                    </svg>
                </button>
                <button id="bg-view-chart" class="view-toggle-btn ${currentBgView === 'chart' ? 'active' : ''}" title="Distribution View">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="20" x2="18" y2="10"></line>
                        <line x1="12" y1="20" x2="12" y2="4"></line>
                        <line x1="6" y1="20" x2="6" y2="14"></line>
                    </svg>
                </button>
            </div>
        </div>
        <div id="blood-group-content-area"></div>
    `;
    bloodGroupStats.classList.remove('hidden');

    function renderBloodGroupContent() {
        const contentArea = document.getElementById('blood-group-content-area');
        if (!contentArea) return;

        if (currentBgView === 'grid') {
            contentArea.innerHTML = `
                <div class="blood-group-grid">
                    ${orderedBloodGroups.map(([group, count]) => {
                        const hasData = count > 0;
                        return `
                            <div class="blood-group-card ${hasData ? 'has-data' : 'empty-data'}" data-group="${group}">
                                <div class="blood-group-card-bg-droplet">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
                                    </svg>
                                </div>
                                <span class="blood-group-card-value">${count}</span>
                                <span class="blood-group-card-label">${group}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        } else {
            contentArea.innerHTML = `
                <div class="blood-group-chart">
                    ${orderedBloodGroups.map(([group, count]) => {
                        const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
                        return `
                            <div class="chart-row" data-group="${group}">
                                <div class="chart-row-info">
                                    <span class="chart-row-label">${group}</span>
                                    <span class="chart-row-count">${count} <span style="font-size:0.75rem; font-weight:500; color:var(--text-muted);">(${percentage}%)</span></span>
                                </div>
                                <div class="chart-row-bar-container">
                                    <div class="chart-row-bar-fill" style="width: ${percentage}%"></div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }
    }

    function handleBloodGroupClick(group) {
        const studentsForGroup = allStudents.filter(s => {
            if (s.status === 'left') return false;
            const bg = normalizeBloodGroup(s.blood_group);
            if (!bg) return group === 'Not Set';
            return bg === group;
        });

        if (!studentModal || !modalBody) return;

        if (studentsForGroup.length === 0) {
            modalBody.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-secondary);">No students found with blood group ${group}</div>`;
        } else {
            modalBody.innerHTML = `
                <div style="padding: 10px 0;">
                    <div class="modal-directory-title">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
                        </svg>
                        <span>Blood Group: ${group} (${studentsForGroup.length})</span>
                    </div>
                    <div class="modal-directory-grid">
                        ${studentsForGroup.map(s => `
                            <div class="modal-directory-card" data-usn="${s.usn || ''}">
                                ${avatarMarkup(s, { size: 42, className: 'modal-directory-photo' })}
                                <div class="modal-directory-name" title="${s.name || 'Unknown'}">${s.name || 'Unknown'}</div>
                                <div class="modal-directory-usn">${s.usn || ''}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;

            // Attach click handlers to open individual student details modal
            modalBody.querySelectorAll('.modal-directory-card').forEach(card => {
                card.addEventListener('click', () => {
                    const usn = card.dataset.usn;
                    if (!usn) return;
                    openStudentModal(usn);
                });
            });
        }

        studentModal.classList.remove('hidden');
    }

    function attachBloodGroupListeners() {
        const contentArea = document.getElementById('blood-group-content-area');
        if (!contentArea) return;

        const items = contentArea.querySelectorAll('.blood-group-card, .chart-row');
        items.forEach(item => {
            item.addEventListener('click', () => {
                const group = item.dataset.group;
                handleBloodGroupClick(group);
            });
        });
    }

    // Initial render and attach listeners
    renderBloodGroupContent();
    attachBloodGroupListeners();

    // Toggle view listeners
    const toggleGridBtn = document.getElementById('bg-view-grid');
    const toggleChartBtn = document.getElementById('bg-view-chart');
    
    if (toggleGridBtn && toggleChartBtn) {
        toggleGridBtn.addEventListener('click', () => {
            if (currentBgView === 'grid') return;
            currentBgView = 'grid';
            toggleGridBtn.classList.add('active');
            toggleChartBtn.classList.remove('active');
            renderBloodGroupContent();
            attachBloodGroupListeners();
        });
        
        toggleChartBtn.addEventListener('click', () => {
            if (currentBgView === 'chart') return;
            currentBgView = 'chart';
            toggleChartBtn.classList.add('active');
            toggleGridBtn.classList.remove('active');
            renderBloodGroupContent();
            attachBloodGroupListeners();
        });
    }
}

// ===== Birthdays Logic =====

function checkBirthdays() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get all students with birthdays and calculate their next occurrence
    const withBirthdays = allStudents
        .filter(s => s.status !== 'left' && s.birthday)
        .map(s => {
            const parts = s.birthday.split('-');
            if (parts.length < 2) return null;

            const day = Number.parseInt(parts[0], 10);
            const month = Number.parseInt(parts[1], 10);

            if (Number.isNaN(day) || Number.isNaN(month)) return null;

            // Calculate next birthday occurrence
            let nextBday = new Date(today.getFullYear(), month - 1, day);

            // If birthday already passed this year, use next year
            if (nextBday < today) {
                nextBday.setFullYear(today.getFullYear() + 1);
            }

            // Calculate days until birthday
            const daysUntil = Math.ceil((nextBday - today) / (1000 * 60 * 60 * 24));

            let daysUntilText = `in ${daysUntil} days`;
            if (daysUntil === 0) {
                daysUntilText = 'Today!';
            } else if (daysUntil === 1) {
                daysUntilText = 'Tomorrow';
            }

            return {
                ...s,
                nextBday,
                daysUntil,
                daysUntilText,
                displayDate: `${day}/${month}`
            };
        })
        .filter(s => s !== null)
        .sort((a, b) => a.nextBday - b.nextBday); // Sort by upcoming date

    if (withBirthdays.length > 0) {
        birthdaysSection.classList.remove('hidden');
        birthdaysGrid.innerHTML = withBirthdays.map(s => `
                <div class="birthday-card" data-usn="${s.usn || ''}" style="cursor: pointer;">
                    ${avatarMarkup(s, { size: 40, style: 'margin-bottom:5px;' })}
                    <div style="font-weight:600; font-size:0.9rem;">${s.name}</div>
                    <div style="color:var(--primary-600); font-size:0.8rem;">${s.displayDate}</div>
                    <div style="color:var(--text-secondary); font-size:0.75rem;">${s.daysUntilText}</div>
                </div>
            `).join('');
    } else {
        birthdaysSection.classList.add('hidden');
    }
}


// ===== Modal Logic =====

function openStudentModal(usn) {
    try {
        console.log('Opening modal for USN:', usn); // Debug log
        // Ensure accurate comparison by converting to strings
        const s = allStudents.find(stu => String(stu.usn) === String(usn));

        if (!s) {
            console.error('Student not found for USN:', usn, 'Available:', allStudents.map(s => s.usn));
            showMessage('Student data not found', true);
            return;
        }

        const portrait = s.photo
            ? `<img src="${s.photo}" alt="" class="pc-portrait">`
            : `<div class="pc-portrait pc-portrait-fallback">${(s.name || '?').trim().charAt(0).toUpperCase()}</div>`;

        const pcLink = (url, label) => url
            ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="pc-link">${label}</a>`
            : '';

        const pcRow = (label, value, cls = '') => `
            <div class="pc-row">
                <span class="pc-label">${label}</span>
                <span class="pc-value ${cls}">${value || 'Not set'}</span>
            </div>`;

        modalBody.innerHTML = `
            <div class="profile-card">
                <div class="pc-hero">
                    ${portrait}
                    <div class="pc-ident">
                        <h2 class="pc-name">${s.name || 'Unknown'}</h2>
                        <div class="pc-usn">${s.usn || ''}</div>
                        <div class="pc-chips">
                            ${s.batch ? `<span class="pc-chip">${s.batch}</span>` : ''}
                            ${s.blood_group ? `<span class="pc-chip pc-chip-blood">${s.blood_group}</span>` : ''}
                            ${s.gender ? `<span class="pc-chip">${s.gender}</span>` : ''}
                        </div>
                        <div class="pc-actions">
                            ${pcLink(s.linkedin, 'LinkedIn')}
                            ${pcLink(s.github, 'GitHub')}
                        </div>
                    </div>
                </div>

                <div class="pc-details">
                    ${pcRow('Birthday', s.birthday)}
                    ${pcRow('Mobile', getMobileNumber(s), 'pc-mono')}
                    ${pcRow('Email', s.email, 'pc-mono pc-wrap')}
                    ${pcRow('College email', s.institutional_email, 'pc-mono pc-wrap')}
                </div>
            </div>
        `;

        studentModal.classList.remove('hidden');
    } catch (e) {
        console.error('Error opening modal:', e);
        showMessage('Failed to open profile', true);
    }
};

closeModal.onclick = () => studentModal.classList.add('hidden');
window.onclick = (e) => {
    if (e.target === studentModal) studentModal.classList.add('hidden');
};

function logout() {
    localStorage.removeItem('adminToken');
    loginSection.classList.remove('hidden');
    dashboardSection.classList.add('hidden');
    otpView.classList.add('hidden');
    requestView.classList.remove('hidden');
    document.getElementById('admin-otp').value = '';
}

backToSend.addEventListener('click', () => {
    otpView.classList.add('hidden');
    requestView.classList.remove('hidden');
    hideMessage();
});

logoutBtn.addEventListener('click', logout);

// Check if already logged in
if (localStorage.getItem('adminToken')) {
    showDashboard();
}

// Theme. Initial value is set by an inline script in <head> to avoid a flash.
// Shares the cp_theme key with the carpool so one choice covers both pages.
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

// ===== First year · Batch of 2030 =====
//
// A second, separate directory fed by the volunteer intake portal at /intake.
// It reads a different Firestore collection, so an incomplete first-year record
// can never leak into the carpool, the birthday mail or the stats above.

let firstYearStudents = [];
let firstYearLoaded = false;
let fyChipFilter = null;   // {type:'batch'|'person', value:string}

// Names here are typed by volunteers rather than curated, so nothing reaches
// innerHTML without being escaped first.
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const FIELD_LABELS = {
    gender: 'gender',
    birthday: 'DOB',
    blood_group: 'blood group',
    mobile_number: 'mobile',
    photo: 'photo'
};

function switchView(view) {
    document.querySelectorAll('[data-view-btn]').forEach(btn => {
        const active = btn.dataset.viewBtn === view;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
    });

    document.querySelectorAll('[data-view]').forEach(node => {
        const mine = node.dataset.view === view;
        // The birthday and blood panels are toggled by their own buttons, so
        // showing the directory again must not force them back open.
        if (!mine) {
            node.classList.add('hidden');
        } else if (node.id !== 'birthdays-section' && node.id !== 'blood-group-section') {
            node.classList.remove('hidden');
        }
    });

    if (view === 'first-year' && !firstYearLoaded) loadFirstYear();
}

document.querySelectorAll('[data-view-btn]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.viewBtn));
});

async function loadFirstYear() {
    const token = localStorage.getItem('adminToken');
    if (!token) return logout();

    const grid = document.getElementById('fy-grid');
    grid.innerHTML = '<p class="empty-note">Loading…</p>';

    try {
        const res = await fetch('/api/admin/first-year', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401 || res.status === 403) return logout();

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load');

        firstYearStudents = data.students || [];
        firstYearLoaded = true;
        renderFirstYearSummary();
        renderFirstYear();
    } catch (e) {
        console.error('First year load failed:', e);
        grid.innerHTML = `<p class="empty-note">${escapeHtml(e.message)}</p>`;
    }
}

function renderFirstYearSummary() {
    const total = firstYearStudents.length;
    const complete = firstYearStudents.filter(s => (s.missing || []).length === 0).length;

    // Names were the only key the official list gave us, so a handful of
    // records land without a batch. They are worth counting separately: they
    // are the ones somebody has to settle by hand.
    const unplaced = firstYearStudents.filter(s => !s.batch).length;
    const bySection = {};
    firstYearStudents.forEach(s => {
        if (!s.batch) return;
        const label = s.batch + (s.section ? ' ' + s.section : '');
        bySection[label] = (bySection[label] || 0) + 1;
    });

    const byVolunteer = {};
    firstYearStudents.forEach(s => {
        const who = s.added_by_name || s.added_by || 'unknown';
        byVolunteer[who] = (byVolunteer[who] || 0) + 1;
    });

    const contributors = Object.entries(byVolunteer)
        .sort((a, b) => b[1] - a[1])
        .map(([who, n]) => `<button type="button" class="fy-chip${
            fyChipFilter?.type === 'person' && fyChipFilter.value === who ? ' active' : ''
        }" data-fy-chip="person" data-fy-value="${escapeHtml(who)}">${escapeHtml(who)} <b>${n}</b></button>`)
        .join('');

    const tabCount = document.getElementById('fy-tab-count');
    tabCount.textContent = total;
    tabCount.classList.toggle('hidden', total === 0);

    document.getElementById('fy-summary').innerHTML = `
        <div class="fy-stats">
            <div class="fy-stat"><span class="fy-stat-value">${total}</span><span class="fy-stat-label">collected</span></div>
            <div class="fy-stat"><span class="fy-stat-value">${complete}</span><span class="fy-stat-label">complete</span></div>
            <div class="fy-stat"><span class="fy-stat-value">${total - complete}</span><span class="fy-stat-label">missing details</span></div>
            ${unplaced ? `<div class="fy-stat"><span class="fy-stat-value">${unplaced}</span><span class="fy-stat-label">no batch yet</span></div>` : ''}
        </div>
        ${Object.keys(bySection).length ? `<div class="fy-contributors"><span class="fy-contrib-label">Batches</span>${
            Object.entries(bySection).sort().map(([label, n]) => `<button type="button" class="fy-chip${
                fyChipFilter?.type === 'batch' && fyChipFilter.value === label ? ' active' : ''
            }" data-fy-chip="batch" data-fy-value="${escapeHtml(label)}">${escapeHtml(label)} <b>${n}</b></button>`).join('')
        }</div>` : ''}
        ${contributors ? `<div class="fy-contributors"><span class="fy-contrib-label">Added by</span>${contributors}</div>` : ''}
        <p class="fy-note">Batches come from the official list, matched on name when a record is saved. Anything
            marked <b>no batch</b> is a name the list could not decide - three students share the name Shivam Kumar -
            and needs setting by hand. Records live in a separate collection and do not appear in the directory,
            carpool or birthday mail.</p>`;
}

function renderFirstYear() {
    const query = (document.getElementById('fy-search').value || '').toLowerCase();
    const filter = document.getElementById('fy-filter').value;
    const grid = document.getElementById('fy-grid');

    const rows = firstYearStudents.filter(s => {
        if (fyChipFilter?.type === 'batch') {
            const label = s.batch ? s.batch + (s.section ? ' ' + s.section : '') : '';
            if (label !== fyChipFilter.value) return false;
        }
        if (fyChipFilter?.type === 'person' && (s.added_by_name || s.added_by || 'unknown') !== fyChipFilter.value) return false;

        const missing = (s.missing || []).length > 0;
        if (filter === 'incomplete' && !missing) return false;
        if (filter === 'complete' && missing) return false;

        if (!query) return true;
        return [s.name, s.usn, s.added_by_name, s.added_by]
            .some(v => String(v || '').toLowerCase().includes(query));
    });

    document.getElementById('fy-count').textContent = `${rows.length} shown`;

    if (rows.length === 0) {
        grid.innerHTML = firstYearStudents.length === 0
            ? '<p class="empty-note">No first-year records yet. Volunteers add them at <b>/intake</b>.</p>'
            : '<p class="empty-note">Nothing matches that search.</p>';
        return;
    }

    grid.innerHTML = rows.map(s => {
        const missing = s.missing || [];
        const flags = missing.length
            ? missing.map(f => `<span class="flag">no ${escapeHtml(FIELD_LABELS[f] || f)}</span>`).join('')
            : '<span class="flag ok">complete</span>';

        const avatar = s.photo_thumb
            ? `<img class="entry-photo" src="${escapeHtml(s.photo_thumb)}" alt="">`
            : `<div class="entry-photo avatar-initial">${escapeHtml((s.name || '?').charAt(0).toUpperCase())}</div>`;

        return `
            <div class="entry-card fy-card" data-fy-usn="${escapeHtml(s.usn || '')}" style="cursor:pointer;">
                ${avatar}
                <div class="entry-body">
                    <p class="entry-name">${escapeHtml(s.name || 'Unknown')}</p>
                    <span class="entry-usn">${escapeHtml(s.usn || '')}</span>
                    <div class="entry-flags">${
                        s.batch
                            ? `<span class="flag ok">${escapeHtml(s.batch + (s.section ? ' ' + s.section : ''))}</span>`
                            : '<span class="flag">no batch</span>'
                    }${flags}</div>
                    <div class="fy-added-by">added by ${escapeHtml(s.added_by_name || s.added_by || 'unknown')}</div>
                </div>
            </div>`;
    }).join('');
}

document.getElementById('fy-search').addEventListener('input', renderFirstYear);
document.getElementById('fy-filter').addEventListener('change', renderFirstYear);
document.getElementById('fy-refresh').addEventListener('click', loadFirstYear);

// The list carries thumbnails only, so the full-quality photo is fetched when a
// card is actually opened.
document.getElementById('fy-summary').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-fy-chip]');
    if (!chip) return;

    const next = { type: chip.dataset.fyChip, value: chip.dataset.fyValue };
    const same = fyChipFilter?.type === next.type && fyChipFilter.value === next.value;
    fyChipFilter = same ? null : next;

    renderFirstYearSummary();
    renderFirstYear();
});

document.getElementById('fy-grid').addEventListener('click', async (e) => {
    const card = e.target.closest('[data-fy-usn]');
    if (!card) return;

    const usn = card.dataset.fyUsn;
    const token = localStorage.getItem('adminToken');

    try {
        const res = await fetch(`/api/admin/first-year/${encodeURIComponent(usn)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401 || res.status === 403) return logout();

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load');

        openFirstYearModal(data.student);
    } catch (err) {
        console.error('First year fetch failed:', err);
        showMessage(err.message, true);
    }
});

function openFirstYearModal(s) {
    const portrait = s.photo
        ? `<img src="${escapeHtml(s.photo)}" alt="" class="pc-portrait">`
        : `<div class="pc-portrait pc-portrait-fallback">${escapeHtml((s.name || '?').charAt(0).toUpperCase())}</div>`;

    const link = (url, label) => url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="pc-link">${label}</a>`
        : '';

    const row = (label, value, cls = '') => `
        <div class="pc-row">
            <span class="pc-label">${label}</span>
            <span class="pc-value ${cls}">${escapeHtml(value) || 'Not set'}</span>
        </div>`;

    modalBody.innerHTML = `
        <div class="profile-card">
            <div class="pc-hero">
                ${portrait}
                <div class="pc-ident">
                    <h2 class="pc-name">${escapeHtml(s.name || 'Unknown')}</h2>
                    <div class="pc-usn">${escapeHtml(s.usn || '')}</div>
                    <div class="pc-chips">
                        <span class="pc-chip">First year · 2030</span>
                        ${s.blood_group ? `<span class="pc-chip pc-chip-blood">${escapeHtml(s.blood_group)}</span>` : ''}
                        ${s.gender ? `<span class="pc-chip">${escapeHtml(s.gender)}</span>` : ''}
                    </div>
                    <div class="pc-actions">
                        ${link(s.linkedin, 'LinkedIn')}
                        ${link(s.github, 'GitHub')}
                    </div>
                </div>
            </div>

            <div class="pc-details">
                ${row('Birthday', s.birthday)}
                ${row('Mobile', s.mobile_number, 'pc-mono')}
                ${row('Email', s.email, 'pc-mono pc-wrap')}
                ${row('College email', s.institutional_email, 'pc-mono pc-wrap')}
                ${row('Batch', s.batch ? s.batch + (s.section ? ' ' + s.section : '') : 'Not on the official list')}
                ${row('Added by', s.added_by_name || s.added_by)}
                ${row('Added on', String(s.createdAt || '').slice(0, 10))}
            </div>

            <div class="pc-danger">
                <button type="button" class="action-btn danger" data-fy-delete="${escapeHtml(s.usn || '')}">
                    Delete this record
                </button>
                <span class="field-hint">Volunteers cannot delete. This is the only way a record is removed.</span>
            </div>
        </div>`;

    studentModal.classList.remove('hidden');
}

modalBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-fy-delete]');
    if (!btn) return;

    const usn = btn.dataset.fyDelete;
    if (!confirm(`Delete the first-year record ${usn}? This cannot be undone.`)) return;

    btn.disabled = true;
    btn.textContent = 'Deleting…';

    try {
        const res = await fetch(`/api/admin/first-year/${encodeURIComponent(usn)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('adminToken')}` }
        });
        if (res.status === 401 || res.status === 403) return logout();

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Delete failed');

        studentModal.classList.add('hidden');
        firstYearStudents = firstYearStudents.filter(s => s.usn !== usn);
        renderFirstYearSummary();
        renderFirstYear();
        showMessage(`Deleted ${usn}`);
    } catch (err) {
        console.error('First year delete failed:', err);
        btn.disabled = false;
        btn.textContent = 'Delete this record';
        showMessage(err.message, true);
    }
});
