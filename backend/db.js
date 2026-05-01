// db.js — GetATableSpot Database Layer
// Uses PostgreSQL via Neon (neon.tech) — free tier works fine
// Run `node db.js --init` once to create all tables
//
// Required env var:
//   DATABASE_URL=postgres://user:pass@host/dbname?sslmode=require

require(‘dotenv’).config();
const { Pool } = require(‘pg’);

const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false },
max: 10,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 5000,
});

// ── Test connection ──
pool.on(‘error’, (err) => {
console.error(‘Unexpected DB pool error:’, err.message);
});

async function query(text, params) {
const start = Date.now();
try {
const res = await pool.query(text, params);
const duration = Date.now() - start;
if (duration > 1000) console.warn(`Slow query (${duration}ms):`, text.slice(0, 80));
return res;
} catch (err) {
console.error(‘DB query error:’, err.message, ‘\nQuery:’, text.slice(0, 120));
throw err;
}
}

// ── Schema ──
const SCHEMA = `

– Owners: restaurant staff who log into the dashboard
CREATE TABLE IF NOT EXISTS owners (
id            SERIAL PRIMARY KEY,
email         TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
name          TEXT NOT NULL,
phone         TEXT,
restaurant_id TEXT,                          – Google Place ID
restaurant_name TEXT,
notify_email  BOOLEAN DEFAULT true,
notify_sms    BOOLEAN DEFAULT true,
plan          TEXT DEFAULT ‘free’,           – free | basic | pro | elite
stripe_customer_id      TEXT,
stripe_subscription_id  TEXT,
trial_ends_at TIMESTAMPTZ,
created_at    TIMESTAMPTZ DEFAULT NOW(),
updated_at    TIMESTAMPTZ DEFAULT NOW()
);

– Restaurant profiles: live data owners control
CREATE TABLE IF NOT EXISTS restaurants (
id              SERIAL PRIMARY KEY,
google_place_id TEXT UNIQUE NOT NULL,
name            TEXT NOT NULL,
address         TEXT,
owner_id        INTEGER REFERENCES owners(id) ON DELETE SET NULL,
plan            TEXT DEFAULT ‘free’,
is_featured     BOOLEAN DEFAULT false,
is_open         BOOLEAN DEFAULT true,
wait_mins       INTEGER DEFAULT 0,
wait_level      TEXT DEFAULT ‘low’,          – none | low | med | high
tonight_message TEXT,                        – e.g. “Live jazz tonight!”
phone           TEXT,
website         TEXT,
photo_url       TEXT,
stripe_customer_id      TEXT,
stripe_subscription_id  TEXT,
activated_at    TIMESTAMPTZ,
created_at      TIMESTAMPTZ DEFAULT NOW(),
updated_at      TIMESTAMPTZ DEFAULT NOW()
);

– Reservations: all booking requests
CREATE TABLE IF NOT EXISTS reservations (
id                  SERIAL PRIMARY KEY,
ref                 TEXT UNIQUE NOT NULL,    – GATS-xxxxx confirmation number
restaurant_id       TEXT NOT NULL,           – Google Place ID
restaurant_name     TEXT,
guest_name          TEXT NOT NULL,
guest_email         TEXT NOT NULL,
guest_phone         TEXT,
party_size          INTEGER DEFAULT 2,
requested_time      TEXT NOT NULL,
requested_date      TEXT,
notes               TEXT,
status              TEXT DEFAULT ‘pending’,  – pending | confirmed | declined | seated | no_show
owner_note          TEXT,                    – message from owner back to diner
confirmed_at        TIMESTAMPTZ,
declined_at         TIMESTAMPTZ,
seated_at           TIMESTAMPTZ,
notification_sent   BOOLEAN DEFAULT false,
created_at          TIMESTAMPTZ DEFAULT NOW(),
updated_at          TIMESTAMPTZ DEFAULT NOW()
);

– Time slots: owner-managed availability per date
CREATE TABLE IF NOT EXISTS time_slots (
id              SERIAL PRIMARY KEY,
restaurant_id   TEXT NOT NULL,
slot_date       DATE NOT NULL,
slot_time       TEXT NOT NULL,               – e.g. “6:30 PM”
capacity        INTEGER DEFAULT 4,           – seats available for this slot
booked          INTEGER DEFAULT 0,
is_available    BOOLEAN DEFAULT true,
created_at      TIMESTAMPTZ DEFAULT NOW(),
UNIQUE(restaurant_id, slot_date, slot_time)
);

– Analytics events: lightweight tracking
CREATE TABLE IF NOT EXISTS analytics (
id              SERIAL PRIMARY KEY,
restaurant_id   TEXT NOT NULL,
event_type      TEXT NOT NULL,               – view | reservation_request | reservation_confirmed
meta            JSONB,
created_at      TIMESTAMPTZ DEFAULT NOW()
);

– Password reset tokens
CREATE TABLE IF NOT EXISTS password_resets (
id          SERIAL PRIMARY KEY,
owner_id    INTEGER REFERENCES owners(id) ON DELETE CASCADE,
token       TEXT UNIQUE NOT NULL,
expires_at  TIMESTAMPTZ NOT NULL,
used        BOOLEAN DEFAULT false,
created_at  TIMESTAMPTZ DEFAULT NOW()
);

– Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_reservations_restaurant ON reservations(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status     ON reservations(status);
CREATE INDEX IF NOT EXISTS idx_reservations_date       ON reservations(requested_date);
CREATE INDEX IF NOT EXISTS idx_time_slots_restaurant   ON time_slots(restaurant_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_analytics_restaurant    ON analytics(restaurant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_owners_email            ON owners(email);
CREATE INDEX IF NOT EXISTS idx_restaurants_place_id   ON restaurants(google_place_id);

`;

// ── Init: run once to create all tables ──
async function initDB() {
console.log(‘🔧 Initializing database schema…’);
try {
await pool.query(SCHEMA);
console.log(‘✅ All tables created successfully.’);

```
// Verify
const { rows } = await pool.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name
`);
console.log('📋 Tables:', rows.map(r => r.table_name).join(', '));
```

} catch (err) {
console.error(‘❌ Schema init failed:’, err.message);
process.exit(1);
} finally {
await pool.end();
}
}

// ── DB helpers ──

// Owners
async function createOwner({ email, passwordHash, name, phone, restaurantId, restaurantName, plan }) {
const { rows } = await query(
`INSERT INTO owners (email, password_hash, name, phone, restaurant_id, restaurant_name, plan, trial_ends_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '7 days') RETURNING id, email, name, phone, restaurant_id, restaurant_name, plan, trial_ends_at, created_at`,
[email, passwordHash, name, phone || null, restaurantId || null, restaurantName || null, plan || ‘free’]
);
return rows[0];
}

async function getOwnerByEmail(email) {
const { rows } = await query(
`SELECT * FROM owners WHERE email = $1`,
[email.toLowerCase().trim()]
);
return rows[0] || null;
}

async function getOwnerById(id) {
const { rows } = await query(
`SELECT id, email, name, phone, restaurant_id, restaurant_name, plan,  notify_email, notify_sms, trial_ends_at, created_at FROM owners WHERE id = $1`,
[id]
);
return rows[0] || null;
}

async function updateOwner(id, fields) {
const sets = [];
const vals = [];
let i = 1;
const allowed = [‘name’,‘phone’,‘notify_email’,‘notify_sms’,‘password_hash’,‘plan’,
‘stripe_customer_id’,‘stripe_subscription_id’,‘restaurant_id’,‘restaurant_name’];
for (const [k, v] of Object.entries(fields)) {
if (allowed.includes(k)) { sets.push(`${k} = $${i++}`); vals.push(v); }
}
if (!sets.length) return null;
sets.push(`updated_at = NOW()`);
vals.push(id);
const { rows } = await query(
`UPDATE owners SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
vals
);
return rows[0];
}

// Restaurants
async function upsertRestaurant({ googlePlaceId, name, address, ownerId, plan }) {
const { rows } = await query(
`INSERT INTO restaurants (google_place_id, name, address, owner_id, plan, activated_at) VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (google_place_id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, owner_id = COALESCE(EXCLUDED.owner_id, restaurants.owner_id), plan = EXCLUDED.plan, updated_at = NOW() RETURNING *`,
[googlePlaceId, name, address || null, ownerId || null, plan || ‘free’]
);
return rows[0];
}

async function getRestaurantByPlaceId(placeId) {
const { rows } = await query(
`SELECT * FROM restaurants WHERE google_place_id = $1`,
[placeId]
);
return rows[0] || null;
}

async function updateRestaurant(placeId, fields) {
const sets = [];
const vals = [];
let i = 1;
const allowed = [‘is_open’,‘wait_mins’,‘wait_level’,‘tonight_message’,‘is_featured’,
‘plan’,‘phone’,‘website’,‘photo_url’,‘name’,‘address’,
‘stripe_customer_id’,‘stripe_subscription_id’];
for (const [k, v] of Object.entries(fields)) {
if (allowed.includes(k)) { sets.push(`${k} = $${i++}`); vals.push(v); }
}
if (!sets.length) return null;
sets.push(`updated_at = NOW()`);
vals.push(placeId);
const { rows } = await query(
`UPDATE restaurants SET ${sets.join(', ')} WHERE google_place_id = $${i} RETURNING *`,
vals
);
return rows[0];
}

// Reservations
async function createReservation({ ref, restaurantId, restaurantName, guestName, guestEmail,
guestPhone, partySize, requestedTime, requestedDate, notes }) {
const { rows } = await query(
`INSERT INTO reservations (ref, restaurant_id, restaurant_name, guest_name, guest_email, guest_phone, party_size, requested_time, requested_date, notes, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING *`,
[ref, restaurantId, restaurantName, guestName, guestEmail, guestPhone || null,
partySize || 2, requestedTime, requestedDate || null, notes || null]
);
return rows[0];
}

async function getReservationsByRestaurant(restaurantId, { status, date, limit = 50 } = {}) {
const conditions = [‘restaurant_id = $1’];
const vals = [restaurantId];
let i = 2;
if (status) { conditions.push(`status = $${i++}`); vals.push(status); }
if (date)   { conditions.push(`requested_date = $${i++}`); vals.push(date); }
vals.push(limit);
const { rows } = await query(
`SELECT * FROM reservations WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${i}`,
vals
);
return rows;
}

async function updateReservationStatus(ref, status, ownerNote) {
const statusCols = {
confirmed: ‘confirmed_at = NOW(),’,
declined:  ‘declined_at = NOW(),’,
seated:    ‘seated_at = NOW(),’,
no_show:   ‘’,
pending:   ‘’,
};
const extra = statusCols[status] || ‘’;
const { rows } = await query(
`UPDATE reservations SET status = $1, ${extra} owner_note = $2, updated_at = NOW() WHERE ref = $3 RETURNING *`,
[status, ownerNote || null, ref]
);
return rows[0];
}

async function getReservationByRef(ref) {
const { rows } = await query(
`SELECT * FROM reservations WHERE ref = $1`,
[ref]
);
return rows[0] || null;
}

// Time slots
async function setTimeSlots(restaurantId, date, slots) {
// slots = [{ time, capacity, isAvailable }]
const client = await pool.connect();
try {
await client.query(‘BEGIN’);
// Remove existing slots for this date
await client.query(
`DELETE FROM time_slots WHERE restaurant_id = $1 AND slot_date = $2`,
[restaurantId, date]
);
// Insert new slots
for (const s of slots) {
await client.query(
`INSERT INTO time_slots (restaurant_id, slot_date, slot_time, capacity, is_available) VALUES ($1, $2, $3, $4, $5)`,
[restaurantId, date, s.time, s.capacity || 4, s.isAvailable !== false]
);
}
await client.query(‘COMMIT’);
} catch (err) {
await client.query(‘ROLLBACK’);
throw err;
} finally {
client.release();
}
}

async function getTimeSlots(restaurantId, date) {
const { rows } = await query(
`SELECT * FROM time_slots WHERE restaurant_id = $1 AND slot_date = $2 ORDER BY slot_time`,
[restaurantId, date]
);
return rows;
}

async function incrementSlotBooked(restaurantId, date, time) {
await query(
`UPDATE time_slots SET booked = booked + 1, is_available = CASE WHEN booked + 1 >= capacity THEN false ELSE true END WHERE restaurant_id = $1 AND slot_date = $2 AND slot_time = $3`,
[restaurantId, date, time]
);
}

// Analytics
async function trackEvent(restaurantId, eventType, meta = {}) {
await query(
`INSERT INTO analytics (restaurant_id, event_type, meta) VALUES ($1, $2, $3)`,
[restaurantId, eventType, JSON.stringify(meta)]
).catch(() => {}); // fire-and-forget — never let analytics crash the app
}

async function getAnalytics(restaurantId) {
const { rows } = await query(
`SELECT COUNT(*) FILTER (WHERE event_type='view' AND created_at > NOW()-INTERVAL '1 day')      AS views_today, COUNT(*) FILTER (WHERE event_type='view' AND created_at > NOW()-INTERVAL '7 days')     AS views_week, COUNT(*) FILTER (WHERE event_type='view' AND created_at > NOW()-INTERVAL '30 days')    AS views_month, COUNT(*) FILTER (WHERE event_type='reservation_request' AND created_at > NOW()-INTERVAL '1 day')  AS requests_today, COUNT(*) FILTER (WHERE event_type='reservation_request' AND created_at > NOW()-INTERVAL '7 days') AS requests_week, COUNT(*) FILTER (WHERE event_type='reservation_request' AND created_at > NOW()-INTERVAL '30 days') AS requests_month, COUNT(*) FILTER (WHERE event_type='reservation_confirmed' AND created_at > NOW()-INTERVAL '30 days') AS confirmed_month FROM analytics WHERE restaurant_id = $1`,
[restaurantId]
);
const r = rows[0];
const reqMonth = parseInt(r.requests_month) || 0;
const confMonth = parseInt(r.confirmed_month) || 0;
return {
views:        { today: +r.views_today, week: +r.views_week, month: +r.views_month },
requests:     { today: +r.requests_today, week: +r.requests_week, month: +r.requests_month },
confirmed:    { month: confMonth },
conversionRate: reqMonth > 0 ? Math.round((confMonth / reqMonth) * 100) : 0,
};
}

// Password resets
async function createPasswordReset(ownerId, token) {
await query(`DELETE FROM password_resets WHERE owner_id = $1`, [ownerId]);
await query(
`INSERT INTO password_resets (owner_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
[ownerId, token]
);
}

async function getPasswordReset(token) {
const { rows } = await query(
`SELECT pr.*, o.email FROM password_resets pr JOIN owners o ON o.id = pr.owner_id WHERE pr.token = $1 AND pr.expires_at > NOW() AND pr.used = false`,
[token]
);
return rows[0] || null;
}

async function markPasswordResetUsed(token) {
await query(`UPDATE password_resets SET used = true WHERE token = $1`, [token]);
}

module.exports = {
query, pool,
// owners
createOwner, getOwnerByEmail, getOwnerById, updateOwner,
// restaurants
upsertRestaurant, getRestaurantByPlaceId, updateRestaurant,
// reservations
createReservation, getReservationsByRestaurant, updateReservationStatus, getReservationByRef,
// time slots
setTimeSlots, getTimeSlots, incrementSlotBooked,
// analytics
trackEvent, getAnalytics,
// password resets
createPasswordReset, getPasswordReset, markPasswordResetUsed,
};

// Run `node db.js --init` to initialize tables
if (require.main === module && process.argv.includes(’–init’)) {
initDB();
}
