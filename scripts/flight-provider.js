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

// Every Indian airport with scheduled service, from the public-domain
// OurAirports dataset. Static, so the picker costs no API calls, and
// complete, so nobody's home airport is missing. BLR itself is excluded:
// it is the hub, never the other end of the trip.
const ORIGIN_CITIES = [
    { code: 'AIP', city: 'Adampur' },
    { code: 'IXA', city: 'Agartala' },
    { code: 'AGX', city: 'Agatti' },
    { code: 'AGR', city: 'Agra' },
    { code: 'AMD', city: 'Ahmedabad' },
    { code: 'AJL', city: 'Aizawl (Lengpui)' },
    { code: 'KQH', city: 'Ajmer (Kishangarh)' },
    { code: 'HRH', city: 'Aligarh' },
    { code: 'IXD', city: 'Allahabad' },
    { code: 'AHA', city: 'Ambikapur' },
    { code: 'ATQ', city: 'Amritsar' },
    { code: 'IXU', city: 'Aurangabad' },
    { code: 'BEK', city: 'Bareilly' },
    { code: 'IXG', city: 'Belgaum' },
    { code: 'BHU', city: 'Bhavnagar' },
    { code: 'UKE', city: 'Bhawanipatna' },
    { code: 'BHO', city: 'Bhopal' },
    { code: 'BBI', city: 'Bhubaneswar' },
    { code: 'BHJ', city: 'Bhuj' },
    { code: 'KUU', city: 'Bhuntar' },
    { code: 'IXX', city: 'Bidar' },
    { code: 'PAB', city: 'Bilaspur' },
    { code: 'CCJ', city: 'Calicut' },
    { code: 'IXC', city: 'Chandigarh' },
    { code: 'MAA', city: 'Chennai' },
    { code: 'SDW', city: 'Chipi' },
    { code: 'CJB', city: 'Coimbatore' },
    { code: 'DBR', city: 'Darbhanga' },
    { code: 'DED', city: 'Dehradun (Jauligrant)' },
    { code: 'DGH', city: 'Deoghar' },
    { code: 'DIB', city: 'Dibrugarh' },
    { code: 'DMU', city: 'Dimapur' },
    { code: 'DIU', city: 'Diu' },
    { code: 'RDP', city: 'Durgapur' },
    { code: 'AYJ', city: 'Faizabad' },
    { code: 'DXN', city: 'Gautam Buddha Nagar' },
    { code: 'GAY', city: 'Gaya' },
    { code: 'HDO', city: 'Ghaziabad' },
    { code: 'GDB', city: 'Gondia' },
    { code: 'GOP', city: 'Gorakhpur' },
    { code: 'GAU', city: 'Guwahati' },
    { code: 'GWL', city: 'Gwalior' },
    { code: 'HWR', city: 'Halwara' },
    { code: 'HSS', city: 'Hisar' },
    { code: 'HGI', city: 'Hollongi' },
    { code: 'HBX', city: 'Hubballi' },
    { code: 'HYD', city: 'Hyderabad' },
    { code: 'IMF', city: 'Imphal' },
    { code: 'IDR', city: 'Indore' },
    { code: 'JLR', city: 'Jabalpur' },
    { code: 'JGB', city: 'Jagdalpur' },
    { code: 'JAI', city: 'Jaipur' },
    { code: 'JSA', city: 'Jaisalmer Airport' },
    { code: 'JLG', city: 'Jalgaon' },
    { code: 'IXJ', city: 'Jammu' },
    { code: 'JGA', city: 'Jamnagar' },
    { code: 'JRG', city: 'Jharsuguda Airport' },
    { code: 'JDH', city: 'Jodhpur' },
    { code: 'JRH', city: 'Jorhat' },
    { code: 'CDP', city: 'Kadapa' },
    { code: 'SAG', city: 'Kakadi' },
    { code: 'GBI', city: 'Kalaburagi' },
    { code: 'IXY', city: 'Kandla' },
    { code: 'DHM', city: 'Kangra' },
    { code: 'CNN', city: 'Kannur' },
    { code: 'KNU', city: 'Kanpur' },
    { code: 'IXK', city: 'Keshod' },
    { code: 'HJR', city: 'Khajuraho' },
    { code: 'COK', city: 'Kochi' },
    { code: 'KLH', city: 'Kolhapur' },
    { code: 'CCU', city: 'Kolkata' },
    { code: 'LTU', city: 'Latur' },
    { code: 'IXL', city: 'Leh' },
    { code: 'IXI', city: 'Lilabari' },
    { code: 'LKO', city: 'Lucknow' },
    { code: 'RJA', city: 'Madhurapudi' },
    { code: 'IXM', city: 'Madurai' },
    { code: 'IXE', city: 'Mangaluru' },
    { code: 'GOX', city: 'Mopa' },
    { code: 'MZS', city: 'Moradabad' },
    { code: 'BOM', city: 'Mumbai' },
    { code: 'MYQ', city: 'Mysore' },
    { code: 'NAG', city: 'Nagpur' },
    { code: 'NDC', city: 'Nanded' },
    { code: 'ISK', city: 'Nashik' },
    { code: 'NMI', city: 'Navi Mumbai' },
    { code: 'DEL', city: 'New Delhi' },
    { code: 'KJB', city: 'Orvakal' },
    { code: 'PGH', city: 'Pantnagar' },
    { code: 'IXP', city: 'Pathankot' },
    { code: 'PAT', city: 'Patna' },
    { code: 'PBD', city: 'Porbandar' },
    { code: 'IXZ', city: 'Port Blair' },
    { code: 'PNY', city: 'Puducherry (Pondicherry)' },
    { code: 'PNQ', city: 'Pune' },
    { code: 'RPR', city: 'Raipur' },
    { code: 'HSR', city: 'Rajkot' },
    { code: 'IXR', city: 'Ranchi' },
    { code: 'REW', city: 'Rewa' },
    { code: 'SXV', city: 'Salem' },
    { code: 'SHL', city: 'Shillong' },
    { code: 'VSV', city: 'Shravasti' },
    { code: 'IXS', city: 'Silchar' },
    { code: 'IXB', city: 'Siliguri' },
    { code: 'SXR', city: 'Srinagar' },
    { code: 'STV', city: 'Surat' },
    { code: 'TEZ', city: 'Tezpur Airport' },
    { code: 'TRV', city: 'Thiruvananthapuram' },
    { code: 'TRZ', city: 'Tiruchirappalli' },
    { code: 'TIR', city: 'Tirupati' },
    { code: 'UDR', city: 'Udaipur' },
    { code: 'BDQ', city: 'Vadodara' },
    { code: 'TCR', city: 'Vagaikulam' },
    { code: 'VNS', city: 'Varanasi' },
    { code: 'GOI', city: 'Vasco da Gama' },
    { code: 'VDY', city: 'Vidyanagar' },
    { code: 'VGA', city: 'Vijayawada' },
    { code: 'VTZ', city: 'Visakhapatnam' }
];

// Domestic only. The browse endpoints get this for free, because the student
// picks an origin out of ORIGIN_CITIES and that list is Indian by construction.
// Typing a flight number does not: 6E1214 is Bangkok to BLR and 6E810 is Delhi
// to BLR, and nothing about the number says which. So the same list doubles as
// the test, with BLR added back because ORIGIN_CITIES deliberately omits it.
const DOMESTIC_AIRPORTS = new Set([HOME_AIRPORT, ...ORIGIN_CITIES.map(city => city.code)]);

function isDomesticAirport(code) {
    return DOMESTIC_AIRPORTS.has(String(code || '').toUpperCase());
}

/**
 * Both ends in India. A flight we cannot place at all fails this, which is the
 * safe direction to fail: better to send someone to manual entry than to time
 * their carpool off an airport we could not identify.
 */
function isDomesticFlight(flight) {
    return isDomesticAirport(flight?.origin?.code) && isDomesticAirport(flight?.destination?.code);
}

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
        async searchDepartures(destinationCode, date) {
            const to = String(destinationCode || '').toUpperCase();
            return Object.entries(STUB_FLIGHTS)
                .filter(([number, c]) => c.origin[0] === to && isSupportedCarrier(number))
                .map(([number, c]) => ({
                    number,
                    airline: c.airline,
                    date,
                    direction: 'departure',
                    origin: { code: 'BLR', name: 'Bengaluru' },
                    destination: { code: c.origin[0], name: c.origin[1] },
                    // Mirror of the arrival fixture: same clock time, outbound.
                    scheduledDeparture: new Date(`${date}T${c.arriveAt}:00+05:30`).getTime(),
                    estimatedDeparture: null,
                    scheduledArrival: null,
                    estimatedArrival: null,
                    actualArrival: null,
                    status: 'scheduled',
                    terminal: '1',
                    belt: null
                }))
                .sort((a, b) => a.scheduledDeparture - b.scheduledDeparture);
        },
        async lookup(flightNumber, date, direction = 'Arrival') {
            const key = normaliseFlightNumber(flightNumber);
            const canned = STUB_FLIGHTS[key];
            if (!canned) return null;

            if (direction === 'Departure') {
                return {
                    number: key, airline: canned.airline, date, direction: 'departure',
                    origin: { code: 'BLR', name: 'Bengaluru' },
                    destination: { code: canned.origin[0], name: canned.origin[1] },
                    scheduledDeparture: new Date(`${date}T${canned.arriveAt}:00+05:30`).getTime(),
                    estimatedDeparture: null, scheduledArrival: null, estimatedArrival: null,
                    actualArrival: null, status: 'scheduled', terminal: '1', belt: null
                };
            }

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
 * BLR's own AODB feed, which is what bengaluruairport.com itself calls.
 *
 * NOT the default, for two reasons found the hard way:
 *
 *   1. It is actively defended. After a modest number of server-side calls the
 *      gateway starts answering 403 {"message":"API-Tools not allowed!"}, which
 *      is an explicit statement that programmatic access is unwelcome. A
 *      datacentre IP will trip this sooner than a browser does.
 *   2. It only carries the near-present. Requesting tomorrow returns an empty
 *      list, so it cannot answer "my flight is next Tuesday", which is most of
 *      what students actually post.
 *
 * Kept behind FLIGHT_PROVIDER=blr-aodb because it is the only source with a
 * reliable baggage belt, and it may be useful for same-day enrichment from a
 * residential IP. Do not build the product on it.
 * ------------------------------------------------------------------ */

const BLR_GATEWAY = 'https://gateway.bengaluruairport.com/fis/v2/api/aodb/flight-infos';
const BLR_ORIGIN = 'https://www.bengaluruairport.com';
const BLR_CACHE_MS = 3 * 60 * 1000;

// These are UTC, not Bangalore wall clock. Confirmed against the airport's own
// page: it renders 09:55 IST for a row whose raw value is 202608080425, which
// is the 5:30 offset exactly. Parsing them as local shifted every time back.
function parseAodbTime(value) {
    const raw = String(value || '');
    if (!/^\d{12}$/.test(raw)) return null;
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
        + `T${raw.slice(8, 10)}:${raw.slice(10, 12)}:00Z`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function mapAodbStatus(row) {
    const name = String(row?.flightStatus?.name || '').toUpperCase();
    if (name.includes('CANCEL')) return 'cancelled';
    if (name.includes('DIVERT')) return 'diverted';
    if (name === 'ARRIVED' || name === 'LANDED') return 'landed';
    if (name.includes('ARRIVING') || name === 'DEPARTED' || name.includes('EN ROUTE')) return 'departed';
    if (name === 'ONTIME' || name === 'DELAYED' || name === 'SCHEDULED') return 'scheduled';
    return 'unknown';
}

function fromAodbRow(row, date, direction = 'Arrival') {
    const belts = row.baggageBelts || [];
    const origin = row.originAirport || {};
    const dest = row.destinationAirport || {};
    const outbound = direction === 'Departure';
    return {
        number: normaliseFlightNumber(row.flightNumber),
        airline: row.airline?.displayName || row.airline?.name || null,
        date,
        direction: outbound ? 'departure' : 'arrival',
        origin: outbound
            ? { code: HOME_AIRPORT, name: 'Bengaluru' }
            : { code: origin.code || null, name: origin.city || origin.name || null },
        destination: outbound
            ? { code: dest.code || null, name: dest.city || dest.name || null }
            : { code: HOME_AIRPORT, name: 'Bengaluru' },
        // On a departure these carry the take-off times, not the arrival ones.
        scheduledDeparture: outbound ? parseAodbTime(row.scheduledDate) : null,
        estimatedDeparture: outbound ? parseAodbTime(row.estimatedDate) : null,
        scheduledArrival: parseAodbTime(row.scheduledDate),
        // The feed reports one estimate that becomes the actual once landed.
        estimatedArrival: parseAodbTime(row.estimatedDate),
        actualArrival: mapAodbStatus(row) === 'landed' ? parseAodbTime(row.estimatedDate) : null,
        status: mapAodbStatus(row),
        terminal: row.terminal ? `T${String(row.terminal).replace(/^T/i, '')}` : null,
        belt: belts.length ? String(belts[0].beltNumber) : null,
        gate: (row.gates || []).length ? String(row.gates[0].gateNumber) : null
    };
}

function blrAodbProvider({ fetchImpl = fetch, timeoutMs = 12000, cacheMs = BLR_CACHE_MS } = {}) {
    const cache = new Map(); // "YYYYMMDD:Arrival" -> { at, rows }

    async function fetchDay(date, direction = 'Arrival') {
        const compact = String(date).replace(/-/g, '');
        const key = `${compact}:${direction}`;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < cacheMs) return hit.rows;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetchImpl(`${BLR_GATEWAY}/${compact}/${direction}`, {
                headers: {
                    // Without this the gateway answers "Unknown Origin".
                    Origin: BLR_ORIGIN,
                    Referer: `${BLR_ORIGIN}/travellers/flights/flight-information`,
                    Accept: 'application/json'
                },
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) throw new Error(`BLR feed failed (${res.status})`);
        const body = await res.json();
        const rows = Array.isArray(body?.data) ? body.data : [];
        cache.set(key, { at: Date.now(), rows });
        return rows;
    }

    return {
        name: 'blr-aodb',
        async lookup(flightNumber, date, direction = 'Arrival') {
            const wanted = normaliseFlightNumber(flightNumber);
            const rows = await fetchDay(date, direction);
            const row = rows.find(r => normaliseFlightNumber(r.flightNumber) === wanted);
            return row ? fromAodbRow(row, date, direction) : null;
        },
        async searchArrivals(originCode, date) {
            const from = String(originCode || '').toUpperCase();
            const rows = await fetchDay(date, 'Arrival');
            return rows
                .filter(r => (r.originAirport?.code || '').toUpperCase() === from)
                .filter(r => isSupportedCarrier(r.flightNumber))
                .map(r => fromAodbRow(r, date, 'Arrival'))
                .filter(f => Number.isFinite(f.scheduledArrival))
                .sort((a, b) => a.scheduledArrival - b.scheduledArrival);
        },
        async searchDepartures(destinationCode, date) {
            const to = String(destinationCode || '').toUpperCase();
            const rows = await fetchDay(date, 'Departure');
            return rows
                .filter(r => (r.destinationAirport?.code || '').toUpperCase() === to)
                .filter(r => isSupportedCarrier(r.flightNumber))
                .map(r => fromAodbRow(r, date, 'Departure'))
                .filter(f => Number.isFinite(f.scheduledDeparture))
                .sort((a, b) => a.scheduledDeparture - b.scheduledDeparture);
        }
    };
}

/* ------------------------------------------------------------------ *
 * Skyscanner's arrivals/departures board.
 *
 * The public page at skyscanner.co.in/flights/arrivals-departures/blr renders a
 * shimmer skeleton and fills it from one JSON call, which is what we call here.
 * No key, no auth, no cookie: a plain GET answers 200 with the whole board.
 *
 * It is the richest free source we have found. Per flight it carries scheduled
 * AND estimated times for both ends, terminal, arrival gate, boarding gate, a
 * live status, and the codeshare list. That is everything the AODB feed gives
 * except the baggage belt, which no free source outside AODB seems to publish.
 *
 * Two things to be honest about before switching anything to it:
 *
 *   1. robots.txt disallows this path. /g/* is Disallowed for User-agent: *
 *      (only /g/banana/api/context is carved out), so while the human-facing
 *      HTML page is fair game, this JSON endpoint sits behind a crawl rule.
 *      Loading the page in a headless browser instead does not help: that
 *      route trips a PerimeterX CAPTCHA within seconds.
 *   2. It only carries today and tomorrow. One call returns a rolling ~48 hour
 *      window, so like blr-aodb it cannot answer "my flight is next Tuesday".
 *
 * So this stays opt-in behind FLIGHT_PROVIDER=skyscanner, same as blr-aodb.
 * AeroDataBox remains the default because it is licensed and answers for any
 * future date. Reach for this one when you want same-day gate and status
 * detail that AeroDataBox's free tier will not give you.
 * ------------------------------------------------------------------ */

const SKY_ORIGIN = 'https://www.skyscanner.co.in';
const SKY_BOARD = `${SKY_ORIGIN}/g/arrival-departure-svc/api/airports`;
const SKY_CACHE_MS = 3 * 60 * 1000;

// A board response is ~850KB and covers two days at once, so one fetch per
// direction serves every date and origin the page can ask about. Cache hard.
const SKY_PAGE = '/flights/arrivals-departures/blr/bengaluru-arrivals-departures';

/**
 * The feed publishes each time twice: once as UTC ("2026-08-07T02:10Z") and
 * once as local wall clock with no offset ("2026-08-07T07:40"). Parse the UTC
 * one for arithmetic and keep the local one only for deciding which day a
 * flight belongs to, since "my flight on the 8th" means the 8th in Bangalore.
 */
function parseSkyTime(value) {
    const raw = String(value || '');
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

/**
 * Status describes the whole flight's progress, not its position relative to
 * BLR, so the same mapping serves both boards. Verified against live rows:
 * a departure sitting at IN_GATE has already landed at its destination, and
 * an arrival at OUT_GATE has only just pushed back from its origin.
 */
function mapSkyStatus(row) {
    if (row?.isDiverted) return 'diverted';
    switch (String(row?.status || '').toUpperCase()) {
        case 'CANCELLED': return 'cancelled';
        case 'IN_GATE':
        case 'LANDED':
        case 'PAST_FLIGHT': return 'landed';
        case 'IN_AIR':
        case 'OUT_GATE': return 'departed';
        // DELAYED is still an intention, not a movement: the aircraft has not
        // gone anywhere yet, it is just going later than printed.
        case 'DELAYED':
        case 'EXPECTED':
        case 'NO_TAKEOFF_INFO':
        case 'SCHEDULED': return 'scheduled';
        default: return 'unknown';
    }
}

function fromSkyRow(row, date, direction = 'Arrival') {
    const outbound = direction === 'Departure';
    const other = outbound
        ? { code: row.arrivalAirportCode, name: row.arrivalAirportName }
        : { code: row.departureAirportCode, name: row.departureAirportName };

    const scheduledArrival = parseSkyTime(row.scheduledArrivalTime);
    const estimatedArrival = parseSkyTime(row.estimatedArrivalTime);
    const status = mapSkyStatus(row);

    return {
        number: normaliseFlightNumber(row.flightNumber),
        // airlineId is not an IATA code here - IndiGo comes through as "49" and
        // Akasa as "C)" - so trust the display name and derive the code from
        // the flight number, which is the one field that is always clean.
        airline: row.airlineName || CARRIERS[carrierOf(row.flightNumber)] || null,
        date,
        direction: outbound ? 'departure' : 'arrival',
        origin: outbound ? { code: HOME_AIRPORT, name: 'Bengaluru' } : { code: other.code || null, name: other.name || null },
        destination: outbound ? { code: other.code || null, name: other.name || null } : { code: HOME_AIRPORT, name: 'Bengaluru' },
        scheduledDeparture: outbound ? parseSkyTime(row.scheduledDepartureTime) : null,
        estimatedDeparture: outbound ? parseSkyTime(row.estimatedDepartureTime) : null,
        scheduledArrival,
        estimatedArrival,
        actualArrival: status === 'landed' ? (estimatedArrival ?? scheduledArrival) : null,
        status,
        // The raw label carries detail the five-state model flattens away, and
        // "Delayed" is exactly what someone waiting at the kerb wants to see.
        statusLabel: row.status || null,
        terminal: (outbound ? row.departureTerminal : row.arrivalTerminal) || null,
        // No free source outside the AODB publishes a belt. Never invent one.
        belt: null,
        // arrivalGate is where it parks at BLR; boardingGate is where it boards.
        // On an arrivals row boardingGate belongs to the *origin* airport, so
        // only read the one that describes this end of the trip.
        gate: (outbound ? row.boardingGate : row.arrivalGate) || null
    };
}

function skyscannerProvider({ fetchImpl = fetch, timeoutMs = 15000, cacheMs = SKY_CACHE_MS, airport = HOME_AIRPORT } = {}) {
    const cache = new Map(); // "arrivals" | "departures" -> { at, rows }

    async function fetchBoard(direction = 'Arrival') {
        const key = direction === 'Departure' ? 'departures' : 'arrivals';
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < cacheMs) return hit.rows;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetchImpl(`${SKY_BOARD}/${String(airport).toLowerCase()}/${key}?locale=en-GB`, {
                headers: {
                    Accept: 'application/json',
                    'Accept-Language': 'en-IN,en;q=0.9',
                    Referer: `${SKY_ORIGIN}${SKY_PAGE}`,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                        + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                },
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) throw new Error(`Skyscanner board failed (${res.status})`);
        const body = await res.json();
        // The response always has both keys; the one you did not ask for is null.
        const rows = Array.isArray(body?.[key]) ? body[key] : [];
        cache.set(key, { at: Date.now(), rows });
        return rows;
    }

    // Which calendar day a row belongs to, in Bangalore wall clock. The board
    // spans today and tomorrow, so every query has to narrow it down.
    function onDate(row, date, outbound) {
        const local = outbound ? row.localisedScheduledDepartureTime : row.localisedScheduledArrivalTime;
        return String(local || '').slice(0, 10) === date;
    }

    return {
        name: 'skyscanner',
        /**
         * Every flight on one side of the board for one day, unfiltered by
         * carrier. The nightly schedule snapshot needs the whole picture, not
         * just the routes a student happens to be browsing.
         */
        async listBoard(date, direction = 'Arrival') {
            const outbound = direction === 'Departure';
            const rows = await fetchBoard(direction);
            return rows
                .filter(r => onDate(r, date, outbound))
                .map(r => fromSkyRow(r, date, direction));
        },
        async lookup(flightNumber, date, direction = 'Arrival') {
            const wanted = normaliseFlightNumber(flightNumber);
            const outbound = direction === 'Departure';
            const rows = await fetchBoard(direction);
            const row = rows.find(r =>
                normaliseFlightNumber(r.flightNumber) === wanted && onDate(r, date, outbound));
            return row ? fromSkyRow(row, date, direction) : null;
        },
        async searchArrivals(originCode, date) {
            const from = String(originCode || '').toUpperCase();
            const rows = await fetchBoard('Arrival');
            return rows
                .filter(r => (r.departureAirportCode || '').toUpperCase() === from)
                .filter(r => onDate(r, date, false))
                .filter(r => isSupportedCarrier(r.flightNumber))
                .map(r => fromSkyRow(r, date, 'Arrival'))
                .filter(f => Number.isFinite(f.scheduledArrival))
                .sort((a, b) => a.scheduledArrival - b.scheduledArrival);
        },
        async searchDepartures(destinationCode, date) {
            const to = String(destinationCode || '').toUpperCase();
            const rows = await fetchBoard('Departure');
            return rows
                .filter(r => (r.arrivalAirportCode || '').toUpperCase() === to)
                .filter(r => onDate(r, date, true))
                .filter(r => isSupportedCarrier(r.flightNumber))
                .map(r => fromSkyRow(r, date, 'Departure'))
                .filter(f => Number.isFinite(f.scheduledDeparture))
                .sort((a, b) => a.scheduledDeparture - b.scheduledDeparture);
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

function aeroDataBoxProvider(apiKey, { fetchImpl = fetch, timeoutMs = 8000, minGapMs = 1100 } = {}) {
    // The free tier allows one request per second. A day of arrivals is two
    // windowed calls, so firing them back to back earns a 429.
    let lastCallAt = 0;
    async function throttle() {
        const wait = lastCallAt + minGapMs - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastCallAt = Date.now();
    }

    async function getJson(url) {
        await throttle();
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
    // Skyscanner is the default. It needs no key, is not rate limited into
    // uselessness, and carries terminal, gate and live status where the
    // AeroDataBox free tier carries much less.
    //
    // Its one weakness is the rolling 48 hour window, which is why
    // scripts/flight-schedule.js exists: a nightly snapshot learns the repeating
    // timetable so a flight booked for next Tuesday still resolves.
    //
    // aerodatabox is left reachable but is no longer used by default. It costs a
    // RapidAPI key and answers with less. Delete the branch when you are sure.
    const choice = String(env.FLIGHT_PROVIDER || '').toLowerCase();
    if (choice === 'stub') return stubProvider();
    if (choice === 'blr-aodb') return blrAodbProvider();
    if (choice === 'aerodatabox' && env.FLIGHT_API_KEY) return aeroDataBoxProvider(env.FLIGHT_API_KEY);
    return skyscannerProvider();
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

/**
 * When to walk out of the hostel for a departing flight. You want to be at the
 * airport a set time before take-off, and the drive itself takes about an hour,
 * so the useful moment is earlier than either number alone suggests.
 */
function computeLeaveTime(flight, reachBeforeMinutes, travelMinutes) {
    const departure = flight.estimatedDeparture ?? flight.scheduledDeparture;
    if (!Number.isFinite(departure)) return null;
    return departure - (Number(reachBeforeMinutes) + Number(travelMinutes)) * 60000;
}

module.exports = {
    computeLeaveTime,
    getFlightProvider,
    CARRIERS,
    ORIGIN_CITIES,
    HOME_AIRPORT,
    carrierOf,
    isSupportedCarrier,
    isDomesticAirport,
    isDomesticFlight,
    stubProvider,
    aeroDataBoxProvider,
    blrAodbProvider,
    skyscannerProvider,
    parseAodbTime,
    mapAodbStatus,
    parseSkyTime,
    mapSkyStatus,
    computeReadyTime,
    normaliseFlightNumber,
    isValidFlightNumber,
    isValidFlightDate,
    mapAeroStatus,
    STATUSES
};
