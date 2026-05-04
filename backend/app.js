require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Stripe = require('stripe');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const twilio = require('twilio');
const db = require('./db');

const app = express();
app.set('trust proxy', 1);

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const cache = new NodeCache({ stdTTL: 3600 });
const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 60_000, max: 200 }));

const G_KEY = process.env.GOOGLE_PLACES_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_CHANGE_IN_PROD';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'asbellrichard429@gmail.com';
const APP_URL = process.env.APP_URL || 'https://getatablespot.com';
const G_BASE = 'https://places.googleapis.com/v1';

const STRIPE_PRICES = {
  basic: process.env.STRIPE_PRICE_BASIC,
  pro: process.env.STRIPE_PRICE_PRO,
  elite: process.env.STRIPE_PRICE_ELITE,
  diner: process.env.STRIPE_PRICE_DINER,
};

const PLAN_INFO = {
  basic: { label: 'Basic', price: '$49/month', trial: 7 },
  pro: { label: 'Pro', price: '$99/month', trial: 7 },
  elite: { label: 'Elite', price: '$299/month', trial: 7 },
  diner: { label: 'Pro', price: '$2.99/month', trial: 7 },
};

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.owner = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function calcDist(lat1, lng1, lat2, lng2) {
  const R = 3958.8, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
}

function genRef() { return 'GATS-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase(); }

async function sendEmail({ to, subject, html }) {
  if (!RESEND_KEY) { console.warn('RESEND_KEY not set'); return; }
  try {
    await axios.post('https://api.resend.com/emails',
      { from: 'GetATableSpot <notifications@getatablespot.com>', to, subject, html },
      { headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.error('Email error:', e.response ? e.response.data : e.message); }
}

async function sendSMS(to, body) {
  if (!twilioClient || !to) return;
  try {
    const fmt = to.startsWith('+') ? to : '+1' + to.replace(/\D/g, '');
    if (fmt.replace(/\D/g, '').length < 10) return;
    await twilioClient.messages.create({ body, from: process.env.TWILIO_FROM_NUMBER, to: fmt });
  } catch (e) { console.error('SMS error:', e.message); }
}

const PRICE_MAP = {
  PRICE_LEVEL_FREE: 'Free', PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$', PRICE_LEVEL_EXPENSIVE: '$$$', PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};

function estimateWait(gp) {
  const h = new Date().getHours(), peak = h >= 18 && h <= 21;
  if (!gp.currentOpeningHours || !gp.currentOpeningHours.openNow) return { waitMins: 0, waitLevel: 'none' };
  if (!peak) { const m = Math.floor(Math.random() * 10); return { waitMins: m, waitLevel: m < 10 ? 'low' : 'med' }; }
  const pr = PRICE_MAP[gp.priceLevel] || '$$';
  const m = pr === '$$$$' ? Math.floor(30 + Math.random() * 30) : pr === '$$$' ? Math.floor(15 + Math.random() * 25) : Math.floor(Math.random() * 20);
  return { waitMins: m, waitLevel: m < 15 ? 'low' : m < 30 ? 'med' : 'high' };
}

function buildVenue(gp, uLat, uLng) {
  const ww = estimateWait(gp);
  const photo = gp.photos && gp.photos[0] ? gp.photos[0].name : null;
  const pLat = gp.location ? gp.location.latitude : null;
  const pLng = gp.location ? gp.location.longitude : null;
  const dist = (uLat && uLng && pLat && pLng) ? calcDist(uLat, uLng, pLat, pLng) + ' mi' : 'nearby';
  return {
    id: gp.id,
    name: gp.displayName ? gp.displayName.text : 'Unknown',
    address: gp.formattedAddress || '',
    location: gp.location,
    cuisine: (gp.primaryType || 'restaurant').replace(/_/g, ' '),
    rating: gp.rating || 0,
    reviews: gp.userRatingCount || 0,
    price: PRICE_MAP[gp.priceLevel] || '$$',
    isOpen: gp.currentOpeningHours ? gp.currentOpeningHours.openNow || false : false,
    hours: gp.currentOpeningHours ? gp.currentOpeningHours.weekdayDescriptions || [] : [],
    phone: gp.internationalPhoneNumber || '',
    website: gp.websiteUri || '',
    photoUrl: photo ? G_BASE + '/' + photo + '/media?maxWidthPx=800&key=' + G_KEY : null,
    types: gp.types || [],
    outdoor: gp.outdoorSeating || false,
    reservable: gp.reservable || false,
    tags: [],
    waitMins: ww.waitMins,
    waitLevel: ww.waitLevel,
    distance: dist,
    sources: ['google'].concat(gp.reservable ? ['opentable'] : []),
    isFeatured: false,
    plan: 'free',
    tonightMsg: null,
    emoji: '🍽️',
    bg: 'linear-gradient(135deg,#1A1A1A,#333)',
  };
}

async function mergeWithDB(gp, uLat, uLng) {
  const v = buildVenue(gp, uLat, uLng);
  try {
    const p = await db.getRestaurantByPlaceId(gp.id);
    if (p) {
      v.waitMins = p.wait_mins != null ? p.wait_mins : v.waitMins;
      v.waitLevel = p.wait_level || v.waitLevel;
      v.isOpen = p.is_open != null ? p.is_open : v.isOpen;
      v.isFeatured = p.is_featured || false;
      v.tonightMsg = p.tonight_message || null;
      v.plan = p.plan;
    }
  } catch (e) {}
  return v;
}

async function googleNearbySearch(lat, lng, radius, types) {
  const body = {
    locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: radius } },
    includedTypes: Array.isArray(types) ? types : [types],
    maxResultCount: 20,
    rankPreference: 'POPULARITY',
  };
  const fields = 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.photos,places.types,places.primaryType,places.internationalPhoneNumber,places.websiteUri,places.dineIn,places.reservable,places.outdoorSeating';
  try {
    const res = await axios.post(G_BASE + '/places:searchNearby', body, {
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': G_KEY, 'X-Goog-FieldMask': fields }
    });
    return res.data.places || [];
  } catch (e) { console.error('Google error:', e.response ? e.response.data : e.message); return []; }
}

const CUISINE_MAP = {
  all: 'restaurant', italian: 'italian_restaurant', japanese: 'japanese_restaurant',
  mexican: 'mexican_restaurant', american: 'american_restaurant', bargrill: 'bar',
  sportsbar: 'sports_bar', chinese: 'chinese_restaurant', indian: 'indian_restaurant',
  french: 'french_restaurant', thai: 'thai_restaurant', steakhouse: 'steak_house',
  seafood: 'seafood_restaurant', pizza: 'pizza_restaurant', brunch: 'breakfast_restaurant',
};

async function googleNearby(lat, lng, radius, cuisine) {
  radius = radius || 12000;
  cuisine = cuisine || 'all';
  const key = 'gnearby:' + lat.toFixed(3) + ':' + lng.toFixed(3) + ':' + radius + ':' + cuisine;
  const cached = cache.get(key);
  if (cached) return cached;
  const type = CUISINE_MAP[cuisine] || 'restaurant';
  const off = 0.022;
  const centers = [
    { lat: lat, lng: lng }, { lat: lat + off, lng: lng }, { lat: lat - off, lng: lng },
    { lat: lat, lng: lng + off }, { lat: lat, lng: lng - off }
  ];
  const all = await Promise.all(centers.map(function(c) { return googleNearbySearch(c.lat, c.lng, Math.round(radius * 0.65), [type]); }));
  const seen = new Set();
  const combined = [];
  for (const results of all) {
    for (const p of results) {
      if (!seen.has(p.id)) { seen.add(p.id); combined.push(p); }
    }
  }
  combined.sort(function(a, b) { return (b.rating || 0) - (a.rating || 0); });
  cache.set(key, combined, 3600);
  return combined;
}

function mockSlots() {
  return ['5:30 PM', '6:00 PM', '6:30 PM', '7:00 PM', '7:30 PM', '8:00 PM', '8:30 PM', '9:00 PM']
    .map(function(time, i) { return { time: time, available: Math.random() > 0.35, remaining: Math.floor(Math.random() * 6) + 1, isPro: i < 2 }; });
}

app.post('/api/auth/register', async function(req, res) {
  try {
    const email = req.body.email, password = req.body.password, name = req.body.name;
    const phone = req.body.phone, restaurantId = req.body.restaurantId;
    const restaurantName = req.body.restaurantName, plan = req.body.plan;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const existing = await db.getOwnerByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
    const passwordHash = await bcrypt.hash(password, 12);
    const owner = await db.createOwner({ email: email.toLowerCase().trim(), passwordHash, name, phone, restaurantId, restaurantName, plan });
    if (restaurantId) await db.upsertRestaurant({ googlePlaceId: restaurantId, name: restaurantName || 'My Restaurant', ownerId: owner.id, plan: plan || 'free' });
    const token = jwt.sign({ id: owner.id, email: owner.email }, JWT_SECRET, { expiresIn: '30d' });
    await sendEmail({ to: owner.email, subject: 'Welcome to GetATableSpot', html: '<p>Your dashboard is ready. <a href="' + APP_URL + '/restaurant-dashboard.html">Go to Dashboard</a></p>' });
    res.json({ token, owner: { id: owner.id, email: owner.email, name: owner.name, restaurantId: owner.restaurant_id, restaurantName: owner.restaurant_name, plan: owner.plan } });
  } catch (e) { console.error('Register:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async function(req, res) {
  try {
    const email = req.body.email, password = req.body.password;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const owner = await db.getOwnerByEmail(email);
    if (!owner) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, owner.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: owner.id, email: owner.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, owner: { id: owner.id, email: owner.email, name: owner.name, phone: owner.phone, restaurantId: owner.restaurant_id, restaurantName: owner.restaurant_name, plan: owner.plan, notifyEmail: owner.notify_email, notifySms: owner.notify_sms } });
  } catch (e) { console.error('Login:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', requireAuth, async function(req, res) {
  try {
    const o = await db.getOwnerById(req.owner.id);
    if (!o) return res.status(404).json({ error: 'Not found' });
    res.json({ owner: o });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/auth/me', requireAuth, async function(req, res) {
  try {
    const updates = {};
    if (req.body.name) updates.name = req.body.name;
    if (req.body.phone !== undefined) updates.phone = req.body.phone;
    if (req.body.notifyEmail !== undefined) updates.notify_email = req.body.notifyEmail;
    if (req.body.notifySms !== undefined) updates.notify_sms = req.body.notifySms;
    if (req.body.newPassword) {
      if (!req.body.currentPassword) return res.status(400).json({ error: 'Current password required' });
      const r = await db.query('SELECT password_hash FROM owners WHERE id=$1', [req.owner.id]);
      if (!await bcrypt.compare(req.body.currentPassword, r.rows[0].password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
      updates.password_hash = await bcrypt.hash(req.body.newPassword, 12);
    }
    const updated = await db.updateOwner(req.owner.id, updates);
    res.json({ success: true, owner: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/forgot-password', async function(req, res) {
  try {
    const owner = await db.getOwnerByEmail(req.body.email);
    if (!owner) return res.json({ success: true });
    const token = crypto.randomBytes(32).toString('hex');
    await db.createPasswordReset(owner.id, token);
    await sendEmail({ to: owner.email, subject: 'Reset your password', html: '<p><a href="' + APP_URL + '/restaurant-auth.html?reset=' + token + '">Reset Password</a> — expires in 1 hour.</p>' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/reset-password', async function(req, res) {
  try {
    const token = req.body.token, password = req.body.password;
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const reset = await db.getPasswordReset(token);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset link' });
    await db.updateOwner(reset.owner_id, { password_hash: await bcrypt.hash(password, 12) });
    await db.markPasswordResetUsed(token);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/restaurant', requireAuth, async function(req, res) {
  try {
    const o = await db.getOwnerById(req.owner.id);
    if (!o || !o.restaurant_id) return res.status(404).json({ error: 'No restaurant linked' });
    const p = await db.getRestaurantByPlaceId(o.restaurant_id);
    res.json({ restaurant: p || { google_place_id: o.restaurant_id, name: o.restaurant_name, plan: o.plan } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/dashboard/restaurant', requireAuth, async function(req, res) {
  try {
    const o = await db.getOwnerById(req.owner.id);
    if (!o || !o.restaurant_id) return res.status(404).json({ error: 'No restaurant linked' });
    const u = {};
    if (req.body.waitMins !== undefined) { u.wait_mins = parseInt(req.body.waitMins); u.wait_level = req.body.waitMins < 1 ? 'none' : req.body.waitMins < 15 ? 'low' : req.body.waitMins < 30 ? 'med' : 'high'; }
    if (req.body.isOpen !== undefined) u.is_open = req.body.isOpen;
    if (req.body.tonightMessage !== undefined) u.tonight_message = req.body.tonightMessage;
    const updated = await db.updateRestaurant(o.restaurant_id, u);
    cache.flushAll();
    res.json({ success: true, restaurant: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/reservations', requireAuth, async function(req, res) {
  try {
    const o = await db.getOwnerById(req.owner.id);
    if (!o || !o.restaurant_id) return res.json({ reservations: [] });
    const reservations = await db.getReservationsByRestaurant(o.restaurant_id, { status: req.query.status, date: req.query.date });
    res.json({ reservations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/dashboard/reservations/:ref', requireAuth, async function(req, res) {
  try {
    const status = req.body.status, ownerNote = req.body.ownerNote;
    const valid = ['confirmed', 'declined', 'seated', 'no_show', 'pending'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const reservation = await db.getReservationByRef(req.params.ref);
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    const o = await db.getOwnerById(req.owner.id);
    if (reservation.restaurant_id !== o.restaurant_id) return res.status(403).json({ error: 'Not authorized' });
    const updated = await db.updateReservationStatus(req.params.ref, status, ownerNote);
    await db.trackEvent(reservation.restaurant_id, 'reservation_' + status, { ref: req.params.ref }).catch(function() {});
    if (status === 'confirmed') {
      await sendEmail({ to: reservation.guest_email, subject: 'Confirmed — ' + reservation.restaurant_name + ' at ' + reservation.requested_time, html: '<p>Hi ' + reservation.guest_name.split(' ')[0] + '! Your table is confirmed at ' + reservation.restaurant_name + ' at ' + reservation.requested_time + ' for ' + reservation.party_size + ' guests. Ref: ' + reservation.ref + '</p>' + (ownerNote ? '<p>' + ownerNote + '</p>' : '') });
      await sendSMS(reservation.guest_phone, 'Confirmed! ' + reservation.restaurant_name + ' at ' + reservation.requested_time + ', party of ' + reservation.party_size + '. Ref: ' + reservation.ref);
    }
    if (status === 'declined') {
      await sendEmail({ to: reservation.guest_email, subject: 'Update on your reservation at ' + reservation.restaurant_name, html: '<p>Hi ' + reservation.guest_name.split(' ')[0] + ', unfortunately ' + reservation.restaurant_name + ' cannot accommodate your ' + reservation.requested_time + ' request.' + (ownerNote ? ' ' + ownerNote : '') + '</p>' });
    }
    res.json({ success: true, reservation: updated });
  } catch (e) { console.error('Reservation update:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/slots/:date', requireAuth, async function(req, res) {
  try {
    const o = await db.getOwnerById(req.owner.id);
    if (!o || !o.restaurant_id) return res.json({ slots: [] });
    res.json({ slots: await db.getTimeSlots(o.restaurant_id, req.params.date) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dashboard/slots/:date', requireAuth, async function(req, res) {
  try {
    const o = await db.getOwnerById(req.owner.id);
    if (!o || !o.restaurant_id) return res.status(404).json({ error: 'No restaurant linked' });
    if (!Array.isArray(req.body.slots)) return res.status(400).json({ error: 'slots must be an array' });
    await db.setTimeSlots(o.restaurant_id, req.params.date, req.body.slots);
    cache.flushAll();
    res.json({ success: true, count: req.body.slots.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/analytics', requireAuth, async function(req, res) {
  try {
    const o = await db.getOwnerById(req.owner.id);
    if (!o || !o.restaurant_id) return res.json({ views: {}, requests: {}, confirmed: {}, conversionRate: 0 });
    res.json(await db.getAnalytics(o.restaurant_id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/venues', async function(req, res) {
  try {
    const lat = req.query.lat, lng = req.query.lng;
    const radius = req.query.radius || 12000, cuisine = req.query.cuisine || 'all';
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
    const uLat = parseFloat(lat), uLng = parseFloat(lng);
    const results = await googleNearby(uLat, uLng, parseInt(radius), cuisine);
    const venues = await Promise.all(results.map(function(gp) { return mergeWithDB(gp, uLat, uLng); }));
    venues.sort(function(a, b) { return (b.isFeatured - a.isFeatured) || (b.rating - a.rating); });
    res.json({ venues: venues, total: venues.length });
  } catch (e) { console.error('GET /api/venues:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/venues/:id', async function(req, res) {
  try {
    const fields = 'id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,currentOpeningHours,photos,reviews,types,internationalPhoneNumber,websiteUri';
    const result = await axios.get(G_BASE + '/places/' + req.params.id, { headers: { 'X-Goog-Api-Key': G_KEY, 'X-Goog-FieldMask': fields } });
    res.json({ venue: result.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/venues/:id/slots', async function(req, res) {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const dbSlots = await db.getTimeSlots(req.params.id, date);
    const slots = dbSlots.length ? dbSlots.map(function(s) { return { time: s.slot_time, available: s.is_available, remaining: s.capacity - s.booked }; }) : mockSlots();
    res.json({ slots: slots, date: date, venueId: req.params.id });
  } catch (e) { res.json({ slots: mockSlots(), date: req.query.date, venueId: req.params.id }); }
});

app.get('/api/search', async function(req, res) {
  try {
    if (!req.query.q) return res.status(400).json({ error: 'q required' });
    const result = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', { params: { query: req.query.q, key: G_KEY } });
    res.json({ results: result.data.results || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reservations', async function(req, res) {
  try {
    const b = req.body;
    if (!b.venueId || !b.guestName || !b.guestEmail || !b.time) return res.status(400).json({ error: 'Missing required fields' });
    const ref = genRef();
    await db.createReservation({ ref, restaurantId: b.venueId, restaurantName: b.restaurantName, guestName: b.guestName, guestEmail: b.guestEmail, guestPhone: b.guestPhone || b.restaurantPhone || null, partySize: parseInt(b.partySize) || 2, requestedTime: b.time, requestedDate: b.date || new Date().toISOString().split('T')[0], notes: b.notes });
    await db.trackEvent(b.venueId, 'reservation_request', { ref, partySize: b.partySize }).catch(function() {});
    if (b.date && b.time) db.incrementSlotBooked(b.venueId, b.date, b.time).catch(function() {});
    const profile = await db.getRestaurantByPlaceId(b.venueId).catch(function() { return null; });
    const owner = profile && profile.owner_id ? await db.getOwnerById(profile.owner_id).catch(function() { return null; }) : null;
    if (owner) {
      if (owner.notify_email) await sendEmail({ to: owner.email, subject: 'New Reservation — ' + b.guestName + ' x' + b.partySize + ' at ' + b.time, html: '<p>' + b.guestName + ' · ' + b.guestEmail + (b.guestPhone ? ' · ' + b.guestPhone : '') + '<br>Party of ' + b.partySize + ' at ' + b.time + '<br>Ref: ' + ref + '</p><a href="' + APP_URL + '/restaurant-dashboard.html">Confirm or Decline</a>' });
      if (owner.notify_sms && owner.phone) await sendSMS(owner.phone, 'GetATableSpot: New reservation! ' + b.guestName + ', party of ' + b.partySize + ' at ' + b.time + '. Ref: ' + ref);
    } else {
      await sendEmail({ to: NOTIFY_EMAIL, subject: 'Reservation — ' + b.restaurantName + ' · ' + b.guestName, html: '<p>' + b.guestName + ' · ' + b.guestEmail + '<br>x' + b.partySize + ' at ' + b.time + '<br>Ref: ' + ref + '</p>' });
    }
    await sendEmail({ to: b.guestEmail, subject: 'Request Sent — ' + b.restaurantName + ' at ' + b.time, html: '<p>Hi ' + b.guestName.split(' ')[0] + '! Your request has been sent to ' + b.restaurantName + '. They will confirm shortly. Ref: ' + ref + '</p>' });
    res.json({ success: true, confirmationNumber: ref });
  } catch (e) { console.error('Reservation:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/restaurant-claim', async function(req, res) {
  try {
    const b = req.body;
    if (!b.restaurantName || !b.email || !b.plan) return res.status(400).json({ error: 'restaurantName, email, plan required' });
    const pi = PLAN_INFO[b.plan] || PLAN_INFO.pro;
    let stripeLink = '';
    const priceId = STRIPE_PRICES[b.plan];
    if (priceId && process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('placeholder')) {
      try {
        const s = await stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ['card'], line_items: [{ price: priceId, quantity: 1 }], subscription_data: { trial_period_days: pi.trial }, customer_email: b.email, success_url: APP_URL + '/restaurant-dashboard.html?plan=' + b.plan, cancel_url: APP_URL + '/claim-restaurant.html?cancelled=1', metadata: { restaurantName: b.restaurantName, ownerName: b.ownerName, email: b.email, plan: b.plan, venueId: b.venueId || '' } });
        stripeLink = s.url;
      } catch (e) { console.error('Stripe:', e.message); }
    }
    if (!stripeLink) { stripeLink = process.env['STRIPE_LINK_' + b.plan.toUpperCase()] || APP_URL + '/restaurant-auth.html'; }
    await sendEmail({ to: NOTIFY_EMAIL, subject: 'New Claim — ' + b.restaurantName, html: '<p>' + b.restaurantName + ' · ' + b.email + ' · ' + pi.label + '</p><a href="' + stripeLink + '">' + stripeLink + '</a>' });
    await sendEmail({ to: b.email, subject: 'Welcome to GetATableSpot!', html: '<p>Welcome! Complete your setup: <a href="' + stripeLink + '">Start Free Trial</a></p>' });
    res.json({ success: true, stripeLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.json({ received: true });
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, secret); }
  catch (e) { return res.status(400).send('Webhook Error: ' + e.message); }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const meta = s.metadata || {};
    if (meta.venueId) {
      await db.upsertRestaurant({ googlePlaceId: meta.venueId, name: meta.restaurantName || 'Restaurant', plan: meta.plan }).catch(console.error);
      await db.updateRestaurant(meta.venueId, { plan: meta.plan, is_featured: meta.plan === 'pro' || meta.plan === 'elite', stripe_customer_id: s.customer, stripe_subscription_id: s.subscription }).catch(console.error);
    }
    cache.flushAll();
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const result = await db.query('SELECT google_place_id FROM restaurants WHERE stripe_subscription_id=$1', [sub.id]).catch(function() { return { rows: [] }; });
    if (result.rows[0]) { await db.updateRestaurant(result.rows[0].google_place_id, { plan: 'free', is_featured: false }).catch(console.error); cache.flushAll(); }
  }
  res.json({ received: true });
}

app.post('/api/subscribe', async function(req, res) {
  try {
    if (!req.body.email) return res.status(400).json({ error: 'email required' });
    let checkoutUrl = process.env.STRIPE_LINK_DINER || APP_URL + '/pro-subscription.html';
    if (STRIPE_PRICES.diner && process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('placeholder')) {
      try {
        const s = await stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ['card'], line_items: [{ price: STRIPE_PRICES.diner, quantity: 1 }], subscription_data: { trial_period_days: 7 }, customer_email: req.body.email, success_url: APP_URL + '/index.html?pro=1', cancel_url: APP_URL + '/pro-subscription.html' });
        checkoutUrl = s.url;
      } catch (e) { console.error('Diner Stripe:', e.message); }
    }
    res.json({ success: true, checkoutUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/waitlist', async function(req, res) {
  try {
    if (!req.body.email) return res.status(400).json({ error: 'email required' });
    await sendEmail({ to: NOTIFY_EMAIL, subject: 'Waitlist: ' + req.body.feature, html: '<p>' + req.body.email + ' — ' + req.body.feature + '</p>' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai-concierge', async function(req, res) {
  try {
    const messages = req.body.messages, restaurantContext = req.body.restaurantContext;
    if (!messages || !restaurantContext) return res.status(400).json({ error: 'Missing messages or context' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured' });
    const result = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-opus-4-7', max_tokens: 600, system: 'You are a helpful AI dining concierge for GetATableSpot.\n\nRESTAURANTS:\n' + restaurantContext + '\n\nRecommend 2-3 restaurants that best match. Be warm and concise. Only recommend from the list.', messages },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
    );
    res.json(result.data);
  } catch (e) { console.error('AI error:', e.response ? e.response.data : e.message); res.status(500).json({ error: e.message }); }
});
app.get('/health', async function(_, res) {
  let dbOk = false;
  try { await db.query('SELECT 1'); dbOk = true; } catch (e) {}
  res.json({ status: 'ok', db: dbOk ? 'connected' : 'error', timestamp: new Date() });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', function() { console.log('GetATableSpot API on :' + PORT); });
setInterval(function() {
  const https = require('https');
  https.get('https://getatablespot-api.onrender.com/health', function() {
    console.log('Keep-alive ping sent');
  }).on('error', function() {});
}, 840000);

module.exports = app;
module.exports = app;
