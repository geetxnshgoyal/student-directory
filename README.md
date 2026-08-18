# NST Bangalore Student Portal

Two tools for one batch, sharing a codebase, a design system and a Firestore database:

- **Carpool** — students split the campus↔BLR airport run, matched on when they'll actually be at the kerb.
- **Admin directory** — the student roster, searchable, with birthday automation.

Node + Express, no build step, deployed on Vercel.

---

## Quick start

```bash
npm install
cp .env.example .env     # then fill it in, see Configuration
npm run dev
```

| URL | What |
|---|---|
| `/` or `/carpool` | Carpool (students) |
| `/admin.html` | Admin directory |

Without Firebase credentials the carpool falls back to in-memory storage, so it runs locally with nothing configured. Without a flight API key it serves canned flights. Nothing hard-fails on missing config.

---

## The carpool

### The idea

Landing time is not the useful time. Two students land 20 minutes apart but reach the kerb together, because one has hand baggage and the other waited at the belt. So the app matches on **when you're outside**, not when you touch down:

```
arriving   readyTime = (actual ?? estimated ?? scheduled) arrival + bufferMinutes
departing  leaveTime = departure − timeYouWantAtTheAirport − driveTime
```

Both land in the same `time` field, so the matcher compares one number and doesn't care which direction produced it.

Defaults: 25 min to clear the belt inbound; 2 h at the airport plus a 1 h 30 drive outbound. A 3 h airport option exists for lounge access, giving a 4 h 30 lead.

### How a trip gets posted

1. Pick a direction.
2. Pick the city you're flying from (or to) — 118 Indian airports, from the public-domain [OurAirports](https://ourairports.com/data/) dataset, static so it costs no API calls.
3. Pick your flight from that day's list. Or type the flight number. Or skip all of it and type a time.
4. Choose your buffer. The card shows the moment you'll be matched for.

**Manual time entry is always available.** Unknown flight, bad number, provider timeout, missing key, quota exhausted — every failure path lands there rather than dead-ending. The flight API is an enhancement, never a dependency.

### Matching

Two trips match when they share a direction and their times fall inside the tighter of the two tolerances. Both travellers get one email each with the other's WhatsApp link and a prefilled message.

Notifications are claimed atomically per pair, so polling, retries and concurrent writes can't produce a duplicate.

---

## Flight data

All providers sit behind one interface in `scripts/flight-provider.js` and return the same normalised shape, so swapping one out is a change to that file alone.

| Provider | Selected by | Notes |
|---|---|---|
| **AeroDataBox** | `FLIGHT_API_KEY` set (default) | Via RapidAPI. Answers **future dates**, which is the requirement. Free tier: 600 units/month, 1 req/sec — the client throttles to match. |
| **stub** | `FLIGHT_PROVIDER=stub` | Canned flights, no network. Used by every test. |
| **blr-aodb** | `FLIGHT_PROVIDER=blr-aodb` | BLR's own feed. **Opt-in, not recommended** — see below. |

Filtered to the carriers this batch actually flies: IndiGo, Air India, Air India Express, Akasa. Vistara is absent because it merged into Air India in 2024. Domestic only, checked on both ends — `6E1214` is Bangkok→BLR and nothing in the number says so.

### Why the airport's own feed isn't the default

`gateway.bengaluruairport.com` serves a public AODB endpoint with excellent data — it was the only source with a reliable baggage belt (100% of landed flights on the day tested). It is not the default for two reasons found the hard way:

1. **It blocks.** After a modest number of server-side calls it returns `403 {"message":"API-Tools not allowed!"}` — an explicit statement that programmatic access is unwelcome. A datacentre IP will trip this sooner than a laptop does.
2. **It only carries the near-present.** Requesting a date a few days out returns an empty list, so it can't answer "my flight is next Tuesday", which is most of what students post.

**Baggage belt is same-day data regardless of source.** Belts are assigned an hour or two before landing, so a flight posted days ahead will always show none. AeroDataBox returns `baggageBelt` when it exists and the provider maps it; nothing in the UI promises it.

### Schedule estimates

`scripts/flight-schedule.js` watches the live board nightly and learns the repeating pattern, so a flight weeks out can still be offered a scheduled time. Estimates are labelled as estimates, carry no gate or live status, and are dropped the moment the flight enters the real live window.

### Traffic

`scripts/travel-time.js` predicts the hostel→airport drive for the actual departure hour via Google's Routes API (`TRAFFIC_AWARE`). Advisory only: it prefills a picker the student can override, and any failure degrades to a flat estimate. Needs `GOOGLE_MAPS_API_KEY` and `HOSTEL_LATLNG`; without them the picker still works.

---

## Admin directory

`/admin.html`, gated by an emailed OTP. Search and filter the roster, open a profile card, view upcoming birthdays and blood-group distribution.

Student photos are stored as base64 data URIs in Firestore. Missing photos render an initial locally — never an external placeholder, which the CSP blocks.

### Birthday automation

Every day at 00:00 IST, students with a birthday get a wish, and the rest of the batch gets one announcement naming them.

Sending is **idempotent by construction**. The day is claimed atomically before anything is sent, and each individual email is reserved in a transaction before it goes out:

```
claim day → reserve student → send → reserve reminder → send
```

A failed send is **recorded, not retried**, and shows up under `failed` in that day's `birthday_runs` document. A thrown error doesn't prove the mail wasn't delivered, so retrying risks a duplicate — the design chooses a possible miss over a possible double-send.

Triggered by a GitHub Action making three staggered attempts around midnight (the early one sleeps until the exact minute, since GitHub's cron is best-effort) plus Vercel's own cron as a backstop. Both running is harmless: whichever arrives second finds the day already claimed.

The in-process scheduler does **not** run a check on boot. It used to, which meant every `nodemon` restart and every Vercel cold start fired a full send. Set `BIRTHDAY_RUN_ON_START=1` if you deliberately want a catch-up.

---

## Configuration

Copy `.env.example` to `.env`. Everything except Firebase and SMTP has a working fallback.

### Required for real use

| Variable | Purpose |
|---|---|
| `FIREBASE_PROJECT_ID` `FIREBASE_CLIENT_EMAIL` `FIREBASE_PRIVATE_KEY` | Firestore. Without these, carpool state is in-memory and the directory is empty. |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | All email. Without these nothing is sent. |
| `JWT_SECRET` | Signs admin sessions. **Must be set in production** — the random fallback differs per serverless instance, so tokens break between requests. |
| `CRON_SECRET` | Guards `/api/cron/*`. The endpoint refuses to run without it. |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `FLIGHT_API_KEY` | — | AeroDataBox via RapidAPI. Without it, canned flights. |
| `FLIGHT_PROVIDER` | auto | `stub`, `blr-aodb`, or unset for AeroDataBox. |
| `GOOGLE_MAPS_API_KEY` + `HOSTEL_LATLNG` | — | Live traffic. `HOSTEL_LATLNG` is `lat,lng`. |
| `HOSTEL_TRAVEL_MINUTES` | `90` | Flat drive estimate when Maps isn't configured. |
| `ADMIN_DEFAULT_OTP` | — | Bypass code for admin login. |
| `DEMO_USN` + `DEMO_OTP` | — | Demo login for showing the app to people with no student record. Disabled unless both are set. |
| `PUBLIC_BASE_URL` | — | Base URL in email links. |
| `BIRTHDAY_RUN_ON_START` | off | Run a birthday check on boot. |

> Deploying: every variable you set locally must also be set in Vercel, or production silently falls back. This is the most common cause of "it works on my machine".

---

## Security

Authentication is role-based. Three login paths mint different tokens, and verifying the signature is not enough — `requireRole` checks what the token actually is. Without it a student's own token opened the admin roster.

- Carpool sessions are Firestore-backed opaque tokens, 4 h TTL.
- OTPs: attempt-capped, constant-time compared, rate-limited separately from the rest of the API.
- `trust proxy` is set, so rate limits are per-user rather than one shared bucket behind Vercel's proxy.
- The board exposes names, photos and times only. No USN, email or phone reaches the client — asserted by a test that scans every response for them.
- Contact details travel by email, to the two people in a match.

---

## Layout

```
server.js                     API, auth, matching, email
public/
  carpool.html/.js/.css       Student carpool
  admin.html/.js              Admin directory
  admin-theme.css             Shared design tokens for admin
  style.css                   Base styles
scripts/
  flight-provider.js          Flight data behind one interface
  flight-schedule.js          Learned schedule estimates
  travel-time.js              Drive time, traffic-aware
  birthday-scheduler.js       Birthday email, idempotent
  export-students.js          Roster → CSV, into gitignored exports/
```

### Firestore collections

`students`, `carpool_otps`, `carpool_sessions`, `carpool_requests`, `carpool_notified`, `birthday_runs` (one document per day).

---

## Design

Navy on cool paper, with green for arrivals and burgundy for departures, colour-coded like a departure board. Fraunces for display, Plus Jakarta Sans for UI, IBM Plex Mono for every clock time so times align down a column.

Light and dark are both first-class, sharing one `cp_theme` key across both halves of the product. Set before first paint to avoid a flash.

The carpool's signature element is the **departure rail**: your time at centre, your tolerance drawn as a lit band, other travellers pinned by how far off they are. Matches sit inside the band, near-misses are dimmed outside it.

---

## Known gaps

- **No live status polling.** Flight status is captured once at lookup, so a delay after posting doesn't move the time. This is the main unbuilt feature; it needs a scheduler (Vercel Hobby crons only fire daily, so GitHub Actions or QStash). When it lands, `claimMatchNotification` needs an event and version in its key, or a delay that creates a genuinely new match will be suppressed by the existing per-pair claim.
- **Tests live outside the repo.** They cover the carpool API, authorisation, data leakage, birthday idempotency and the flight provider, but they were written as standalone scripts and aren't wired to `npm test`. Moving them in is worth doing.
- **Two stale npm scripts** (`students:normalize-fields`, `photos:migrate-base64`) reference files that no longer exist.
- **The old directory password is in git history.** It's no longer served, but treat it as public.
