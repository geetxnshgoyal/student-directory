/**
 * Flight data behind one interface.
 *
 * Every provider returns the same normalised shape, so swapping AeroDataBox for
 * AviationStack or FlightAware later is a change to this file only. The stub
 * runs offline with canned flights, which is what local dev and the tests use.
 *
 * We ask for exactly two things: scheduled times at lookup, and live status
 * inside the arrival window. No fares, no seat maps, no historical data.
 *
 *   {
 *     number, airline, date,
 *     origin:      { code, name },
 *     destination: { code, name },
 *     scheduledArrival, estimatedArrival, actualArrival,   // epoch ms or null
 *     status,      // scheduled | departed | landed | cancelled | diverted | unknown
 *     terminal,    // string or null
 *     belt         // string or null - frequently absent, never rely on it
 *   }
 */

const STATUSES = new Set(['scheduled', 'departed', 'landed', 'cancelled', 'diverted', 'unknown']);

// Students fly domestic Indian carriers almost without exception. Filtering to
// these keeps the route list short and readable; add a code to widen it.
// Vistara (UK) is deliberately absent: it merged into Air India in 2024.
const CARRIERS = {
    '6E': 'IndiGo',
    AI: 'Air India',
    IX: 'Air India Express',
    QP: 'Akasa Air'
};

const HOME_AIRPORT = 'BLR';

// Curated origins rather than an airport-search API call: these cover where the
// batch actually flies from, and the list stays predictable.
const ORIGIN_CITIES = [
    { code: 'DEL', city: 'Delhi' },
    { code: 'BOM', city: 'Mumbai' },
    { code: 'CCU', city: 'Kolkata' },
    { code: 'HYD', city: 'Hyderabad' },
    { code: 'MAA', city: 'Chennai' },
    { code: 'JAI', city: 'Jaipur' },
    { code: 'LKO', city: 'Lucknow' },
    { code: 'PAT', city: 'Patna' },
    { code: 'AMD', city: 'Ahmedabad' },
    { code: 'PNQ', city: 'Pune' },
    { code: 'GAU', city: 'Guwahati' },
    { code: 'BBI', city: 'Bhubaneswar' },
    { code: 'IXC', city: 'Chandigarh' },
    { code: 'COK', city: 'Kochi' },
    { code: 'RPR', city: 'Raipur' },
    { code: 'VNS', city: 'Varanasi' },
    { code: 'IDR', city: 'Indore' },
    { code: 'NAG', city: 'Nagpur' },
    { code: 'SXR', city: 'Srinagar' },
    { code: 'DED', city: 'Dehradun' }
];

function carrierOf(flightNumber) {
    const value = normaliseFlightNumber(flightNumber);
    // A greedy [A-Z0-9]{2,3} reads "6E505" as carrier "6E5", so prefer the
    // shortest prefix that is a designator we know, then fall back to lazy.
    for (const length of [2, 3]) {
        const code = value.slice(0, length);
        if (Object.hasOwn(CARRIERS, code) && /^\d{1,4}$/.test(value.slice(length))) return code;
    }
    const match = value.match(/^([A-Z0-9]{2,3}?)\d{1,4}$/);
    return match ? match[1] : null;
}

function isSupportedCarrier(flightNumber) {
    return Object.hasOwn(CARRIERS, carrierOf(flightNumber) || '');
}

function normaliseFlightNumber(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isValidFlightNumber(value) {
    // Two or three character carrier code, then one to four digits.
    return /^[A-Z0-9]{2,3}\d{1,4}$/.test(normaliseFlightNumber(value));
}

function isValidFlightDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime());
}

function toEpoch(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

/* ------------------------------------------------------------------ *
 * Stub: deterministic canned data, no network, no key.
 * ------------------------------------------------------------------ */

const STUB_FLIGHTS = {
    '6E2134': { airline: 'IndiGo', origin: ['JAI', 'Jaipur'], destination: ['BLR', 'Bengaluru'], arriveAt: '20:05', minutes: 145 },
    '6E505': { airline: 'IndiGo', origin: ['DEL', 'Delhi'], destination: ['BLR', 'Bengaluru'], arriveAt: '14:30', minutes: 170 },
    'AI803': { airline: 'Air India', origin: ['DEL', 'Delhi'], destination: ['BLR', 'Bengaluru'], arriveAt: '18:40', minutes: 165 },
    'QP1102': { airline: 'Akasa Air', origin: ['BOM', 'Mumbai'], destination: ['BLR', 'Bengaluru'], arriveAt: '09:15', minutes: 100 },
    // Vistara folded into Air India in 2024, so UK codes are retired. Kept as a
    // fixture purely to prove a dead carrier is filtered out of the route list.
    'UK864': { airline: 'Vistara (retired)', origin: ['BOM', 'Mumbai'], destination: ['BLR', 'Bengaluru'], arriveAt: '11:40', minutes: 100 },
    'IX1520': { airline: 'Air India Express', origin: ['CCU', 'Kolkata'], destination: ['BLR', 'Bengaluru'], arriveAt: '22:50', minutes: 175 }
};

function stubProvider() {
    return {
        name: 'stub',
        async searchArrivals(originCode, date) {
            const from = String(originCode || '').toUpperCase();
            const results = [];
            for (const [number, canned] of Object.entries(STUB_FLIGHTS)) {
                if (canned.origin[0] !== from) continue;
                if (!isSupportedCarrier(number)) continue;
                results.push({
                    number,
                    airline: canned.airline,
                    date,
                    origin: { code: canned.origin[0], name: canned.origin[1] },
                    destination: { code: canned.destination[0], name: canned.destination[1] },
                    scheduledArrival: new Date(`${date}T${canned.arriveAt}:00+05:30`).getTime(),
                    estimatedArrival: null,
                    actualArrival: null,
                    status: 'scheduled',
                    terminal: '1',
                    belt: null
                });
            }
            return results.sort((a, b) => a.scheduledArrival - b.scheduledArrival);
        },
        async lookup(flightNumber, date) {
            const key = normaliseFlightNumber(flightNumber);
            const canned = STUB_FLIGHTS[key];
            if (!canned) return null;

            // Times are Bangalore wall clock, same as everywhere else in the app.
            const scheduledArrival = new Date(`${date}T${canned.arriveAt}:00+05:30`).getTime();

            return {
                number: key,
                airline: canned.airline,
                date,
                origin: { code: canned.origin[0], name: canned.origin[1] },
                destination: { code: canned.destination[0], name: canned.destination[1] },
                scheduledArrival,
                estimatedArrival: null,
                actualArrival: null,
                status: 'scheduled',
                terminal: '1',
                belt: null
            };
        }
    };
}

/* ------------------------------------------------------------------ *
 * AeroDataBox via RapidAPI.
 * ------------------------------------------------------------------ */

const AERO_HOST = 'aerodatabox.p.rapidapi.com';

function mapAeroStatus(raw) {
    const value = String(raw || '').toLowerCase();
    if (value.includes('cancel')) return 'cancelled';
    if (value.includes('divert')) return 'diverted';
    if (value.includes('arriv') || value.includes('landed')) return 'landed';
    if (value.includes('depart') || value.includes('enroute') || value.includes('en route')) return 'departed';
    if (value.includes('expected') || value.includes('scheduled') || value.includes('unknown')) return 'scheduled';
    return STATUSES.has(value) ? value : 'unknown';
}

function aeroDataBoxProvider(apiKey, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
    async function getJson(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetchImpl(url, {
                headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': AERO_HOST },
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`flight lookup failed (${res.status})`);
        return res.json();
    }

    function fromArrivalLeg(leg, date) {
        const arrival = leg.arrival || {};
        const departure = leg.departure || {};
        return {
            number: normaliseFlightNumber(leg.number),
            airline: leg.airline?.name || CARRIERS[carrierOf(leg.number)] || null,
            date,
            origin: {
                code: departure.airport?.iata || null,
                name: departure.airport?.municipalityName || departure.airport?.name || null
            },
            destination: { code: HOME_AIRPORT, name: 'Bengaluru' },
            scheduledArrival: toEpoch(arrival.scheduledTime?.utc),
            estimatedArrival: toEpoch(arrival.predictedTime?.utc || arrival.revisedTime?.utc),
            actualArrival: toEpoch(arrival.actualTime?.utc || arrival.runwayTime?.utc),
            status: mapAeroStatus(leg.status),
            terminal: arrival.terminal || null,
            belt: arrival.baggageBelt || null
        };
    }

    return {
        name: 'aerodatabox',
        async searchArrivals(originCode, date) {
            const from = String(originCode || '').toUpperCase();
            // The airport feed caps each call at a 12 hour window, so a full day
            // is two calls. Only arrivals are requested.
            const windows = [[`${date}T00:00`, `${date}T11:59`], [`${date}T12:00`, `${date}T23:59`]];
            const legs = [];

            for (const [start, end] of windows) {
                const url = `https://${AERO_HOST}/flights/airports/iata/${HOME_AIRPORT}/${start}/${end}`
                    + '?withLeg=true&direction=Arrival&withCancelled=false'
                    + '&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false';
                const body = await getJson(url);
                if (body?.arrivals) legs.push(...body.arrivals);
            }

            return legs
                .filter(leg => (leg.departure?.airport?.iata || '').toUpperCase() === from)
                .filter(leg => isSupportedCarrier(leg.number))
                .map(leg => fromArrivalLeg(leg, date))
                .filter(flight => Number.isFinite(flight.scheduledArrival))
                .sort((a, b) => a.scheduledArrival - b.scheduledArrival);
        },
        async lookup(flightNumber, date) {
            const number = normaliseFlightNumber(flightNumber);
            const url = `https://${AERO_HOST}/flights/number/${number}/${date}`
                + '?withAircraftImage=false&withLocation=false';

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            let res;
            try {
                res = await fetchImpl(url, {
                    headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': AERO_HOST },
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timer);
            }

            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`flight lookup failed (${res.status})`);

            const body = await res.json();
            const leg = Array.isArray(body) ? body[0] : body;
            if (!leg || !leg.arrival) return null;

            const arrival = leg.arrival;
            const departure = leg.departure || {};

            return {
                number,
                airline: leg.airline?.name || null,
                date,
                origin: {
                    code: departure.airport?.iata || null,
                    name: departure.airport?.municipalityName || departure.airport?.name || null
                },
                destination: {
                    code: arrival.airport?.iata || null,
                    name: arrival.airport?.municipalityName || arrival.airport?.name || null
                },
                scheduledArrival: toEpoch(arrival.scheduledTime?.utc),
                estimatedArrival: toEpoch(arrival.predictedTime?.utc || arrival.revisedTime?.utc),
                actualArrival: toEpoch(arrival.actualTime?.utc || arrival.runwayTime?.utc),
                status: mapAeroStatus(leg.status),
                terminal: arrival.terminal || null,
                // Present only sometimes, and only for some airports. Display it
                // when it turns up; never build a notification on it.
                belt: arrival.baggageBelt || null
            };
        }
    };
}

/* ------------------------------------------------------------------ */

function getFlightProvider(env = process.env) {
    const key = env.FLIGHT_API_KEY;
    if (key) return aeroDataBoxProvider(key);
    return stubProvider();
}

/**
 * When the traveller is actually standing at the kerb. This, not touchdown, is
 * what the matcher should compare: someone with hand baggage landing at 20:00
 * leaves at the same moment as someone with a checked bag landing at 19:40.
 */
function computeReadyTime(flight, bufferMinutes) {
    const arrival = flight.actualArrival ?? flight.estimatedArrival ?? flight.scheduledArrival;
    if (!Number.isFinite(arrival)) return null;
    return arrival + Number(bufferMinutes) * 60000;
}

module.exports = {
    getFlightProvider,
    CARRIERS,
    ORIGIN_CITIES,
    HOME_AIRPORT,
    carrierOf,
    isSupportedCarrier,
    stubProvider,
    aeroDataBoxProvider,
    computeReadyTime,
    normaliseFlightNumber,
    isValidFlightNumber,
    isValidFlightDate,
    mapAeroStatus,
    STATUSES
};
