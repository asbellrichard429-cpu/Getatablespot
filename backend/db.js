require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}
async function getOwnerByEmail(email) {
  const r = await query('SELECT * FROM owners WHERE email=$1', [email.toLowerCase().trim()]);
  return r.rows[0] || null;
}
async function getOwnerById(id) {
  const r = await query('SELECT * FROM owners WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function createOwner(data) {
  const r = await query(
    "INSERT INTO owners (email,password_hash,name,phone,restaurant_id,restaurant_name,plan,trial_ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '7 days') RETURNING *",
    [data.email, data.passwordHash, data.name, data.phone||null, data.restaurantId||null, data.restaurantName||null, data.plan||'free']
  );
  return r.rows[0];
}
async function updateOwner(id, fields) {
  const sets = [], vals = [];
  let i = 1;
  const allowed = ['name','phone','notify_email','notify_sms','password_hash','plan','restaurant_id','restaurant_name'];
  for (const [k,v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(k+'=$'+i++); vals.push(v); }
  }
  if (!sets.length) return null;
  sets.push('updated_at=NOW()');
  vals.push(id);
  const r = await query('UPDATE owners SET '+sets.join(',')+' WHERE id=$'+i+' RETURNING *', vals);
  return r.rows[0];
}
async function getRestaurantByPlaceId(placeId) {
  const r = await query('SELECT * FROM restaurants WHERE google_place_id=$1', [placeId]);
  return r.rows[0] || null;
}
async function upsertRestaurant(data) {
  const r = await query(
    'INSERT INTO restaurants (google_place_id,name,owner_id,plan) VALUES ($1,$2,$3,$4) ON CONFLICT (google_place_id) DO UPDATE SET name=EXCLUDED.name,owner_id=COALESCE(EXCLUDED.owner_id,restaurants.owner_id),plan=EXCLUDED.plan,updated_at=NOW() RETURNING *',
    [data.googlePlaceId, data.name, data.ownerId||null, data.plan||'free']
  );
  return r.rows[0];
}
async function updateRestaurant(placeId, fields) {
  const sets = [], vals = [];
  let i = 1;
  const allowed = ['is_open','wait_mins','wait_level','tonight_message','is_featured','plan','stripe_customer_id','stripe_subscription_id'];
  for (const [k,v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(k+'=$'+i++); vals.push(v); }
  }
  if (!sets.length) return null;
  sets.push('updated_at=NOW()');
  vals.push(placeId);
  const r = await query('UPDATE restaurants SET '+sets.join(',')+' WHERE google_place_id=$'+i+' RETURNING *', vals);
  return r.rows[0];
}
async function createReservation(data) {
  const r = await query(
    'INSERT INTO reservations (ref,restaurant_id,restaurant_name,guest_name,guest_email,guest_phone,party_size,requested_time,requested_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [data.ref, data.restaurantId, data.restaurantName, data.guestName, data.guestEmail, data.guestPhone||null, data.partySize||2, data.requestedTime, data.requestedDate||null, data.notes||null]
  );
  return r.rows[0];
}
async function getReservationByRef(ref) {
  const r = await query('SELECT * FROM reservations WHERE ref=$1', [ref]);
  return r.rows[0] || null;
}
async function getReservationsByRestaurant(restaurantId, opts) {
  opts = opts || {};
  const conditions = ['restaurant_id=$1'], vals = [restaurantId];
  let i = 2;
  if (opts.status) { conditions.push('status=$'+i++); vals.push(opts.status); }
  if (opts.date) { conditions.push('requested_date=$'+i++); vals.push(opts.date); }
  vals.push(50);
  const r = await query('SELECT * FROM reservations WHERE '+conditions.join(' AND ')+' ORDER BY created_at DESC LIMIT $'+i, vals);
  return r.rows;
}
async function updateReservationStatus(ref, status, ownerNote) {
  const r = await query(
    'UPDATE reservations SET status=$1,owner_note=$2,updated_at=NOW() WHERE ref=$3 RETURNING *',
    [status, ownerNote||null, ref]
  );
  return r.rows[0];
}
async function getTimeSlots(restaurantId, date) {
  const r = await query('SELECT * FROM time_slots WHERE restaurant_id=$1 AND slot_date=$2 ORDER BY slot_time', [restaurantId, date]);
  return r.rows;
}
async function setTimeSlots(restaurantId, date, slots) {
  await query('DELETE FROM time_slots WHERE restaurant_id=$1 AND slot_date=$2', [restaurantId, date]);
  for (const s of slots) {
    await query('INSERT INTO time_slots (restaurant_id,slot_date,slot_time,capacity,is_available) VALUES ($1,$2,$3,$4,$5)', [restaurantId, date, s.time, s.capacity||4, s.isAvailable!==false]);
  }
}
async function incrementSlotBooked(restaurantId, date, time) {
  await query('UPDATE time_slots SET booked=booked+1 WHERE restaurant_id=$1 AND slot_date=$2 AND slot_time=$3', [restaurantId, date, time]);
}
async function trackEvent(restaurantId, eventType, meta) {
  await query('INSERT INTO analytics (restaurant_id,event_type,meta) VALUES ($1,$2,$3)', [restaurantId, eventType, JSON.stringify(meta||{})]).catch(function(){});
}
async function getAnalytics(restaurantId) {
  const r = await query(
    "SELECT COUNT(*) FILTER (WHERE event_type='view' AND created_at>NOW()-INTERVAL '1 day') AS views_today, COUNT(*) FILTER (WHERE event_type='view' AND created_at>NOW()-INTERVAL '7 days') AS views_week, COUNT(*) FILTER (WHERE event_type='view' AND created_at>NOW()-INTERVAL '30 days') AS views_month, COUNT(*) FILTER (WHERE event_type='reservation_request' AND created_at>NOW()-INTERVAL '1 day') AS requests_today, COUNT(*) FILTER (WHERE event_type='reservation_request' AND created_at>NOW()-INTERVAL '7 days') AS requests_week, COUNT(*) FILTER (WHERE event_type='reservation_request' AND created_at>NOW()-INTERVAL '30 days') AS requests_month, COUNT(*) FILTER (WHERE event_type='reservation_confirmed' AND created_at>NOW()-INTERVAL '30 days') AS confirmed_month FROM analytics WHERE restaurant_id=$1",
    [restaurantId]
  );
  const d = r.rows[0];
  return { views:{today:+d.views_today,week:+d.views_week,month:+d.views_month}, requests:{today:+d.requests_today,week:+d.requests_week,month:+d.requests_month}, confirmed:{month:+d.confirmed_month}, conversionRate:+d.requests_month>0?Math.round((+d.confirmed_month/+d.requests_month)*100):0 };
}
async function createPasswordReset(ownerId, token) {
  await query('DELETE FROM password_resets WHERE owner_id=$1', [ownerId]);
  await query("INSERT INTO password_resets (owner_id,token,expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 hour')", [ownerId, token]);
}
async function getPasswordReset(token) {
  const r = await query('SELECT pr.*,o.email FROM password_resets pr JOIN owners o ON o.id=pr.owner_id WHERE pr.token=$1 AND pr.expires_at>NOW() AND pr.used=false', [token]);
  return r.rows[0] || null;
}
async function markPasswordResetUsed(token) {
  await query('UPDATE password_resets SET used=true WHERE token=$1', [token]);
}
module.exports = { query, pool, getOwnerByEmail, getOwnerById, createOwner, updateOwner, getRestaurantByPlaceId, upsertRestaurant, updateRestaurant, createReservation, getReservationByRef, getReservationsByRestaurant, updateReservationStatus, getTimeSlots, setTimeSlots, incrementSlotBooked, trackEvent, getAnalytics, createPasswordReset, getPasswordReset, markPasswordResetUsed };
