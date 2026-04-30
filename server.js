<<<<<<< HEAD
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Stripe = require('stripe');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const cache = new NodeCache({ stdTTL: 3600 });

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));

const G_KEY = process.env.GOOGLE_PLACES_API_KEY;
const YELP_KEY = process.env.YELP_API_KEY;
const G_BASE = 'https://places.googleapis.com/v1';
const YELP_BASE = 'https://api.yelp.com/v3';

async function googleNearbyRestaurants({ lat, lng, radius = 8000 }) {
  const cacheKey = `gnearby:${lat}:${lng}:${radius}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const body = {
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: radius
      }
    },
    includedTypes: ['restaurant'],
    maxResultCount: 20,
    rankPreference: 'POPULARITY',
  };
  const fields = [
    'places.id','places.displayName','places.formattedAddress',
    'places.location','places.rating','places.userRatingCount',
    'places.priceLevel','places.currentOpeningHours',
    'places.photos','places.types','places.primaryType',
    'places.internationalPhoneNumber','places.websiteUri',
    'places.dineIn','places.reservable','places.outdoorSeating',
  ].join(',');
  try {
    const { data } = await axios.post(`${G_BASE}/places:searchNearby`, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': G_KEY,
        'X-Goog-FieldMask': fields,
      },
    });
    const results = data.places || [];
    cache.set(cacheKey, results, 3600);
    return results;
  } catch (err) {
    console.error('Google Places error:', err.response?.data || err.message);
    return [];
  }
}

async function yelpSearch({ lat, lng, term = 'restaurants', radius = 8000 }) {
  const cacheKey = `yelp:${lat}:${lng}:${term}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await axios.get(`${YELP_BASE}/businesses/search`, {
      headers: { Authorization: `Bearer ${YELP_KEY}` },
      params: { latitude: lat, longitude: lng, term, radius, categories: 'restaurants', limit: 50 },
    });
    cache.set(cacheKey, data.businesses || [], 86400);
    return data.businesses || [];
  } catch (err) {
    console.error('Yelp error:', err.message);
    return [];
  }
}

async function yelpReviews(yelpId) {
  if (!yelpId) return [];
  const cacheKey = `yelprev:${yelpId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await axios.get(`${YELP_BASE}/businesses/${yelpId}/reviews`, {
      headers: { Authorization: `Bearer ${YELP_KEY}` },
      params: { limit: 3 },
    });
    cache.set(cacheKey, data.reviews || [], 86400);
    return data.reviews || [];
  } catch { return []; }
}

const PRICE_MAP = {
  PRICE_LEVEL_FREE:'Free', PRICE_LEVEL_INEXPENSIVE:'$',
  PRICE_LEVEL_MODERATE:'$$', PRICE_LEVEL_EXPENSIVE:'$$$',
  PRICE_LEVEL_VERY_EXPENSIVE:'$$$$'
};

function matchYelp(googlePlace, yelpList) {
  const gName = (googlePlace.displayName?.text || '').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,14);
  return yelpList.find(biz => {
    const yName = biz.name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,14);
    return yName.includes(gName) || gName.includes(yName);
  }) || null;
}

function estimateWait(googlePlace) {
  const hour = new Date().getHours();
  const isPeak = hour >= 18 && hour <= 21;
  if (!googlePlace.currentOpeningHours?.openNow) return { waitMins: 0, waitLevel: 'none' };
  if (!isPeak) {
    const m = Math.floor(Math.random() * 10);
    return { waitMins: m, waitLevel: m < 10 ? 'low' : 'med' };
  }
  const price = PRICE_MAP[googlePlace.priceLevel] || '$$';
  const m = price === '$$$$' ? Math.floor(30 + Math.random() * 30)
          : price === '$$$' ? Math.floor(15 + Math.random() * 25)
          : Math.floor(Math.random() * 20);
  return { waitMins: m, waitLevel: m < 15 ? 'low' : m < 30 ? 'med' : 'high' };
}

function mergeRestaurant(gPlace, yelpMatch) {
  const { waitMins, waitLevel } = estimateWait(gPlace);
  const photo = gPlace.photos?.[0]?.name;
  return {
    id: gPlace.id,
    name: gPlace.displayName?.text || 'Unknown',
    address: gPlace.formattedAddress || '',
    location: gPlace.location,
    cuisine: (gPlace.primaryType || 'restaurant').replace(/_/g,' '),
    rating: gPlace.rating || 0,
    reviewCount: gPlace.userRatingCount || 0,
    reviews: gPlace.userRatingCount || 0,
    price: PRICE_MAP[gPlace.priceLevel] || '$$',
    isOpen: gPlace.currentOpeningHours?.openNow ?? false,
    hours: gPlace.currentOpeningHours?.weekdayDescriptions || [],
    phone: gPlace.internationalPhoneNumber || '',
    website: gPlace.websiteUri || '',
    photoUrl: photo ? `${G_BASE}/${photo}/media?maxWidthPx=800&key=${G_KEY}` : null,
    types: gPlace.types || [],
    outdoor: gPlace.outdoorSeating || false,
    reservable: gPlace.reservable || false,
    yelpId: yelpMatch?.id || null,
    yelpRating: yelpMatch?.rating || null,
    yelpUrl: yelpMatch?.url || null,
    yelpCategories: yelpMatch?.categories?.map(c => c.title) || [],
    tags: yelpMatch?.categories?.map(c => c.title) || [],
    waitMins,
    waitLevel,
    sources: ['google', ...(yelpMatch ? ['yelp'] : []), ...(gPlace.reservable ? ['opentable'] : [])],
    isFeatured: false,
    michelin: false,
    distance: '0.5 mi',
    emoji: '🍽️',
    bg: 'linear-gradient(135deg,#1A1A1A,#333)',
  };
}

function generateMockSlots() {
  const times = ['5:30 PM','6:00 PM','6:30 PM','7:00 PM','7:30 PM','8:00 PM','8:30 PM','9:00 PM'];
  return times.map((time, i) => ({
    time, available: Math.random() > 0.35,
    remaining: Math.floor(Math.random() * 6) + 1,
    isPro: i < 2,
  }));
}

const reservations = new Map();
const restaurantProfiles = new Map();

app.get('/api/venues', async (req, res) => {
  try {
    const { lat, lng, radius = 8000, q } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
    const [googleResults, yelpResults] = await Promise.all([
      googleNearbyRestaurants({ lat: parseFloat(lat), lng: parseFloat(lng), radius: parseInt(radius) }),
      yelpSearch({ lat: parseFloat(lat), lng: parseFloat(lng), radius: parseInt(radius), term: q || 'restaurants' }),
    ]);
    const merged = googleResults.map(gp => mergeRestaurant(gp, matchYelp(gp, yelpResults)));
    merged.sort((a, b) => (b.isFeatured - a.isFeatured) || (b.rating - a.rating));
    res.json({ venues: merged, total: merged.length });
  } catch (err) {
    console.error('GET /api/venues:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/venues/:id', async (req, res) => {
  try {
    const fields = 'id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,currentOpeningHours,photos,reviews,types,internationalPhoneNumber,websiteUri';
    const { data } = await axios.get(`${G_BASE}/places/${req.params.id}`, {
      headers: { 'X-Goog-Api-Key': G_KEY, 'X-Goog-FieldMask': fields },
    });
    res.json({ venue: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/venues/:id/slots', async (req, res) => {
  const slots = generateMockSlots();
  res.json({ slots, date: req.query.date, venueId: req.params.id });
});

app.get('/api/venues/:id/reviews', async (req, res) => {
  const reviews = await yelpReviews(req.query.yelpId);
  res.json({ reviews });
});

app.post('/api/reservations', async (req, res) => {
  try {
    const { venueId, time, date, partySize, guestName, guestEmail, notes, isPro } = req.body;
    if (!venueId || !guestName || !guestEmail || !time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const id = `GATS-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    const reservation = {
      id, venueId, time, date, partySize,
      guestName, guestEmail, notes, isPro,
      status: 'confirmed',
      createdAt: new Date()
    };
    reservations.set(id, reservation);
    res.json({ success: true, confirmationNumber: id, reservation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/restaurant-dashboard/:id', async (req, res) => {
  const profile = restaurantProfiles.get(req.params.id) || {
    venueId: req.params.id,
    waitMins: 0,
    isFeatured: false,
    plan: 'free',
    slots: [],
  };
  res.json(profile);
});

app.patch('/api/restaurant-dashboard/:id', async (req, res) => {
  const existing = restaurantProfiles.get(req.params.id) || {};
  const updated = { ...existing, ...req.body, venueId: req.params.id, updatedAt: new Date() };
  restaurantProfiles.set(req.params.id, updated);
  res.json({ success: true, profile: updated });
});

app.get('/api/restaurant-dashboard/:id/analytics', async (req, res) => {
  res.json({
    views: { today: 847, week: 4921, month: 19340 },
    reservations: { today: 24, week: 142, month: 567 },
    conversionRate: 7.4,
    revenueViaGetATableSpot: 567 * 1.50,
  });
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    res.json({ success: true, message: `Subscription started for ${email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GetATableSpot API running on :${PORT}`));
module.exports = app;
=======
require(‘dotenv’).config();
const express = require(‘express’);
const cors = require(‘cors’);
const axios = require(‘axios’);
const Stripe = require(‘stripe’);
const NodeCache = require(‘node-cache’);
const rateLimit = require(‘express-rate-limit’);
const helmet = require(‘helmet’);

const app = express();
app.set(‘trust proxy’, 1);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || ‘sk_test_placeholder’);
const cache = new NodeCache({ stdTTL: 3600 });

// Stripe webhook needs raw body — register BEFORE express.json()
app.post(’/api/stripe-webhook’, express.raw({ type: ‘application/json’ }), handleStripeWebhook);

app.use(helmet());
app.use(cors({ origin: ‘*’ }));
app.use(express.json());
app.use(’/api/’, rateLimit({ windowMs: 60_000, max: 120 }));

const G_KEY         = process.env.GOOGLE_PLACES_API_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const G_BASE        = ‘https://places.googleapis.com/v1’;
const NOTIFY_EMAIL  = process.env.NOTIFY_EMAIL || ‘asbellrichard429@gmail.com’;
const APP_URL       = process.env.APP_URL || ‘https://getatablespot.com’;

// ── Stripe ───────────────────────────────────────────────────────────────────
// Set these in .env:
//   STRIPE_PRICE_BASIC / PRO / ELITE / DINER   (price_xxx from Stripe dashboard)
//   STRIPE_LINK_BASIC / PRO / ELITE / DINER    (static payment links as fallback)
const STRIPE_PRICES = {
basic: process.env.STRIPE_PRICE_BASIC,
pro:   process.env.STRIPE_PRICE_PRO,
elite: process.env.STRIPE_PRICE_ELITE,
diner: process.env.STRIPE_PRICE_DINER,
};
const STRIPE_LINKS = {
basic: process.env.STRIPE_LINK_BASIC  || ‘https://buy.stripe.com/6oU3cua6N5Kkbd2gJubEA03’,
pro:   process.env.STRIPE_LINK_PRO    || ‘https://buy.stripe.com/4gMaEW92J0q0ch6gJubEA04’,
elite: process.env.STRIPE_LINK_ELITE  || ‘https://buy.stripe.com/bJe6oG2El4Gg94UbpabEA05’,
diner: process.env.STRIPE_LINK_DINER  || ‘https://buy.stripe.com/diner_placeholder’,
};
const PLAN_META = {
basic: { label: ‘Basic’,  price: ‘$49/month’,   trial: 7 },
pro:   { label: ‘Pro’,    price: ‘$99/month’,   trial: 7 },
elite: { label: ‘Elite’,  price: ‘$299/month’,  trial: 7 },
diner: { label: ‘Pro’,    price: ‘$2.99/month’, trial: 7 },
};

// ── Cuisine map ───────────────────────────────────────────────────────────────
const CUISINE_TYPE_MAP = {
all:        [‘restaurant’],
italian:    [‘italian_restaurant’],
japanese:   [‘japanese_restaurant’],
mexican:    [‘mexican_restaurant’],
american:   [‘american_restaurant’],
bargrill:   [‘bar’, ‘american_restaurant’],
sportsbar:  [‘sports_bar’],
chinese:    [‘chinese_restaurant’],
indian:     [‘indian_restaurant’],
french:     [‘french_restaurant’],
thai:       [‘thai_restaurant’],
steakhouse: [‘steak_house’],
seafood:    [‘seafood_restaurant’],
pizza:      [‘pizza_restaurant’],
brunch:     [‘breakfast_restaurant’, ‘cafe’],
};

const PRICE_MAP = {
PRICE_LEVEL_FREE:           ‘Free’,
PRICE_LEVEL_INEXPENSIVE:    ‘$’,
PRICE_LEVEL_MODERATE:       ‘$$’,
PRICE_LEVEL_EXPENSIVE:      ‘$$$’,
PRICE_LEVEL_VERY_EXPENSIVE: ‘$$$$’,
};

// ── In-memory stores (swap for DB in production) ──────────────────────────────
const reservations       = new Map();
const restaurantProfiles = new Map();
const claimLeads         = new Map();
const waitlistEmails     = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────
function calcDistance(lat1, lng1, lat2, lng2) {
const R = 3958.8;
const dLat = (lat2 - lat1) * Math.PI / 180;
const dLng = (lng2 - lng1) * Math.PI / 180;
const a = Math.sin(dLat/2)**2 +
Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
}

async function sendEmail({ to, subject, html }) {
if (!RESEND_KEY) { console.warn(‘RESEND_KEY not set — skipping email to’, to); return; }
try {
await axios.post(‘https://api.resend.com/emails’, {
from: ‘GetATableSpot [notifications@getatablespot.com](mailto:notifications@getatablespot.com)’,
to, subject, html,
}, { headers: { Authorization: `Bearer ${RESEND_KEY}`, ‘Content-Type’: ‘application/json’ } });
console.log(‘Email sent:’, to);
} catch (err) {
console.error(‘Email error:’, err.response?.data || err.message);
}
}

async function googleNearbySearch({ lat, lng, radius, types }) {
const fields = [
‘places.id’,‘places.displayName’,‘places.formattedAddress’,
‘places.location’,‘places.rating’,‘places.userRatingCount’,
‘places.priceLevel’,‘places.currentOpeningHours’,
‘places.photos’,‘places.types’,‘places.primaryType’,
‘places.internationalPhoneNumber’,‘places.websiteUri’,
‘places.dineIn’,‘places.reservable’,‘places.outdoorSeating’,
].join(’,’);
try {
const { data } = await axios.post(`${G_BASE}/places:searchNearby`, {
locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
includedTypes: types,
maxResultCount: 20,
rankPreference: ‘POPULARITY’,
}, { headers: { ‘Content-Type’: ‘application/json’, ‘X-Goog-Api-Key’: G_KEY, ‘X-Goog-FieldMask’: fields } });
return data.places || [];
} catch (err) {
console.error(‘Google Places error:’, err.response?.data || err.message);
return [];
}
}

async function googleNearbyRestaurants({ lat, lng, radius = 12000, cuisine = ‘all’ }) {
const cacheKey = `gnearby:${lat.toFixed(3)}:${lng.toFixed(3)}:${radius}:${cuisine}`;
const cached = cache.get(cacheKey);
if (cached) return cached;

const types = CUISINE_TYPE_MAP[cuisine] || [‘restaurant’];
const offset = 0.022;
const centers = [
{ lat, lng },
{ lat: lat + offset, lng },
{ lat: lat - offset, lng },
{ lat, lng: lng + offset },
{ lat, lng: lng - offset },
];

const allResults = await Promise.all(centers.map(c =>
googleNearbySearch({ lat: c.lat, lng: c.lng, radius: Math.round(radius * 0.65), types })
));

const seen = new Set();
const combined = [];
for (const results of allResults)
for (const place of results)
if (!seen.has(place.id)) { seen.add(place.id); combined.push(place); }

combined.sort((a, b) => (b.rating || 0) - (a.rating || 0));
cache.set(cacheKey, combined, 3600);
console.log(`Google: ${combined.length} places | cuisine=${cuisine}`);
return combined;
}

function estimateWait(googlePlace) {
const hour   = new Date().getHours();
const isPeak = hour >= 18 && hour <= 21;
if (!googlePlace.currentOpeningHours?.openNow) return { waitMins: 0, waitLevel: ‘none’ };
if (!isPeak) {
const m = Math.floor(Math.random() * 10);
return { waitMins: m, waitLevel: ‘low’ };
}
const price = PRICE_MAP[googlePlace.priceLevel] || ‘$$’;
const m = price === ‘$$$$’ ? Math.floor(30 + Math.random() * 30)
: price === ‘$$$’  ? Math.floor(15 + Math.random() * 25)
: Math.floor(Math.random() * 20);
return { waitMins: m, waitLevel: m < 15 ? ‘low’ : m < 30 ? ‘med’ : ‘high’ };
}

function mergeRestaurant(gPlace, userLat, userLng) {
const { waitMins, waitLevel } = estimateWait(gPlace);
const photo    = gPlace.photos?.[0]?.name;
const placeLat = gPlace.location?.latitude;
const placeLng = gPlace.location?.longitude;
const distance = (userLat && userLng && placeLat && placeLng)
? `${calcDistance(userLat, userLng, placeLat, placeLng)} mi`
: ‘nearby’;

// Overlay live data from claimed profile
const profile = restaurantProfiles.get(gPlace.id);

return {
id:          gPlace.id,
name:        gPlace.displayName?.text || ‘Unknown’,
address:     gPlace.formattedAddress || ‘’,
location:    gPlace.location,
cuisine:     (gPlace.primaryType || ‘restaurant’).replace(/_/g, ’ ’),
rating:      gPlace.rating || 0,
reviewCount: gPlace.userRatingCount || 0,
reviews:     gPlace.userRatingCount || 0,
price:       PRICE_MAP[gPlace.priceLevel] || ‘$$’,
isOpen:      gPlace.currentOpeningHours?.openNow ?? false,
hours:       gPlace.currentOpeningHours?.weekdayDescriptions || [],
phone:       gPlace.internationalPhoneNumber || ‘’,
website:     gPlace.websiteUri || ‘’,
photoUrl:    photo ? `${G_BASE}/${photo}/media?maxWidthPx=800&key=${G_KEY}` : null,
types:       gPlace.types || [],
outdoor:     gPlace.outdoorSeating || false,
reservable:  gPlace.reservable || false,
tags:        [],
waitMins:    profile?.waitMins  ?? waitMins,
waitLevel:   profile?.waitLevel ?? waitLevel,
isFeatured:  [‘pro’,‘elite’].includes(profile?.plan) || false,
distance,
sources:     [‘google’, …(gPlace.reservable ? [‘opentable’] : [])],
michelin:    false,
emoji:       ‘🍽️’,
bg:          ‘linear-gradient(135deg,#1A1A1A,#333)’,
};
}

function generateMockSlots() {
return [‘5:30 PM’,‘6:00 PM’,‘6:30 PM’,‘7:00 PM’,‘7:30 PM’,‘8:00 PM’,‘8:30 PM’,‘9:00 PM’]
.map((time, i) => ({ time, available: Math.random() > 0.35, remaining: Math.floor(Math.random()*6)+1, isPro: i < 2 }));
}

async function createStripeSession({ priceId, email, trialDays, successUrl, cancelUrl, metadata }) {
if (!priceId) return null;
const key = process.env.STRIPE_SECRET_KEY || ‘’;
if (!key || key.includes(‘placeholder’)) return null;
try {
const session = await stripe.checkout.sessions.create({
mode: ‘subscription’,
payment_method_types: [‘card’],
line_items: [{ price: priceId, quantity: 1 }],
subscription_data: { trial_period_days: trialDays, metadata },
customer_email: email,
success_url: successUrl,
cancel_url: cancelUrl,
metadata,
});
return session.url;
} catch (err) {
console.error(‘Stripe session error:’, err.message);
return null;
}
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get(’/api/venues’, async (req, res) => {
try {
const { lat, lng, radius = 12000, cuisine = ‘all’ } = req.query;
if (!lat || !lng) return res.status(400).json({ error: ‘lat and lng required’ });
const userLat = parseFloat(lat);
const userLng = parseFloat(lng);
const results = await googleNearbyRestaurants({ lat: userLat, lng: userLng, radius: parseInt(radius), cuisine });
const merged  = results.map(gp => mergeRestaurant(gp, userLat, userLng));
merged.sort((a, b) => (b.isFeatured - a.isFeatured) || (b.rating - a.rating));
res.json({ venues: merged, total: merged.length });
} catch (err) {
console.error(‘GET /api/venues:’, err.message);
res.status(500).json({ error: err.message });
}
});

app.get(’/api/venues/:id’, async (req, res) => {
try {
const fields = ‘id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,currentOpeningHours,photos,reviews,types,internationalPhoneNumber,websiteUri’;
const { data } = await axios.get(`${G_BASE}/places/${req.params.id}`, {
headers: { ‘X-Goog-Api-Key’: G_KEY, ‘X-Goog-FieldMask’: fields },
});
res.json({ venue: data });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/api/venues/:id/slots’, async (req, res) => {
const profile = restaurantProfiles.get(req.params.id);
const slots   = profile?.slots?.length ? profile.slots : generateMockSlots();
res.json({ slots, date: req.query.date, venueId: req.params.id });
});

app.get(’/api/search’, async (req, res) => {
try {
const { q } = req.query;
if (!q) return res.status(400).json({ error: ‘q required’ });
const { data } = await axios.get(‘https://maps.googleapis.com/maps/api/place/textsearch/json’, {
params: { query: q, key: G_KEY },
});
res.json({ results: data.results || [] });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/api/ai-concierge’, async (req, res) => {
try {
const { messages, restaurantContext } = req.body;
if (!messages || !restaurantContext) return res.status(400).json({ error: ‘Missing messages or context’ });
if (!ANTHROPIC_KEY) return res.status(500).json({ error: ‘AI not configured — ANTHROPIC_API_KEY missing’ });

```
const response = await axios.post('https://api.anthropic.com/v1/messages', {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 600,
  system: `You are a warm helpful AI dining concierge for GetATableSpot. Help diners find the perfect restaurant.
```

RESTAURANTS AVAILABLE RIGHT NOW NEAR THE USER:
${restaurantContext}

RULES:

- Recommend 2-3 restaurants that best match the request
- Be warm and conversational, not robotic
- Only recommend from the list above — never invent restaurants
- Explain briefly why each one fits
- If nothing matches well, say so honestly
- Keep responses concise`,
  messages,
  }, {
  headers: { ‘Content-Type’: ‘application/json’, ‘x-api-key’: ANTHROPIC_KEY, ‘anthropic-version’: ‘2023-06-01’ },
  });
  res.json(response.data);
  } catch (err) {
  console.error(‘AI proxy error:’, err.response?.data || err.message);
  res.status(500).json({ error: err.response?.data || err.message });
  }
  });

app.post(’/api/reservations’, async (req, res) => {
try {
const { venueId, time, date, partySize, guestName, guestEmail, restaurantName, restaurantPhone, notes } = req.body;
if (!venueId || !guestName || !guestEmail || !time) return res.status(400).json({ error: ‘Missing required fields’ });

```
const id = `GATS-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
reservations.set(id, { id, venueId, time, date, partySize, guestName, guestEmail, notes, status: 'confirmed', createdAt: new Date() });

await sendEmail({
  to: guestEmail,
  subject: `✓ Reservation Request Sent — ${restaurantName || 'Restaurant'} at ${time}`,
  html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF8F4">
    <div style="text-align:center;margin-bottom:20px"><div style="font-family:Georgia,serif;font-size:1.4rem;font-weight:900">GetATableSpot</div></div>
    <div style="background:white;border:1px solid #E0D8CC;border-radius:10px;padding:24px;margin-bottom:16px">
      <div style="font-size:1.5rem;text-align:center;margin-bottom:10px">📋</div>
      <h2 style="font-family:Georgia,serif;font-size:1.1rem;text-align:center;margin-bottom:4px">Reservation Request Sent</h2>
      <p style="color:#5A6A82;font-size:.83rem;text-align:center;margin-bottom:18px">Hi ${(guestName||'').split(' ')[0]}! Your request has been sent to ${restaurantName||'the restaurant'}. They will confirm by phone or email.</p>
      <div style="background:#F5F0E8;border-radius:8px;padding:14px;font-size:.83rem">
        <div style="display:flex;justify-content:space-between;margin-bottom:7px"><span style="color:#5A6A82">Restaurant</span><span style="font-weight:700">${restaurantName||'Restaurant'}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:7px"><span style="color:#5A6A82">Time</span><span style="font-weight:700">${time}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:7px"><span style="color:#5A6A82">Party</span><span style="font-weight:700">${partySize} guests</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#5A6A82">Ref #</span><span style="font-weight:700;color:#E8430A">${id}</span></div>
      </div>
    </div>
    <div style="background:#FFF8E8;border:1px solid #E8D5A3;border-radius:8px;padding:12px;margin-bottom:14px;font-size:.78rem;color:#A07820">
      <strong>⏱ Note:</strong> This is a request — the restaurant will confirm directly.${restaurantPhone?` Call: <strong>${restaurantPhone}</strong>`:''}
    </div>
    <a href="${APP_URL}" style="display:block;background:#111009;border-radius:8px;padding:12px;text-align:center;color:#E8430A;font-weight:700;font-size:.82rem;text-decoration:none">Check wait times at getatablespot.com →</a>
  </div>`,
});

const profile = restaurantProfiles.get(venueId);
if (profile?.ownerEmail) {
  await sendEmail({
    to: profile.ownerEmail,
    subject: `📅 New Reservation Request — ${guestName}, party of ${partySize} at ${time}`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
      <h2 style="font-family:Georgia,serif;margin-bottom:8px">New Reservation Request</h2>
      <div style="background:#F5F0E8;border-radius:8px;padding:16px;margin:16px 0">
        <p><strong>${guestName}</strong> · ${guestEmail}</p>
        <p>Party of ${partySize} · ${time}${date?` · ${date}`:''}</p>
        ${notes?`<p style="color:#888;font-size:.85rem;margin-top:8px"><em>${notes}</em></p>`:''}
        <p style="color:#aaa;font-size:.72rem;margin-top:8px">Ref: ${id}</p>
      </div>
      <p style="font-size:.82rem;color:#888">Please confirm with the guest directly.</p>
    </div>`,
  });
}

res.json({ success: true, confirmationNumber: id });
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/api/restaurant-dashboard/:id’, async (req, res) => {
const profile = restaurantProfiles.get(req.params.id) || {
venueId: req.params.id, waitMins: 0, waitLevel: ‘low’, isFeatured: false, plan: ‘free’, slots: [],
};
res.json(profile);
});

app.patch(’/api/restaurant-dashboard/:id’, async (req, res) => {
const existing = restaurantProfiles.get(req.params.id) || {};
const updated  = { …existing, …req.body, venueId: req.params.id, updatedAt: new Date() };
restaurantProfiles.set(req.params.id, updated);
cache.flushAll();
res.json({ success: true, profile: updated });
});

app.get(’/api/restaurant-dashboard/:id/analytics’, async (req, res) => {
res.json({
views:        { today: 847,  week: 4921, month: 19340 },
reservations: { today: 24,   week: 142,  month: 567   },
conversionRate: 7.4,
revenueViaGetATableSpot: 850.50,
});
});

// POST /api/restaurant-claim
// Form sends: restaurantId (Google Place ID), restaurantName, restaurantAddress,
//             ownerName, email, phone, role, plan
app.post(’/api/restaurant-claim’, async (req, res) => {
try {
const { restaurantId, restaurantName, restaurantAddress, ownerName, email, phone, role, plan } = req.body;
if (!restaurantName || !email || !plan) return res.status(400).json({ error: ‘restaurantName, email and plan are required’ });

```
const planInfo = PLAN_META[plan] || PLAN_META.pro;
const venueId  = restaurantId || '';

let stripeLink = await createStripeSession({
  priceId:    STRIPE_PRICES[plan],
  email,
  trialDays:  planInfo.trial,
  successUrl: `${APP_URL}/restaurant-dashboard.html?plan=${plan}`,
  cancelUrl:  `${APP_URL}/claim-restaurant.html?cancelled=1`,
  metadata:   { restaurantName, restaurantId: venueId, ownerName: ownerName || '', plan },
});
if (!stripeLink) stripeLink = STRIPE_LINKS[plan] || STRIPE_LINKS.pro;

claimLeads.set(email, {
  restaurantId: venueId, restaurantName, restaurantAddress,
  ownerName, email, phone, role, plan, stripeLink, claimedAt: new Date(),
});

// Admin notification
await sendEmail({
  to: NOTIFY_EMAIL,
  subject: `🍽️ New Restaurant Claim — ${restaurantName} (${planInfo.label})`,
  html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
    <h2 style="font-family:Georgia,serif;margin-bottom:8px">New Restaurant Claim</h2>
    <p style="color:#6B7A8D;margin-bottom:20px">Just submitted on GetATableSpot</p>
    <div style="background:#F5F0E8;border-radius:8px;padding:20px;margin-bottom:14px">
      <p style="font-weight:700;font-size:1rem;margin-bottom:4px">${restaurantName}</p>
      <p style="color:#6B7A8D;font-size:.85rem;margin-bottom:12px">${restaurantAddress||'Address not provided'}</p>
      <p style="font-size:.85rem;margin-bottom:4px"><strong>${ownerName||'Unknown'}</strong> · ${role||'Owner'}</p>
      <p style="font-size:.85rem;margin-bottom:12px">${email} · ${phone||'No phone'}</p>
      <p style="font-weight:700;color:#C9A84C">${planInfo.label.toUpperCase()} — ${planInfo.price}</p>
      ${venueId?`<p style="font-size:.72rem;color:#aaa;margin-top:6px">Place ID: ${venueId}</p>`:''}
    </div>
    <div style="background:#0F0D0A;border-radius:8px;padding:14px;margin-bottom:14px">
      <p style="color:#C9A84C;font-size:.7rem;font-weight:700;margin-bottom:6px">STRIPE LINK</p>
      <a href="${stripeLink}" style="color:#E8D5A3;font-size:.82rem;word-break:break-all">${stripeLink}</a>
    </div>
    <div style="background:#EDF8F1;border:1px solid #B8E0C4;border-radius:6px;padding:14px">
      <p style="font-weight:700;color:#1D6B3A;margin-bottom:8px">Next steps:</p>
      <ol style="color:#1D6B3A;font-size:.82rem;padding-left:18px;line-height:1.8;margin:0">
        <li>Email ${email} to confirm receipt</li>
        <li>If not auto-redirected, send Stripe link above</li>
        <li>After payment: send ${APP_URL}/restaurant-dashboard.html</li>
        <li>Add to tracking spreadsheet</li>
      </ol>
    </div>
  </div>`,
});

// Owner welcome
await sendEmail({
  to: email,
  subject: `Welcome to GetATableSpot — ${restaurantName} is being activated 🎉`,
  html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
    <h2 style="font-family:Georgia,serif;margin-bottom:8px">Welcome, ${(ownerName||'there').split(' ')[0]}! 🎉</h2>
    <p style="color:#6B7A8D;line-height:1.6;margin-bottom:20px"><strong>${restaurantName}</strong> is being activated on the <strong>${planInfo.label}</strong> plan.</p>
    <div style="background:#F5F0E8;border-radius:8px;padding:16px;margin-bottom:20px">
      <p style="font-size:.85rem;margin-bottom:4px"><strong>Plan:</strong> ${planInfo.label} — ${planInfo.price}</p>
      <p style="font-size:.85rem;margin-bottom:4px"><strong>Free trial:</strong> ${planInfo.trial} days</p>
      <p style="font-size:.85rem;color:#888">No charge until day ${planInfo.trial+1} · Cancel anytime</p>
    </div>
    <div style="text-align:center;margin-bottom:18px">
      <a href="${stripeLink}" style="display:inline-block;background:#E8430A;color:white;font-weight:700;font-size:.9rem;padding:13px 28px;border-radius:6px;text-decoration:none">
        Complete Setup → Start Free ${planInfo.trial}-Day Trial
      </a>
      <p style="font-size:.72rem;color:#6B7A8D;margin-top:8px">${planInfo.trial} days free · No charge until day ${planInfo.trial+1} · Cancel anytime</p>
    </div>
    <p style="font-size:.82rem;color:#6B7A8D;line-height:1.6">Once active, log in to your dashboard to set live wait times, manage reservations, and see exactly how many diners found you.</p>
    <p style="font-size:.78rem;color:#6B7A8D;text-align:center;margin-top:24px">Reply anytime — we respond fast.<br><br>— Richard &amp; Stephanie, GetATableSpot</p>
  </div>`,
});

res.json({ success: true, message: 'Claim received.', stripeLink });
```

} catch (err) {
console.error(‘Claim error:’, err.message);
res.status(500).json({ error: err.message });
}
});

async function handleStripeWebhook(req, res) {
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!webhookSecret) return res.json({ received: true });

let event;
try {
event = stripe.webhooks.constructEvent(req.body, req.headers[‘stripe-signature’], webhookSecret);
} catch (err) {
return res.status(400).send(`Webhook Error: ${err.message}`);
}

if (event.type === ‘checkout.session.completed’) {
const s = event.data.object;
const { restaurantName, restaurantId, plan } = s.metadata || {};
if (restaurantId) {
restaurantProfiles.set(restaurantId, {
…(restaurantProfiles.get(restaurantId) || {}),
venueId: restaurantId, plan, restaurantName,
ownerEmail: s.customer_details?.email || ‘’,
stripeCustomerId: s.customer,
stripeSubscriptionId: s.subscription,
activatedAt: new Date(),
isFeatured: [‘pro’,‘elite’].includes(plan),
});
cache.flushAll();
console.log(`✓ Activated: ${restaurantName} (${plan})`);
}
}

if (event.type === ‘customer.subscription.deleted’) {
const sub = event.data.object;
for (const [vid, profile] of restaurantProfiles.entries()) {
if (profile.stripeSubscriptionId === sub.id) {
restaurantProfiles.set(vid, { …profile, plan: ‘free’, isFeatured: false, cancelledAt: new Date() });
cache.flushAll();
break;
}
}
}

res.json({ received: true });
}

app.post(’/api/subscribe’, async (req, res) => {
try {
const { email } = req.body;
if (!email) return res.status(400).json({ error: ‘email required’ });
let checkoutUrl = await createStripeSession({
priceId:    STRIPE_PRICES.diner,
email,
trialDays:  7,
successUrl: `${APP_URL}/index.html?pro=1`,
cancelUrl:  `${APP_URL}/pro-subscription.html`,
metadata:   { plan: ‘diner’, email },
});
if (!checkoutUrl) checkoutUrl = STRIPE_LINKS.diner;
res.json({ success: true, checkoutUrl });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/api/waitlist’, async (req, res) => {
try {
const { email, feature } = req.body;
if (!email) return res.status(400).json({ error: ‘email required’ });
waitlistEmails.add(email);
await sendEmail({
to: NOTIFY_EMAIL,
subject: `📬 Waitlist — ${feature || 'unknown'}`,
html: `<p><strong>${email}</strong> joined waitlist for: <strong>${feature||'unknown'}</strong></p>`,
});
res.json({ success: true });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/health’, (_, res) => res.json({
status: ‘ok’, timestamp: new Date(),
profiles: restaurantProfiles.size, reservations: reservations.size,
claims: claimLeads.size, waitlist: waitlistEmails.size,
}));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ‘0.0.0.0’, () => console.log(`GetATableSpot API :${PORT}`));
module.exports = app;
>>>>>>> 203459b8ea7082c68ff615f923513bb16bca2cc8
