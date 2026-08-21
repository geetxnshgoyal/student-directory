const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

try {
    require('dotenv').config();
} catch (e) {}

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const EXPORT_DIR = path.join(__dirname, '..', 'exports');

async function generateExcel() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!projectId || !clientEmail || !privateKey) {
        console.error('Missing Firebase credentials in .env');
        process.exit(1);
    }

    if (!getApps().length) {
        initializeApp({
            credential: cert({ projectId, clientEmail, privateKey: privateKey.replaceAll('\\n', '\n') })
        });
    }

    const db = getFirestore();
    const snapshot = await db.collection('students').get();

    // Map and filter active students only
    const allStudents = snapshot.docs.map(doc => {
        const data = doc.data() || {};
        return {
            usn: data.usn || doc.id,
            name: data.name || '',
            batch: data.batch || (data.academic_year ? `Batch ${data.academic_year}` : 'Unknown'),
            gender: data.gender || 'Unknown',
            status: data.status || 'active',
            year: data.year || '',
            institutional_email: data.institutional_email || '',
            email: data.email || '',
            mobile_number: data.mobile_number || '',
            birthday: data.birthday || '',
            blood_group: data.blood_group || '',
            github: data.github || '',
            linkedin: data.linkedin || ''
        };
    });

    const activeStudents = allStudents.filter(s => s.status !== 'left' && s.status !== 'inactive');
    
    // Sort students by name
    activeStudents.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`Total records in DB: ${allStudents.length}`);
    console.log(`Total active students: ${activeStudents.length}`);

    // Helper to format student object for Excel row
    function formatStudentRow(s, index) {
        return {
            'S.No': index + 1,
            'USN': s.usn,
            'Name': s.name,
            'Batch': s.batch,
            'Gender': s.gender.charAt(0).toUpperCase() + s.gender.slice(1).toLowerCase(),
            'Mobile Number': s.mobile_number,
            'Institutional Email': s.institutional_email,
            'Personal Email': s.email,
            'Birthday': s.birthday,
            'Blood Group': s.blood_group,
            'Year': s.year,
            'GitHub': s.github,
            'LinkedIn': s.linkedin
        };
    }

    // Split into groups
    const b1Boys = activeStudents.filter(s => s.batch.toLowerCase().includes('1') && s.gender.toLowerCase() === 'male');
    const b1Girls = activeStudents.filter(s => s.batch.toLowerCase().includes('1') && s.gender.toLowerCase() === 'female');
    const b2Boys = activeStudents.filter(s => s.batch.toLowerCase().includes('2') && s.gender.toLowerCase() === 'male');
    const b2Girls = activeStudents.filter(s => s.batch.toLowerCase().includes('2') && s.gender.toLowerCase() === 'female');

    console.log(`Batch 1 Boys: ${b1Boys.length}`);
    console.log(`Batch 1 Girls: ${b1Girls.length}`);
    console.log(`Batch 2 Boys: ${b2Boys.length}`);
    console.log(`Batch 2 Girls: ${b2Girls.length}`);

    fs.mkdirSync(EXPORT_DIR, { recursive: true });

    // 1. Create Comprehensive Master Workbook with All Sheets
    const masterWb = XLSX.utils.book_new();

    // Summary Sheet
    const summaryData = [
        { 'Category': 'Batch 1 - Boys', 'Active Count': b1Boys.length },
        { 'Category': 'Batch 1 - Girls', 'Active Count': b1Girls.length },
        { 'Category': 'Batch 1 - Total', 'Active Count': b1Boys.length + b1Girls.length },
        { 'Category': 'Batch 2 - Boys', 'Active Count': b2Boys.length },
        { 'Category': 'Batch 2 - Girls', 'Active Count': b2Girls.length },
        { 'Category': 'Batch 2 - Total', 'Active Count': b2Boys.length + b2Girls.length },
        { 'Category': 'Total Active Boys', 'Active Count': b1Boys.length + b2Boys.length },
        { 'Category': 'Total Active Girls', 'Active Count': b1Girls.length + b2Girls.length },
        { 'Category': 'Grand Total Active Students', 'Active Count': activeStudents.length }
    ];
    const summaryWs = XLSX.utils.json_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(masterWb, summaryWs, 'Summary');

    // Add batch/gender sheets
    const sheets = [
        { name: 'Batch 1 - Boys', data: b1Boys },
        { name: 'Batch 1 - Girls', data: b1Girls },
        { name: 'Batch 2 - Boys', data: b2Boys },
        { name: 'Batch 2 - Girls', data: b2Girls },
        { name: 'All Active Boys', data: activeStudents.filter(s => s.gender.toLowerCase() === 'male') },
        { name: 'All Active Girls', data: activeStudents.filter(s => s.gender.toLowerCase() === 'female') }
    ];

    sheets.forEach(({ name, data }) => {
        const ws = XLSX.utils.json_to_sheet(data.map(formatStudentRow));
        // Set column widths
        ws['!cols'] = [
            { wch: 6 },  // S.No
            { wch: 14 }, // USN
            { wch: 25 }, // Name
            { wch: 10 }, // Batch
            { wch: 10 }, // Gender
            { wch: 16 }, // Mobile
            { wch: 32 }, // Inst Email
            { wch: 28 }, // Personal Email
            { wch: 14 }, // Birthday
            { wch: 12 }, // Blood Group
            { wch: 6 },  // Year
            { wch: 30 }, // GitHub
            { wch: 35 }  // LinkedIn
        ];
        XLSX.utils.book_append_sheet(masterWb, ws, name);
    });

    const masterPath = path.join(EXPORT_DIR, 'active_students_batch_and_gender_wise.xlsx');
    XLSX.writeFile(masterWb, masterPath);
    console.log(`Generated Master Excel: ${masterPath}`);

    // 2. Also generate individual separate Excel files for each batch & gender
    const individualFiles = [
        { filename: 'Batch_1_Boys_Active.xlsx', sheetName: 'Batch 1 Boys', data: b1Boys },
        { filename: 'Batch_1_Girls_Active.xlsx', sheetName: 'Batch 1 Girls', data: b1Girls },
        { filename: 'Batch_2_Boys_Active.xlsx', sheetName: 'Batch 2 Boys', data: b2Boys },
        { filename: 'Batch_2_Girls_Active.xlsx', sheetName: 'Batch 2 Girls', data: b2Girls }
    ];

    for (const item of individualFiles) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(item.data.map(formatStudentRow));
        ws['!cols'] = [
            { wch: 6 },
            { wch: 14 },
            { wch: 25 },
            { wch: 10 },
            { wch: 10 },
            { wch: 16 },
            { wch: 32 },
            { wch: 28 },
            { wch: 14 },
            { wch: 12 },
            { wch: 6 },
            { wch: 30 },
            { wch: 35 }
        ];
        XLSX.utils.book_append_sheet(wb, ws, item.sheetName);
        const itemPath = path.join(EXPORT_DIR, item.filename);
        XLSX.writeFile(wb, itemPath);
        console.log(`Generated: ${itemPath}`);
    }

    console.log('All Excel files generated successfully!');
}

generateExcel().catch(err => {
    console.error('Error generating Excel files:', err);
    process.exit(1);
});
