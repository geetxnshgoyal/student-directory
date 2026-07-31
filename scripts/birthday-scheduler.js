const { FieldValue } = require('firebase-admin/firestore');

const RUN_COLLECTION = 'birthday_runs';

function isAlreadyExists(err) {
    // gRPC ALREADY_EXISTS
    return err?.code === 6 || /ALREADY_EXISTS/i.test(err?.message || '');
}

/**
 * Claim today's run. create() fails when the document already exists, so exactly
 * one invocation wins the day even if the Vercel cron, a cold start and a manual
 * trigger all fire at once.
 */
async function claimBirthdayRun(firestore, todayStr) {
    const ref = firestore.collection(RUN_COLLECTION).doc(todayStr);
    try {
        await ref.create({
            date: todayStr,
            startedAt: FieldValue.serverTimestamp(),
            wishesSent: [],
            reminderSent: false
        });
        return { ref, fresh: true };
    } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        return { ref, fresh: false };
    }
}

/**
 * Reserve one student's wish inside a transaction, so two concurrent runs can
 * never both decide to email the same person.
 */
async function reserveWish(firestore, ref, usn) {
    return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const sent = snap.data()?.wishesSent || [];
        if (sent.includes(usn)) return false;
        tx.update(ref, { wishesSent: FieldValue.arrayUnion(usn) });
        return true;
    });
}

async function reserveReminder(firestore, ref) {
    return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.data()?.reminderSent) return false;
        tx.update(ref, { reminderSent: true });
        return true;
    });
}

function getTodayDDMM(date = new Date()) {
    const kolkataTime = date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const d = new Date(kolkataTime);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}-${month}`;
}

function getTodayDateString(date = new Date()) {
    const kolkataTime = date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const d = new Date(kolkataTime);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
}

async function sendBirthdayWishEmail(mailer, student) {
    const email = (student.institutional_email && student.institutional_email.trim() !== '')
        ? student.institutional_email.trim()
        : (student.email ? student.email.trim() : null);
    if (!email) return;

    let hasPhoto = false;
    let photoCid = '';
    const attachments = [];

    // Parse base64 photo and add as inline CID attachment for maximum compatibility
    if (student.photo && student.photo.startsWith('data:image')) {
        try {
            hasPhoto = true;
            photoCid = `birthday_profile_${student.usn}`;
            const base64Data = student.photo.split(';base64,').pop();
            attachments.push({
                filename: 'profile.jpg',
                content: Buffer.from(base64Data, 'base64'),
                cid: photoCid
            });
        } catch (e) {
            console.error('Failed to parse student photo for email attachment:', e);
            hasPhoto = false;
        }
    }

    const photoHtml = hasPhoto
        ? `<img src="cid:${photoCid}" alt="" width="104" height="104" style="width:104px;height:104px;border-radius:50%;object-fit:cover;border:3px solid #ffffff;display:block;margin:0 auto;">`
        : `<div style="width:104px;height:104px;border-radius:50%;background:rgba(255,255,255,0.18);border:3px solid #ffffff;margin:0 auto;text-align:center;line-height:104px;font-size:42px;font-weight:700;color:#ffffff;">${student.name ? student.name.charAt(0).toUpperCase() : '?'}</div>`;

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Happy Birthday</title></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E2E5EA;border-radius:16px;overflow:hidden;">

        <tr><td style="background:#1F4C7A;padding:36px 32px 30px 32px;text-align:center;">
          ${photoHtml}
          <div style="color:rgba(255,255,255,0.75);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:18px 0 8px 0;">Happy birthday</div>
          <div style="color:#ffffff;font-size:27px;font-weight:700;line-height:1.2;">${student.name}</div>
        </td></tr>

        <tr><td style="padding:30px 32px 8px 32px;" align="center">
          <div style="font-size:16px;color:#171A1F;line-height:1.6;font-weight:600;margin-bottom:10px;">
            Wishing you a brilliant year ahead.
          </div>
          <div style="font-size:14.5px;color:#545A66;line-height:1.65;">
            From everyone at NST Bangalore. Enjoy the day, and thanks for
            being part of what we are building here.
          </div>
        </td></tr>

        <tr><td style="padding:26px 32px 32px 32px;" align="center">
          <div style="font-size:13px;color:#838A96;">Have a great one.</div>
        </td></tr>

        <tr><td style="background:#EDEFF3;padding:18px 32px;text-align:center;border-top:1px solid #E2E5EA;">
          <div style="font-size:11px;color:#838A96;line-height:1.6;">
            Sent by the NST Bangalore Student Committee.
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>
    `;

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: `🎂 Happy Birthday, ${student.name}! ✨`,
        html,
        attachments
    });
    console.log(`📩 Birthday wish email successfully sent to ${student.name} (${email})`);
}

async function sendClassmateBirthdayReminder(mailer, birthdayStudents, allStudents) {
    const birthdayUsns = new Set(birthdayStudents.map(s => s.usn));
    const recipients = [];
    allStudents.forEach(s => {
        if (birthdayUsns.has(s.usn)) return;
        const email = (s.institutional_email && s.institutional_email.trim() !== '')
            ? s.institutional_email.trim()
            : (s.email ? s.email.trim() : null);
        if (email) {
            recipients.push(email);
        }
    });

    if (recipients.length === 0) {
        console.log('⚠️ Classmate reminder: No recipients found to email.');
        return;
    }

    // Build Circular Photos & Names HTML for the Banner
    let photosHtml = '';
    const attachments = [];

    birthdayStudents.forEach((student, index) => {
        let hasPhoto = false;
        let photoCid = '';
        if (student.photo && student.photo.startsWith('data:image')) {
            try {
                hasPhoto = true;
                photoCid = `reminder_profile_${student.usn}_${index}`;
                const base64Data = student.photo.split(';base64,').pop();
                attachments.push({
                    filename: `profile_${index}.jpg`,
                    content: Buffer.from(base64Data, 'base64'),
                    cid: photoCid
                });
            } catch (e) {
                hasPhoto = false;
            }
        }

        const imgHtml = hasPhoto
            ? `<img src="cid:${photoCid}" alt="" width="84" height="84" style="width:84px;height:84px;border-radius:50%;object-fit:cover;border:3px solid #ffffff;display:block;margin:0 auto;">`
            : `<div style="width:84px;height:84px;border-radius:50%;background:rgba(255,255,255,0.18);border:3px solid #ffffff;text-align:center;line-height:84px;font-size:34px;font-weight:700;color:#ffffff;margin:0 auto;">${student.name ? student.name.charAt(0).toUpperCase() : '?'}</div>`;

        photosHtml += `
            <div style="display:inline-block;text-align:center;margin:10px 14px;vertical-align:top;">
                ${imgHtml}
                <div style="color:#ffffff;font-size:14px;font-weight:600;margin-top:10px;">${student.name}</div>
            </div>
        `;
    });

    // Formulate clean inline list names string for the email subject and copy
    let namesStr = '';
    if (birthdayStudents.length === 1) {
        namesStr = birthdayStudents[0].name;
    } else if (birthdayStudents.length === 2) {
        namesStr = `${birthdayStudents[0].name} and ${birthdayStudents[1].name}`;
    } else {
        const names = birthdayStudents.map(s => s.name);
        namesStr = `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
    }

    const isPlural = birthdayStudents.length > 1;

    // Generate large body button if it is a single birthday
    let mainWhatsappButtonHtml = '';
    if (!isPlural) {
        const student = birthdayStudents[0];
        const rawMobile = student.mobile_number;
        if (rawMobile) {
            let cleaned = String(rawMobile).replace(/\D/g, '');
            if (cleaned.length === 10) {
                cleaned = '91' + cleaned;
            }
            if (cleaned) {
                const text = encodeURIComponent("Happy Birthday, " + student.name + "!");
                const waLink = `https://wa.me/${cleaned}?text=${text}`;
                mainWhatsappButtonHtml = `
                    <div style="margin-top:26px;">
                        <a href="${waLink}" style="display:inline-block;background:#25D366;color:#ffffff;padding:15px 34px;border-radius:10px;font-weight:700;font-size:16px;text-decoration:none;">
                            Wish them on WhatsApp
                        </a>
                    </div>
                `;
            }
        }
    }

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Special day</title></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E2E5EA;border-radius:16px;overflow:hidden;">

        <tr><td style="background:#2E6B5E;padding:34px 28px 28px 28px;text-align:center;">
          <div style="color:rgba(255,255,255,0.75);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:18px;">
            ${isPlural ? "Today's birthdays" : "Today's birthday"}
          </div>
          ${photosHtml}
        </td></tr>

        <tr><td style="padding:30px 32px 8px 32px;" align="center">
          <div style="font-size:17px;color:#171A1F;line-height:1.5;font-weight:600;margin-bottom:10px;">
            ${namesStr} ${isPlural ? 'are' : 'is'} celebrating today.
          </div>
          <div style="font-size:14.5px;color:#545A66;line-height:1.65;">
            Take a second to say happy birthday. It costs nothing and it
            genuinely makes someone's day.
          </div>
          ${mainWhatsappButtonHtml}
        </td></tr>

        <tr><td style="background:#EDEFF3;padding:18px 32px;text-align:center;border-top:1px solid #E2E5EA;margin-top:20px;">
          <div style="font-size:11px;color:#838A96;line-height:1.6;">
            Sent to the batch by the NST Bangalore Student Committee.
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>
    `;

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: process.env.SMTP_FROM || process.env.SMTP_USER,
        bcc: recipients,
        subject: `🎉 Today is ${namesStr}'s Special Day! 🎂`,
        html,
        attachments
    });
    console.log(`📩 Birthday reminder for ${namesStr} successfully sent to ${recipients.length} classmates in Bcc.`);
}

async function checkBirthdaysAndSendEmails(firestore, mailer, isStartup = false) {
    if (!firestore || !mailer) {
        console.warn('⚠️ Scheduler: Firestore or Mailer offline. Skipping check.');
        return;
    }

    try {
        const todayStr = getTodayDateString();
        console.log(`🎂 Birthday check triggered: ${todayStr} (Startup: ${isStartup})`);

        // Claim the day up front. Every send below is reserved individually, so
        // a second run today finds nothing left to do instead of re-sending.
        const { ref: runRef, fresh } = await claimBirthdayRun(firestore, todayStr);
        if (!fresh) {
            console.log(`🎂 Today's run (${todayStr}) is already claimed; checking for anything unsent.`);
        }

        const snapshot = await firestore.collection('students').get();
        const students = [];
        snapshot.forEach(doc => {
            const record = doc.data() || {};
            if (!record.usn) record.usn = doc.id;
            students.push(record);
        });

        const todayDDMM = getTodayDDMM();
        const todayBirthdays = [];

        for (const student of students) {
            if (student.status === 'left') continue;
            
            const parts = (student.birthday || '').split('-');
            if (parts.length >= 2) {
                const bdayDDMM = `${parts[0]}-${parts[1]}`;
                if (bdayDDMM === todayDDMM) {
                    todayBirthdays.push(student);
                }
            }
        }

        if (todayBirthdays.length === 0) {
            console.log(`🎂 Checked birthdays. No student birthdays match today (${todayDDMM}).`);
            await runRef.set({ completedAt: FieldValue.serverTimestamp(), sentToCount: 0 }, { merge: true });
            return;
        }

        console.log(`🎉 Birthdays found for today (${todayDDMM}): ${todayBirthdays.map(s => s.name).join(', ')}`);

        let sent = 0;
        for (const birthdayStudent of todayBirthdays) {
            const reserved = await reserveWish(firestore, runRef, birthdayStudent.usn);
            if (!reserved) {
                console.log(`🎂 Wish for ${birthdayStudent.name} already sent today. Skipping.`);
                continue;
            }
            try {
                await sendBirthdayWishEmail(mailer, birthdayStudent);
                sent += 1;
            } catch (err) {
                // Deliberately keep the reservation. A throw does not prove the
                // message was not delivered - SMTP may have accepted it before the
                // connection dropped - so retrying risks a duplicate. Record it
                // and let a human decide instead.
                await runRef.update({ failed: FieldValue.arrayUnion(birthdayStudent.usn) });
                console.error(
                    `❌ Birthday wish to ${birthdayStudent.name} (${birthdayStudent.usn}) failed. ` +
                    `NOT retried automatically - resend by hand if it truly did not arrive.`, err
                );
            }
        }

        if (await reserveReminder(firestore, runRef)) {
            try {
                await sendClassmateBirthdayReminder(mailer, todayBirthdays, students);
            } catch (err) {
                await runRef.update({ reminderFailed: true });
                console.error(
                    '❌ Classmate reminder failed. NOT retried automatically - a retry could ' +
                    'double-send to the whole class.', err
                );
            }
        } else {
            console.log('🎂 Classmate reminder already sent today. Skipping.');
        }

        await runRef.set({
            completedAt: FieldValue.serverTimestamp(),
            sentToCount: todayBirthdays.length
        }, { merge: true });
        console.log(`🎉 Birthday run for ${todayStr} finished. ${sent} new wish email(s) sent.`);
    } catch (err) {
        console.error('❌ Scheduler: Error running birthday checklist:', err);
    }
}

// Land just after the date rolls over, never a fraction before it: firing early
// would compute yesterday's date and reschedule with a near-zero delay.
const MIDNIGHT_BUFFER_MS = 30 * 1000;

let schedulerRegistered = false;

function startBirthdayScheduler(firestore, mailer) {
    if (!firestore || !mailer) {
        console.error('❌ Scheduler: Cannot start birthday scheduler. Firestore or Mailer is missing.');
        return;
    }

    // On Vercel this module is re-imported on every cold start, so an in-process
    // timer would fire the check over and over. The platform cron in vercel.json
    // drives /api/cron/birthday instead.
    if (process.env.VERCEL) {
        console.log('🎂 Birthday scheduler: skipped on Vercel; the platform cron drives it.');
        return;
    }

    if (schedulerRegistered) {
        console.log('🎂 Birthday scheduler already registered in this process. Ignoring.');
        return;
    }
    schedulerRegistered = true;

    const msUntilNextIstMidnight = () => {
        const now = new Date();
        // toLocaleString drops milliseconds, so put them back before measuring.
        const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        istNow.setMilliseconds(now.getMilliseconds());

        const nextMidnight = new Date(istNow);
        nextMidnight.setDate(nextMidnight.getDate() + 1);
        nextMidnight.setHours(0, 0, 0, 0);

        return (nextMidnight.getTime() - istNow.getTime()) + MIDNIGHT_BUFFER_MS;
    };

    const scheduleNextRun = () => {
        const delay = msUntilNextIstMidnight();
        const at = new Date(Date.now() + delay)
            .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
        console.log(`🎂 Birthday scheduler: next check in ${(delay / 3600000).toFixed(2)}h, at ${at} IST`);

        const timer = setTimeout(async () => {
            await checkBirthdaysAndSendEmails(firestore, mailer, false);
            scheduleNextRun();
        }, delay);
        // Don't hold the process open purely for this timer.
        if (typeof timer.unref === 'function') timer.unref();
    };

    // Deliberately no check on boot. With `npm run dev` (nodemon) every file save
    // restarts the process, and a start-up check would run the whole thing again.
    if (process.env.BIRTHDAY_RUN_ON_START === '1') {
        console.log('🎂 Birthday scheduler: running a catch-up check now (BIRTHDAY_RUN_ON_START=1).');
        checkBirthdaysAndSendEmails(firestore, mailer, true);
    } else {
        console.log('🎂 Birthday scheduler registered. No check on start. Set BIRTHDAY_RUN_ON_START=1 to force one.');
    }

    scheduleNextRun();
}

module.exports = {
    startBirthdayScheduler,
    checkBirthdaysAndSendEmails
};
