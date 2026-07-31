
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
                    <p>${s.usn || 'No USN'}</p>
                    <div style="font-size: 0.8rem; color: var(--primary-500); margin-top: 4px;">
                        ${s.email || 'No Email'}
                    </div>
                    <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
                        ${getMobileNumber(s) || 'No Mobile'}
                    </div>
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

        modalBody.innerHTML = `
                <div class="modal-profile-header">
                    ${avatarMarkup(s, { size: 100, className: 'modal-photo' })}
                    <h2 style="margin: 10px 0 5px;">${s.name || 'Unknown'}</h2>
                    <p style="color: var(--primary-600); margin:0;">${s.usn}</p>
                </div>
                
                <div class="modal-detail-row"><span class="modal-label">Batch</span> <span class="modal-value">${s.batch || '-'}</span></div>
                <div class="modal-detail-row"><span class="modal-label">Email</span> <span class="modal-value">${s.email || '-'}</span></div>
                <div class="modal-detail-row"><span class="modal-label">Mobile</span> <span class="modal-value">${getMobileNumber(s) || '-'}</span></div>
                <div class="modal-detail-row"><span class="modal-label">Institutional Email</span> <span class="modal-value">${s.institutional_email || '-'}</span></div>
                <div class="modal-detail-row"><span class="modal-label">Gender</span> <span class="modal-value">${s.gender || '-'}</span></div>
                <div class="modal-detail-row"><span class="modal-label">Birthday</span> <span class="modal-value">${s.birthday || '-'}</span></div>
                <div class="modal-detail-row"><span class="modal-label">Blood Group</span> <span class="modal-value" style="font-weight:600; color:var(--primary-600);">${s.blood_group || '-'}</span></div>
                
                <div class="modal-detail-row">
                    <span class="modal-label">LinkedIn</span> 
                    <span class="modal-value">${s.linkedin ? `<a href="${s.linkedin}" target="_blank" style="color:var(--primary-500)">View Profile</a>` : '-'}</span>
                </div>
                <div class="modal-detail-row" style="border-bottom: none;">
                    <span class="modal-label">GitHub</span> 
                    <span class="modal-value">${s.github ? `<a href="${s.github}" target="_blank" style="color:var(--primary-500)">View Profile</a>` : '-'}</span>
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
