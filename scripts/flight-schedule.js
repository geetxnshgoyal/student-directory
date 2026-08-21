/**
 * The timetable Skyscanner will not tell you about.
 *
 * The board only carries today and tomorrow, but most students post a trip days
 * or weeks ahead. Airline schedules barely move inside a season, so instead of
 * asking for a date nobody will answer, we watch the board every night and learn
 * the pattern: 6E873 lands from Delhi at 11:10, and it has done so every day we
 * have looked.
 *
 * A schedule answer is an ESTIMATE and is always labelled as one. It carries no
 * gate, no terminal, no live status - only the repeating scheduled time. The
 * moment the flight enters the real 48 hour window, the live board takes over
 * and the estimate is never consulted again.
 *
 * Two honest limits are baked into the confidence rules below:
 *
 *   1. Not every flight is daily. Star Air, Fly91 and most long haul rotations
 *      run a few days a week, so one night's snapshot cannot tell you frequency.
 *      Until we have watched a full week, absence of a weekday means "we have
 *      not looked yet", not "it does not fly".
 *   2. Schedules do move, at the IATA season change in late March and late
 *      October and occasionally in between. An observation that has not been
 *      re-confirmed in three weeks is treated as stale and dropped.
 */

const SCHEDULE_COLLECTION = 'flight_schedule';

// Below this many distinct days observed we will happily offer a time, but we
// will not claim a flight does NOT operate on a given weekday.
const CONFIDENT_AFTER_DAYS = 7;

// An entry nobody has seen for this long has probably been retimed or retired.
const STALE_AFTER_DAYS = 21;

const IST = 'Asia/Kolkata';

function istParts(ms) {
    // en-CA gives YYYY-MM-DD, which sorts and compares without further work.
    const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(ms));
    const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(ms));
    // getUTCDay on the shifted date gives the Bangalore weekday without pulling
    // in a date library.
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return { date, time, weekday };
}

function daysBetween(fromDate, toDate) {
    const a = Date.parse(`${fromDate}T00:00:00Z`);
    const b = Date.parse(`${toDate}T00:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
}

function scheduleId(number, direction) {
    return `${String(number || '').toUpperCase()}_${direction === 'departure' ? 'D' : 'A'}`;
}

/**
 * Fold one day's board into the store. Safe to run twice for the same date:
 * observations are keyed by date, so a repeat run corrects rather than inflates.
 */
async function recordBoard(store, flights, { now = Date.now() } = {}) {
    let written = 0;
    let skipped = 0;

    for (const flight of flights) {
        const outbound = flight.direction === 'departure';
        const scheduled = outbound ? flight.scheduledDeparture : flight.scheduledArrival;
        if (!Number.isFinite(scheduled) || !flight.number) {
            skipped += 1;
            continue;
        }

        const { date, time, weekday } = istParts(scheduled);
        const id = scheduleId(flight.number, flight.direction);
        const existing = (await store.get(id)) || null;

        // Seen on this date already? Overwrite that day's observation instead of
        // counting it twice, so a retried cron run cannot skew the pattern.
        const seenDates = new Set(existing?.seenDates || []);
        const alreadySeen = seenDates.has(date);
        seenDates.add(date);

        const days = Array.isArray(existing?.days) && existing.days.length === 7
            ? [...existing.days]
            : [0, 0, 0, 0, 0, 0, 0];
        if (!alreadySeen) days[weekday] += 1;

        await store.set(id, {
            number: flight.number,
            direction: flight.direction,
            airline: flight.airline || existing?.airline || null,
            origin: flight.origin,
            destination: flight.destination,
            // The most recent scheduled time wins. A retimed flight should
            // converge on its new time rather than average across the change.
            localTime: time,
            terminal: flight.terminal || existing?.terminal || null,
            days,
            // Keep only the recent window; this is a rolling pattern, not a log.
            seenDates: [...seenDates].sort().slice(-STALE_AFTER_DAYS),
            firstSeen: existing?.firstSeen || date,
            lastSeen: date,
            updatedAt: now
        });
        written += 1;
    }

    return { written, skipped };
}

/**
 * What we believe about this flight on a date the live board cannot reach.
 * Returns null when we have never seen it, or when what we knew has gone stale.
 */
async function scheduleLookup(store, number, date, direction = 'Arrival') {
    const outbound = String(direction).toLowerCase() === 'departure';
    const record = await store.get(scheduleId(number, outbound ? 'departure' : 'arrival'));
    if (!record || !record.localTime) return null;

    const age = daysBetween(record.lastSeen, date);
    // Only judge staleness for dates after the last sighting. Asking about a
    // date in the past is not the record's fault.
    if (age !== null && age > STALE_AFTER_DAYS) return null;

    const scheduled = new Date(`${date}T${record.localTime}:00+05:30`).getTime();
    if (Number.isNaN(scheduled)) return null;

    const observedDays = (record.seenDates || []).length;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const fliesThisWeekday = (record.days || [])[weekday] > 0;
    const confident = observedDays >= CONFIDENT_AFTER_DAYS;

    // Once we have watched a full week, a weekday we have never seen it operate
    // on is a real answer: it does not fly that day.
    if (confident && !fliesThisWeekday) return null;

    return {
        number: record.number,
        airline: record.airline,
        date,
        direction: outbound ? 'departure' : 'arrival',
        origin: record.origin,
        destination: record.destination,
        scheduledDeparture: outbound ? scheduled : null,
        estimatedDeparture: null,
        scheduledArrival: outbound ? null : scheduled,
        estimatedArrival: null,
        actualArrival: null,
        status: 'scheduled',
        statusLabel: null,
        terminal: record.terminal || null,
        belt: null,
        gate: null,
        // The flags the UI needs to avoid lying to a student. There is no live
        // data behind this time and it may be a few minutes out.
        estimated: true,
        source: 'schedule',
        confidence: confident ? 'high' : 'low',
        observedDays,
        lastSeen: record.lastSeen
    };
}

/** Drop entries nobody has seen in weeks, so a retired flight stops answering. */
async function pruneSchedule(store, { today, now = Date.now() } = {}) {
    const reference = today || istParts(now).date;
    const all = await store.list();
    let removed = 0;
    for (const record of all) {
        const age = daysBetween(record.lastSeen, reference);
        if (age !== null && age > STALE_AFTER_DAYS) {
            await store.delete(record.id);
            removed += 1;
        }
    }
    return { removed };
}

module.exports = {
    SCHEDULE_COLLECTION,
    CONFIDENT_AFTER_DAYS,
    STALE_AFTER_DAYS,
    recordBoard,
    scheduleLookup,
    pruneSchedule,
    scheduleId,
    istParts
};
