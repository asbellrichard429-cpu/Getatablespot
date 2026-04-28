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
const RESEND_KEY = process.env.RESEND_API_KEY;
const G_BASE = 'https://places.googleapis.com/v1';
const NOTIFY_EMAIL = 'asbellrichard429@gmail.com';

// All verified valid Google Places API types only
const CUISINE_TYPE_MAP = {
  all:        ['restaurant'],
  italian:    ['italian_restaurant'],
  japanese:   ['japanese_restaurant'],
  mexican:    ['mexican_restaurant'],
  american:   ['american_restaurant'],
  bargrill:   ['bar', 'american_restaurant'],
  sportsbar:  ['sports_bar'],
  chinese:    ['chinese_restaurant'],
  indian:     ['indian_restaurant'],
  french:     ['french_restaurant'],
  thai:       ['thai_restaurant'],
  steakhouse: ['steak_house'],
  seafood:    ['seafood_restaurant'],
  pizza:      ['pizza_restaurant'],
  brunch:     ['breakfast_restaurant', 'cafe'],
};

function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))).toFixed(1);
}

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

async function googleNearbySearch({ lat, lng, radius, types }) {
  const body = {
    locationRestriction: {
      circle: { center: { latitude: lat, longitude: lng }, radius }
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

async function googleNearbyRestaurants({ lat, lng, radius = 12000, cuisine = 'all' }) {
  const cacheKey = `gnearby:${lat.toFixed(3)}:${lng.toFixed(3)}:${radius}:${cuisine}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const types = CUISINE_TYPE_MAP[cuisine] || ['restaurant'];
  const offset = 0.022;
  const centers = [
    { lat, lng },
    { lat: lat + offset, lng },
    { lat: lat - offset, lng },
    { lat, lng: lng + offset },
    { lat, lng: lng - offset },
  ];

  const allResults = await Promise.all(
    centers.map(c => googleNearbySearch({
      lat: c.lat, lng: c.lng,
      radius: Math.round(radius * 0.65),
      types,
    }))
  );

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

  combined.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  cache.set(cacheKey, combined, 3600);
  console.log(`Found ${combined.length} places for cuisine: ${cuisine}`);
  return combined;
}

const PRICE_MAP = {
  PRICE_LEVEL_FREE: 'Free',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};

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

function mergeRestaurant(gPlace, userLat, userLng) {
  const { waitMins, waitLevel } = estimateWait(gPlace);
  const photo = gPlace.photos?.[0]?.name;
  const placeLat = gPlace.location?.latitude;
  const placeLng = gPlace.location?.longitude;
  const distance = (userLat && userLng && placeLat && placeLng)
    ? `${calcDistance(userLat, userLng, placeLat, placeLng)} mi`
    : 'nearby';

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
    tags: [],
    waitMins,
    waitLevel,
    distance,
    sources: ['google', ...(gPlace.reservable ? ['opentable'] : [])],
    isFeatured: false,
    michelin: false,
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
    const { lat, lng, radius = 12000, cuisine = 'all' } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const googleResults = await googleNearbyRestaurants({
      lat: userLat, lng: userLng,
      radius: parseInt(radius),
      cuisine,
    });
    const merged = googleResults.map(gp => mergeRestaurant(gp, userLat, userLng));
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
  res.json({ slots: generateMockSlots(), date: req.query.date, venueId: req.params.id });
});

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const { data } = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      { params: { query: q, key: G_KEY } }
    );
    res.json({ results: data.results || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reservations', async (req, res) => {
  try {
    const { venueId, time, date, partySize, guestName, guestEmail, restaurantName, restaurantPhone, notes } = req.body;
    if (!venueId || !guestName || !guestEmail || !time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const id = `GATS-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    reservations.set(id, { id, venueId, time, date, partySize, guestName, guestEmail, notes, status: 'confirmed', createdAt: new Date() });

    await sendEmail({
      to: guestEmail,
      subject: `✓ Reservation Confirmed — ${restaurantName || 'Your Restaurant'} at ${time}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF8F4">
          <div style="text-align:center;margin-bottom:24px">
            <div style="font-family:Georgia,serif;font-size:1.4rem;font-weight:900">GetATableSpot</div>
          </div>
          <div style="background:white;border:1px solid #E0D8CC;border-radius:10px;padding:24px;margin-bottom:16px">
            <div style="font-size:1.6rem;text-align:center;margin-bottom:10px">🎉</div>
            <h2 style="font-family:Georgia,serif;font-size:1.2rem;text-align:center;margin-bottom:4px">Reservation Confirmed!</h2>
            <p style="color:#5A6A82;font-size:.85rem;text-align:center;margin-bottom:18px">See you there, ${(guestName||'').split(' ')[0]}!</p>
            <div style="background:#F5F0E8;border-radius:8px;padding:16px;font-size:.85rem">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#5A6A82">Restaurant</span><span style="font-weight:700">${restaurantName||'Your Restaurant'}</span></div>
              <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#5A6A82">Time</span><span style="font-weight:700">${time}</span></div>
              <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#5A6A82">Party Size</span><span style="font-weight:700">${partySize} guests</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#5A6A82">Confirmation #</span><span style="font-weight:700;color:#E8B84B">${id}</span></div>
            </div>
          </div>
          ${notes ? `<div style="background:white;border:1px solid #E0D8CC;border-radius:8px;padding:12px;margin-bottom:14px;font-size:.83rem"><strong>Special Requests:</strong> ${notes}</div>` : ''}
          <div style="background:#1A0A2E;border-radius:8px;padding:12px;text-align:center;margin-bottom:14px">
            <div style="font-size:.75rem;color:rgba(255,255,255,.5);margin-bottom:5px">Check wait times before you head out</div>
            <a href="https://getatablespot.com" style="color:#E8B84B;font-weight:700;font-size:.82rem;text-decoration:none">getatablespot.com →</a>
          </div>
          <p style="font-size:.7rem;color:#A8A094;text-align:center">Need to cancel? Contact the restaurant.${restaurantPhone ? ` Phone: ${restaurantPhone}` : ''}</p>
        </div>
      `
    });

    res.json({ success: true, confirmationNumber: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/restaurant-dashboard/:id', async (req, res) => {
  const profile = restaurantProfiles.get(req.params.id) || {
    venueId: req.params.id, waitMins: 0, isFeatured: false, plan: 'free', slots: [],
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
    revenueViaGetATableSpot: 850.50,
  });
});

app.post('/api/restaurant-claim', async (req, res) => {
  try {
    const { restaurantName, restaurantAddress, ownerName, email, phone, role, plan, stripeLink } = req.body;
    console.log('New restaurant claim:', { restaurantName, ownerName, email, plan });
    const planPrices = { basic: '$49/month', pro: '$99/month', elite: '$299/month' };
    const planPrice = planPrices[plan] || '$99/month';

    await sendEmail({
      to: NOTIFY_EMAIL,
      subject: `🍽️ New Restaurant Claim — ${restaurantName}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
          <h2 style="font-family:Georgia,serif;margin-bottom:8px">New Restaurant Claim</h2>
          <p style="color:#6B7A8D;margin-bottom:20px">Someone just claimed on GetATableSpot</p>
          <div style="background:#F5F0E8;border-radius:8px;padding:20px;margin-bottom:14px">
            <p style="font-weight:700;font-size:1rem;margin-bottom:4px">${restaurantName}</p>
            <p style="color:#6B7A8D;font-size:.85rem;margin-bottom:12px">${restaurantAddress}</p>
            <p style="font-size:.85rem;margin-bottom:4px"><strong>${ownerName}</strong> · ${role}</p>
            <p style="font-size:.85rem;margin-bottom:12px">${email} · ${phone}</p>
            <p style="font-weight:700;color:#C9A84C">${(plan||'pro').toUpperCase()} — ${planPrice}</p>
          </div>
          <div style="background:#0F0D0A;border-radius:8px;padding:14px;margin-bottom:14px">
            <p style="color:#C9A84C;font-size:.7rem;font-weight:700;margin-bottom:6px">STRIPE PAYMENT LINK</p>
            <a href="${stripeLink}" style="color:#E8D5A3;font-size:.82rem;word-break:break-all">${stripeLink}</a>
          </div>
          <div style="background:#EDF8F1;border:1px solid #B8E0C4;border-radius:6px;padding:14px">
            <p style="font-weight:700;color:#1D6B3A;margin-bottom:8px">Next steps:</p>
            <ol style="color:#1D6B3A;font-size:.82rem;padding-left:18px;line-height:1.8;margin:0">
              <li>Email ${email} to introduce yourself</li>
              <li>Send Stripe payment link above</li>
              <li>Send dashboard link: getatablespot.com/restaurant-dashboard.html</li>
              <li>Add to tracking spreadsheet</li>
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
          <h2 style="font-family:Georgia,serif;margin-bottom:8px">Welcome, ${(ownerName||'there').split(' ')[0]}! 🎉</h2>
          <p style="color:#6B7A8D;line-height:1.6;margin-bottom:20px">Your restaurant <strong>${restaurantName}</strong> is being activated on GetATableSpot. As a founding restaurant you get priority placement as our diner base grows in your market.</p>
          <div style="text-align:center;margin-bottom:18px">
            <a href="${stripeLink}" style="display:inline-block;background:#C9A84C;color:#000;font-weight:700;font-size:.9rem;padding:13px 28px;border-radius:5px;text-decoration:none">Complete Your Free Trial Setup →</a>
            <p style="font-size:.72rem;color:#6B7A8D;margin-top:8px">7 days free · No charge until day 8 · Cancel anytime</p>
          </div>
          <p style="font-size:.78rem;color:#6B7A8D;text-align:center">Reply to this email anytime with questions.<br><br>— Richard & Stephanie, GetATableSpot</p>
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

// AI Concierge proxy — routes browser requests through backend to Anthropic
app.post('/api/ai-concierge', async (req, res) => {
  try {
    const { messages, restaurantContext } = req.body;
    if (!messages || !restaurantContext) {
      return res.status(400).json({ error: 'Missing messages or context' });
    }

    const system = `You are a warm helpful AI dining concierge for GetATableSpot. Help diners find the perfect restaurant.

RESTAURANTS AVAILABLE RIGHT NOW NEAR THE USER:
${restaurantContext}

RULES:
- Recommend 2-3 restaurants that best match the request
- Be warm and conversational, not robotic
- Only recommend from the list above — never invent restaurants
- Explain briefly why each one fits
- If nothing matches well, say so honestly and suggest adjusting filters
- Keep responses concise — 3-4 sentences then recommendations`;

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system,
      messages,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });

    res.json(response.data);
  } catch (err) {
    console.error('AI proxy error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date() }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`GetATableSpot API running on :${PORT}`));
module.exports = app;
