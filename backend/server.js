require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Stripe = require('stripe');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
app.set('trust proxy', 1);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const cache = new NodeCache({ stdTTL: 3600 });

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));

const G_KEY = process.env.GOOGLE_PLACES_API_KEY;
const YELP_KEY = process.env.YELP_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const G_BASE = 'https://places.googleapis.com/v1';
const YELP_BASE = 'https://api.yelp.com/v3';
const NOTIFY_EMAIL = 'asbellrichard429@gmail.com';

const CUISINE_TYPE_MAP = {
  italian: ['italian_restaurant', 'pizza_restaurant'],
  japanese: ['japanese_restaurant', 'sushi_restaurant', 'ramen_restaurant'],
  mexican: ['mexican_restaurant', 'taco_restaurant', 'tex_mex_restaurant'],
  american: ['american_restaurant', 'hamburger_restaurant', 'diner'],
  bargrill: ['bar', 'pub', 'sports_bar', 'gastropub', 'american_restaurant'],
  chinese: ['chinese_restaurant', 'dim_sum_restaurant'],
  indian: ['indian_restaurant'],
  french: ['french_restaurant'],
  thai: ['thai_restaurant'],
  steakhouse: ['steak_house'],
  seafood: ['seafood_restaurant'],
  pizza: ['pizza_restaurant'],
  brunch: ['brunch_restaurant', 'breakfast_restaurant', 'cafe'],
  all: ['restaurant'],
};

async function sendEmail({ to, subject, html }) {
  if (!RESEND_KEY) return;
  try {
    await axios.post('https://api.resend.com/emails', {
      from: 'GetATableSpot <notifications@getatablespot.com>',
      to, subject, html,
    }, {
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    console.log('Email sent to:', to);
  } catch (err) {
    console.error('Email error:', err.response?.data || err.message);
  }
}

// Single nearby search call
async function googleNearbySearch({ lat, lng, radius = 5000, cuisine = 'all' }) {
  const types = CUISINE_TYPE_MAP[cuisine] || ['restaurant'];
  const body = {
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: radius
      }
    },
    includedTypes: types,
    maxResultCount: 20,
    rankPreference: 'POPULARITY',
  };
  const fields = [
    'places.id', 'places.displayName', 'places.formattedAddress',
    'places.location', 'places.rating', 'places.userRatingCount',
    'places.priceLevel', 'places.currentOpeningHours',
    'places.photos', 'places.types', 'places.primaryType',
    'places.internationalPhoneNumber', 'places.websiteUri',
    'places.dineIn', 'places.reservable', 'places.outdoorSeating',
  ].join(',');
  try {
    const { data } = await axios.post(`${G_BASE}/places:searchNearby`, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': G_KEY,
        'X-Goog-FieldMask': fields,
      },
    });
    return data.places || [];
  } catch (err) {
    console.error('Google Places error:', err.response?.data || err.message);
    return [];
  }
}

// Make multiple calls with offset centers to get more results
async function googleNearbyRestaurants({ lat, lng, radius = 8000, cuisine = 'all' }) {
  const cacheKey = `gnearby:${lat}:${lng}:${radius}:${cuisine}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Offset distance in degrees (~0.018 degrees = ~2km)
  const offset = 0.018;
  const centers = [
    { lat, lng },                          // center
    { lat: lat + offset, lng },            // north
    { lat: lat - offset, lng },            // south
    { lat, lng: lng + offset },            // east
    { lat, lng: lng - offset },            // west
  ];

  // Call all centers in parallel
  const allResults = await Promise.all(
    centers.map(c => googleNearbySearch({ lat: c.lat, lng: c.lng, radius: radius * 0.7, cuisine }))
  );

  // Flatten and deduplicate by place ID
  const seen = new Set();
  const combined = [];
  for (const results of allResults) {
    for (const place of results) {
      if (!seen.has(place.id)) {
        seen.add(place.id);
        combined.push(place);
      }
    }
  }

  // Sort by rating
  combined.sort((a, b) => (b.rating || 0) - (a.rating || 0));

  cache.set(cacheKey, combined, 3600);
  return combined;
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
  PRICE_LEVEL_FREE: 'Free', PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$', PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$'
};

function matchYelp(googlePlace, yelpList) {
  const gName = (googlePlace.displayName?.text || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
  return yelpList.find(biz => {
    const yName = biz.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
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
    cuisine: (gPlace.primaryType || 'restaurant').replace(/_/g, ' '),
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
  const times = ['5:30 PM', '6:00 PM', '6:30 PM', '7:00 PM', '7:30 PM', '8:00 PM', '8:30 PM', '9:00 PM'];
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
    const { lat, lng, radius = 8000, cuisine = 'all' } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    const [googleResults, yelpResults] = await Promise.all([
      googleNearbyRestaurants({
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        radius: parseInt(radius),
        cuisine
      }),
      yelpSearch({
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        radius: parseInt(radius),
        term: cuisine === 'all' ? 'restaurants' : cuisine.replace('bargrill', 'bar grill')
      }),
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

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const { data } = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      { params: { query: q, type: 'restaurant', key: G_KEY } }
    );
    res.json({ results: data.results || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reservations', async (req, res) => {
  try {
    const { venueId, time, date, partySize, guestName, guestEmail, notes, isPro } = req.body;
    if (!venueId || !guestName || !guestEmail || !time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const id = `GATS-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
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

app.post('/api/restaurant-claim', async (req, res) => {
  try {
    const { restaurantId, restaurantName, restaurantAddress, ownerName, email, phone, role, plan, stripeLink } = req.body;
    console.log('New restaurant claim:', { restaurantName, ownerName, email, plan });
    const planPrices = { basic: '$49/month', pro: '$99/month', elite: '$299/month' };
    const planPrice = planPrices[plan] || '$99/month';
    await sendEmail({
      to: NOTIFY_EMAIL,
      subject: `🍽️ New Restaurant Claim — ${restaurantName}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
          <h2 style="font-family:Georgia,serif;font-size:1.5rem;margin-bottom:4px">New Restaurant Claim</h2>
          <p style="color:#6B7A8D;margin-bottom:24px">Someone just claimed their restaurant on GetATableSpot</p>
          <div style="background:#F5F0E8;border-radius:8px;padding:20px;margin-bottom:20px">
            <div style="margin-bottom:12px"><div style="font-size:.72rem;font-weight:700;color:#6B7A8D;text-transform:uppercase;margin-bottom:3px">Restaurant</div><div style="font-weight:700">${restaurantName}</div><div style="font-size:.82rem;color:#6B7A8D">${restaurantAddress}</div></div>
            <div style="margin-bottom:12px"><div style="font-size:.72rem;font-weight:700;color:#6B7A8D;text-transform:uppercase;margin-bottom:3px">Owner</div><div style="font-weight:600">${ownerName} · ${role}</div></div>
            <div style="margin-bottom:12px"><div style="font-size:.72rem;font-weight:700;color:#6B7A8D;text-transform:uppercase;margin-bottom:3px">Contact</div><div>${email} · ${phone}</div></div>
            <div><div style="font-size:.72rem;font-weight:700;color:#6B7A8D;text-transform:uppercase;margin-bottom:3px">Plan</div><div style="font-weight:700;color:#C9A84C">${plan.toUpperCase()} — ${planPrice}</div></div>
          </div>
          <div style="background:#0F0D0A;border-radius:8px;padding:16px 20px;margin-bottom:20px">
            <div style="font-size:.72rem;font-weight:700;color:#C9A84C;text-transform:uppercase;margin-bottom:8px">Stripe Payment Link</div>
            <a href="${stripeLink}" style="color:#E8D5A3;font-size:.85rem;word-break:break-all">${stripeLink}</a>
          </div>
          <div style="background:#EDF8F1;border:1px solid #B8E0C4;border-radius:6px;padding:14px 16px">
            <div style="font-weight:700;font-size:.85rem;color:#1D6B3A;margin-bottom:6px">Next Steps</div>
            <ol style="font-size:.82rem;color:#1D6B3A;padding-left:18px;line-height:1.8">
              <li>Reply to ${email} to introduce yourself</li>
              <li>Send them the Stripe payment link above</li>
              <li>Send dashboard: getatablespot.com/restaurant-dashboard.html</li>
              <li>Add to your tracking spreadsheet</li>
            </ol>
          </div>
        </div>
      `
    });
    await sendEmail({
      to: email,
      subject: `Welcome to GetATableSpot — Your restaurant is being activated`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
          <h2 style="font-family:Georgia,serif;font-size:1.4rem;margin-bottom:8px">Welcome, ${ownerName.split(' ')[0]}! 🎉</h2>
          <p style="color:#6B7A8D;margin-bottom:24px;line-height:1.6">Your restaurant <strong>${restaurantName}</strong> is being activated on GetATableSpot.</p>
          <div style="text-align:center;margin-bottom:20px">
            <a href="${stripeLink}" style="display:inline-block;background:#C9A84C;color:#000;font-weight:700;font-size:.9rem;padding:13px 28px;border-radius:5px;text-decoration:none">Complete Free Trial Setup →</a>
            <div style="font-size:.72rem;color:#6B7A8D;margin-top:8px">7 days free · No charge until day 8 · Cancel anytime</div>
          </div>
          <p style="font-size:.78rem;color:#6B7A8D;text-align:center">Questions? Reply to this email anytime.<br><br>Welcome to GetATableSpot.<br><strong>Richard & Stephanie</strong></p>
        </div>
      `
    });
    res.json({ success: true, message: 'Claim received.' });
  } catch (err) {
    console.error('Claim error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`GetATableSpot API running on :${PORT}`));
module.exports = app;
