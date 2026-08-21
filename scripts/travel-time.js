/**
 * How long the hostel to airport drive will actually take.
 *
 * A fixed number is wrong twice a day in Bengaluru: the same road is 1h30 at
 * noon and well past 1h45 in the evening peak. Google's Routes API predicts
 * traffic for a future departure time, which is exactly the question we have.
 *
 * Configured with GOOGLE_MAPS_API_KEY and HOSTEL_LATLNG. Without either it
 * falls back to a flat estimate, so this is never a hard dependency, same rule
 * as the flight feed.
 *
 * Returns: { minutes, staticMinutes, source, trafficDelayMinutes }
 */

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// Kempegowda International, Devanahalli.
const AIRPORT = { latitude: 13.1986, longitude: 77.7066 };

const DEFAULT_MINUTES = 90;
const MIN_MINUTES = 30;
const MAX_MINUTES = 240;

function parseLatLng(value) {
    const match = String(value || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude };
}

// Routes API returns durations as "5400s".
function secondsToMinutes(value) {
    const match = String(value || '').match(/^(\d+(?:\.\d+)?)s$/);
    return match ? Math.round(Number(match[1]) / 60) : null;
}

function clampMinutes(minutes, fallback) {
    if (!Number.isFinite(minutes)) return fallback;
    return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes));
}

function staticEstimator(defaultMinutes = DEFAULT_MINUTES) {
    return {
        name: 'static',
        async estimate() {
            return {
                minutes: defaultMinutes,
                staticMinutes: defaultMinutes,
                trafficDelayMinutes: 0,
                source: 'static'
            };
        }
    };
}

function googleRoutesEstimator(apiKey, hostel, { fetchImpl = fetch, timeoutMs = 8000, defaultMinutes = DEFAULT_MINUTES } = {}) {
    return {
        name: 'google-routes',
        async estimate(departAt) {
            // Google rejects a departureTime in the past; fall forward to now.
            const when = new Date(Math.max(Number(departAt) || Date.now(), Date.now() + 60000));

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let res;
            try {
                res = await fetchImpl(ROUTES_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Goog-Api-Key': apiKey,
                        // Field mask is mandatory, and narrowing it is what keeps
                        // the request on the cheaper billing SKU.
                        'X-Goog-FieldMask': 'routes.duration,routes.staticDuration'
                    },
                    body: JSON.stringify({
                        origin: { location: { latLng: hostel } },
                        destination: { location: { latLng: AIRPORT } },
                        travelMode: 'DRIVE',
                        routingPreference: 'TRAFFIC_AWARE',
                        departureTime: when.toISOString()
                    }),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timer);
            }

            if (!res.ok) throw new Error(`routes lookup failed (${res.status})`);

            const body = await res.json();
            const route = body?.routes?.[0];
            if (!route) throw new Error('no route returned');

            const withTraffic = clampMinutes(secondsToMinutes(route.duration), defaultMinutes);
            const clear = clampMinutes(secondsToMinutes(route.staticDuration), withTraffic);

            return {
                minutes: withTraffic,
                staticMinutes: clear,
                trafficDelayMinutes: Math.max(0, withTraffic - clear),
                source: 'google-routes'
            };
        }
    };
}

function getTravelEstimator(env = process.env) {
    const key = env.GOOGLE_MAPS_API_KEY;
    const hostel = parseLatLng(env.HOSTEL_LATLNG);
    const fallback = Number(env.HOSTEL_TRAVEL_MINUTES) || DEFAULT_MINUTES;
    if (key && hostel) return googleRoutesEstimator(key, hostel, { defaultMinutes: fallback });
    return staticEstimator(fallback);
}

module.exports = {
    getTravelEstimator,
    staticEstimator,
    googleRoutesEstimator,
    parseLatLng,
    secondsToMinutes,
    clampMinutes,
    AIRPORT,
    DEFAULT_MINUTES
};
