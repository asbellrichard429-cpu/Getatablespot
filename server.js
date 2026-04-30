// server.js — GetATableSpot API
// Required env vars:
//   GOOGLE_PLACES_API_KEY, RESEND_API_KEY, ANTHROPIC_API_KEY
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
//   STRIPE_PRICE_BASIC/PRO/ELITE/DINER, STRIPE_LINK_BASIC/PRO/ELITE/DINER
//   DATABASE_URL     (Neon postgres)
//   JWT_SECRET       (any long random string)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   NOTIFY_EMAIL, APP_URL, PORT

require(‘dotenv’).config();
const express   = require(‘express’);
const cors      = require(‘cors’);
const axios     = require(‘axios’);
const Stripe    = require(‘stripe’);
const NodeCache = require(‘node-cache’);
const rateLimit = require(‘express-rate-limit’);
const helmet    = require(‘helmet’);
const bcrypt    = require(‘bcryptjs’);
const jwt       = require(‘jsonwebtoken’);
const crypto    = require(‘crypto’);
const twilio    = require(‘twilio’);
const db        = require(’./db’);

const app = express();
app.set(‘trust proxy’, 1);

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || ‘sk_test_placeholder’);
const cache  = new NodeCache({ stdTTL: 3600 });
const twilioClient = process.env.TWILIO_ACCOUNT_SID
? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
: null;

// Stripe webhook needs raw body — register BEFORE express.json()
app.post(’/api/stripe-webhook’, express.raw({ type: ‘application/json’ }), handleStripeWebhook);

app.use(helmet());
app.use(cors({ origin: ‘*’ }));
app.use(express.json());
app.use(’/api/’, rateLimit({ windowMs: 60_000, max: 200 }));

const G_KEY        = process.env.GOOGLE_PLACES_API_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const JWT_SECRET   = process.env.JWT_SECRET || ‘dev_secret_CHANGE_IN_PROD’;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || ‘asbellrichard429@gmail.com’;
const APP_URL      = process.env.APP_URL || ‘https://getatablespot.com’;
const G_BASE       = ‘https://places.googleapis.com/v1’;

const STRIPE_PRICES = {
basic: process.env.STRIPE_PRICE_BASIC,
pro:   process.env.STRIPE_PRICE_PRO,
elite: process.env.STRIPE_PRICE_ELITE,
diner: process.env.STRIPE_PRICE_DINER,
};
const PLAN_INFO = {
basic: { label:‘Basic’,  price:’$49/month’,   trial:7 },
pro:   { label:‘Pro’,    price:’$99/month’,   trial:7 },
elite: { label:‘Elite’,  price:’$299/month’,  trial:7 },
diner: { label:‘Pro’,    price:’$2.99/month’, trial:7 },
};

const CUISINE_TYPE_MAP = {
all:‘restaurant’,italian:‘italian_restaurant’,japanese:‘japanese_restaurant’,
mexican:‘mexican_restaurant’,american:‘american_restaurant’,
bargrill:‘bar,american_restaurant’,sportsbar:‘sports_bar’,
chinese:‘chinese_restaurant’,indian:‘indian_restaurant’,french:‘french_restaurant’,
thai:‘thai_restaurant’,steakhouse:‘steak_house’,seafood:‘seafood_restaurant’,
pizza:‘pizza_restaurant’,brunch:‘breakfast_restaurant,cafe’,
};

// ── Auth middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
const h = req.headers.authorization;
if (!h?.startsWith(’Bearer ’)) return res.status(401).json({ error: ‘Unauthorized’ });
try { req.owner = jwt.verify(h.slice(7), JWT_SECRET); next(); }
catch { res.status(401).json({ error: ‘Invalid or expired token’ }); }
}

// ── Utilities ────────────────────────────────────────────────
function calcDist(lat1,lng1,lat2,lng2){
const R=3958.8,dLat=(lat2-lat1)*Math.PI/180,dLng=(lng2-lng1)*Math.PI/180;
const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
return(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1);
}
function genRef(){ return `GATS-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`; }

async function sendEmail({ to, subject, html }) {
if (!RESEND_KEY) { console.warn(‘RESEND_KEY not set’); return; }
try {
await axios.post(‘https://api.resend.com/emails’,
{ from:‘GetATableSpot [notifications@getatablespot.com](mailto:notifications@getatablespot.com)’, to, subject, html },
{ headers:{ Authorization:`Bearer ${RESEND_KEY}`, ‘Content-Type’:‘application/json’ } }
);
} catch(e){ console.error(‘Email error:’, e.response?.data || e.message); }
}

async function sendSMS(to, body) {
if (!twilioClient || !to) return;
try {
const fmt = to.startsWith(’+’) ? to : `+1${to.replace(/\D/g,'')}`;
if (fmt.replace(/\D/g,’’).length < 10) return;
await twilioClient.messages.create({ body, from:process.env.TWILIO_FROM_NUMBER, to:fmt });
} catch(e){ console.error(‘SMS error:’, e.message); }
}

// ── Google Places helpers ────────────────────────────────────
const PRICE_MAP = {
PRICE_LEVEL_FREE:‘Free’, PRICE_LEVEL_INEXPENSIVE:’$’,
PRICE_LEVEL_MODERATE:’$$’, PRICE_LEVEL_EXPENSIVE:’$$$’, PRICE_LEVEL_VERY_EXPENSIVE:’$$$$’,
};

function estimateWait(gp) {
const h=new Date().getHours(), peak=h>=18&&h<=21;
if (!gp.currentOpeningHours?.openNow) return {waitMins:0,waitLevel:‘none’};
if (!peak){const m=Math.floor(Math.random()*10);return{waitMins:m,waitLevel:m<10?‘low’:‘med’};}
const pr=PRICE_MAP[gp.priceLevel]||’$$’;
const m=pr===’$$$$’?Math.floor(30+Math.random()*30):pr===’$$$’?Math.floor(15+Math.random()*25):Math.floor(Math.random()*20);
return{waitMins:m,waitLevel:m<15?‘low’:m<30?‘med’:‘high’};
}

function buildVenue(gp, uLat, uLng){
const {waitMins,waitLevel}=estimateWait(gp);
const photo=gp.photos?.[0]?.name;
const pLat=gp.location?.latitude, pLng=gp.location?.longitude;
const dist=(uLat&&uLng&&pLat&&pLng)?`${calcDist(uLat,uLng,pLat,pLng)} mi`:‘nearby’;
return{
id:gp.id, name:gp.displayName?.text||‘Unknown’, address:gp.formattedAddress||’’,
location:gp.location, cuisine:(gp.primaryType||‘restaurant’).replace(/_/g,’ ‘),
rating:gp.rating||0, reviews:gp.userRatingCount||0, price:PRICE_MAP[gp.priceLevel]||’$$’,
isOpen:gp.currentOpeningHours?.openNow??false, hours:gp.currentOpeningHours?.weekdayDescriptions||[],
phone:gp.internationalPhoneNumber||’’, website:gp.websiteUri||’’,
photoUrl:photo?`${G_BASE}/${photo}/media?maxWidthPx=800&key=${G_KEY}`:null,
types:gp.types||[], outdoor:gp.outdoorSeating||false, reservable:gp.reservable||false,
tags:[], waitMins, waitLevel, distance:dist,
sources:[‘google’,…(gp.reservable?[‘opentable’]:[])],
isFeatured:false, plan:‘free’, tonightMsg:null, emoji:‘🍽️’,
bg:‘linear-gradient(135deg,#1A1A1A,#333)’,
};
}

async function mergeWithDB(gp, uLat, uLng){
const v=buildVenue(gp,uLat,uLng);
try{
const p=await db.getRestaurantByPlaceId(gp.id);
if(p){ v.waitMins=p.wait_mins??v.waitMins; v.waitLevel=p.wait_level??v.waitLevel;
v.isOpen=p.is_open??v.isOpen; v.isFeatured=p.is_featured??false;
v.tonightMsg=p.tonight_message||null; v.plan=p.plan; }
}catch{}
return v;
}

async function googleNearbySearch({lat,lng,radius,types}){
const body={
locationRestriction:{circle:{center:{latitude:lat,longitude:lng},radius}},
includedTypes:Array.isArray(types)?types:[types], maxResultCount:20, rankPreference:‘POPULARITY’,
};
const fields=‘places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.photos,places.types,places.primaryType,places.internationalPhoneNumber,places.websiteUri,places.dineIn,places.reservable,places.outdoorSeating’;
try{
const{data}=await axios.post(`${G_BASE}/places:searchNearby`,body,{headers:{‘Content-Type’:‘application/json’,‘X-Goog-Api-Key’:G_KEY,‘X-Goog-FieldMask’:fields}});
return data.places||[];
}catch(e){ console.error(‘Google error:’,e.response?.data||e.message); return[]; }
}

async function googleNearby({lat,lng,radius=12000,cuisine=‘all’}){
const key=`gnearby:${lat.toFixed(3)}:${lng.toFixed(3)}:${radius}:${cuisine}`;
const cached=cache.get(key); if(cached) return cached;
const types=(CUISINE_TYPE_MAP[cuisine]||‘restaurant’).split(’,’);
const off=0.022;
const centers=[{lat,lng},{lat:lat+off,lng},{lat:lat-off,lng},{lat,lng:lng+off},{lat,lng:lng-off}];
const all=await Promise.all(centers.map(c=>googleNearbySearch({lat:c.lat,lng:c.lng,radius:Math.round(radius*.65),types})));
const seen=new Set(),combined=[];
for(const res of all) for(const p of res) if(!seen.has(p.id)){seen.add(p.id);combined.push(p);}
combined.sort((a,b)=>(b.rating||0)-(a.rating||0));
cache.set(key,combined,3600);
return combined;
}

function mockSlots(){
return[‘5:30 PM’,‘6:00 PM’,‘6:30 PM’,‘7:00 PM’,‘7:30 PM’,‘8:00 PM’,‘8:30 PM’,‘9:00 PM’]
.map((time,i)=>({time,available:Math.random()>.35,remaining:Math.floor(Math.random()*6)+1,isPro:i<2}));
}

// ═══════════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════════

app.post(’/api/auth/register’, async(req,res)=>{
try{
const{email,password,name,phone,restaurantId,restaurantName,plan}=req.body;
if(!email||!password||!name) return res.status(400).json({error:‘email, password and name required’});
if(password.length<8) return res.status(400).json({error:‘Password must be at least 8 characters’});
const existing=await db.getOwnerByEmail(email);
if(existing) return res.status(409).json({error:‘An account with that email already exists’});
const passwordHash=await bcrypt.hash(password,12);
const owner=await db.createOwner({email:email.toLowerCase().trim(),passwordHash,name,phone,restaurantId,restaurantName,plan});
if(restaurantId) await db.upsertRestaurant({googlePlaceId:restaurantId,name:restaurantName||‘My Restaurant’,ownerId:owner.id,plan:plan||‘free’});
const token=jwt.sign({id:owner.id,email:owner.email},JWT_SECRET,{expiresIn:‘30d’});
await sendEmail({
to:owner.email,
subject:‘Welcome to GetATableSpot — your dashboard is ready’,
html:`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px"><h2 style="font-family:Georgia,serif">Welcome, ${name.split(' ')[0]}! 🎉</h2><p style="color:#5A6A82;line-height:1.65">Your restaurant dashboard is live. Log in anytime to update wait times, manage reservations, and see how diners are finding you.</p><a href="${APP_URL}/restaurant-dashboard.html" style="display:inline-block;margin-top:16px;background:#E8430A;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700">Go to Dashboard →</a><p style="font-size:.75rem;color:#B8AFA0;margin-top:24px">— Richard & Stephanie, GetATableSpot</p></div>`
});
res.json({token,owner:{id:owner.id,email:owner.email,name:owner.name,restaurantId:owner.restaurant_id,restaurantName:owner.restaurant_name,plan:owner.plan}});
}catch(e){ console.error(‘Register:’,e.message); res.status(500).json({error:e.message}); }
});

app.post(’/api/auth/login’, async(req,res)=>{
try{
const{email,password}=req.body;
if(!email||!password) return res.status(400).json({error:‘email and password required’});
const owner=await db.getOwnerByEmail(email);
if(!owner) return res.status(401).json({error:‘Invalid email or password’});
const valid=await bcrypt.compare(password,owner.password_hash);
if(!valid) return res.status(401).json({error:‘Invalid email or password’});
const token=jwt.sign({id:owner.id,email:owner.email},JWT_SECRET,{expiresIn:‘30d’});
res.json({token,owner:{id:owner.id,email:owner.email,name:owner.name,phone:owner.phone,restaurantId:owner.restaurant_id,restaurantName:owner.restaurant_name,plan:owner.plan,notifyEmail:owner.notify_email,notifySms:owner.notify_sms}});
}catch(e){ console.error(‘Login:’,e.message); res.status(500).json({error:e.message}); }
});

app.get(’/api/auth/me’, requireAuth, async(req,res)=>{
try{ const o=await db.getOwnerById(req.owner.id); if(!o) return res.status(404).json({error:‘Not found’}); res.json({owner:o}); }
catch(e){ res.status(500).json({error:e.message}); }
});

app.patch(’/api/auth/me’, requireAuth, async(req,res)=>{
try{
const{name,phone,notifyEmail,notifySms,currentPassword,newPassword}=req.body;
const updates={};
if(name) updates.name=name;
if(phone!==undefined) updates.phone=phone;
if(notifyEmail!==undefined) updates.notify_email=notifyEmail;
if(notifySms!==undefined) updates.notify_sms=notifySms;
if(newPassword){
if(!currentPassword) return res.status(400).json({error:‘Current password required’});
const r=await db.query(‘SELECT password_hash FROM owners WHERE id=$1’,[req.owner.id]);
if(!await bcrypt.compare(currentPassword,r.rows[0]?.password_hash)) return res.status(401).json({error:‘Current password is incorrect’});
if(newPassword.length<8) return res.status(400).json({error:‘New password must be at least 8 characters’});
updates.password_hash=await bcrypt.hash(newPassword,12);
}
const updated=await db.updateOwner(req.owner.id,updates);
res.json({success:true,owner:updated});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.post(’/api/auth/forgot-password’, async(req,res)=>{
try{
const{email}=req.body;
const owner=await db.getOwnerByEmail(email);
if(!owner) return res.json({success:true});
const token=crypto.randomBytes(32).toString(‘hex’);
await db.createPasswordReset(owner.id,token);
await sendEmail({to:owner.email,subject:‘GetATableSpot — Reset your password’,
html:`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px"><h2 style="font-family:Georgia,serif">Reset your password</h2><p style="color:#5A6A82">This link expires in 1 hour.</p><a href="${APP_URL}/restaurant-auth.html?reset=${token}" style="display:inline-block;margin:16px 0;background:#E8430A;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700">Reset Password →</a><p style="font-size:.75rem;color:#B8AFA0">If you didn't request this, ignore this email.</p></div>`
});
res.json({success:true});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.post(’/api/auth/reset-password’, async(req,res)=>{
try{
const{token,password}=req.body;
if(!token||!password) return res.status(400).json({error:‘token and password required’});
if(password.length<8) return res.status(400).json({error:‘Password must be at least 8 characters’});
const reset=await db.getPasswordReset(token);
if(!reset) return res.status(400).json({error:‘Invalid or expired reset link’});
await db.updateOwner(reset.owner_id,{password_hash:await bcrypt.hash(password,12)});
await db.markPasswordResetUsed(token);
res.json({success:true});
}catch(e){ res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD API  (all routes require auth)
// ═══════════════════════════════════════════════════════════════

app.get(’/api/dashboard/restaurant’, requireAuth, async(req,res)=>{
try{
const o=await db.getOwnerById(req.owner.id);
if(!o?.restaurant_id) return res.status(404).json({error:‘No restaurant linked to this account’});
const p=await db.getRestaurantByPlaceId(o.restaurant_id);
res.json({restaurant:p||{google_place_id:o.restaurant_id,name:o.restaurant_name,plan:o.plan}});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.patch(’/api/dashboard/restaurant’, requireAuth, async(req,res)=>{
try{
const o=await db.getOwnerById(req.owner.id);
if(!o?.restaurant_id) return res.status(404).json({error:‘No restaurant linked’});
const{waitMins,isOpen,tonightMessage}=req.body;
const u={};
if(waitMins!==undefined){ u.wait_mins=parseInt(waitMins); u.wait_level=waitMins<1?‘none’:waitMins<15?‘low’:waitMins<30?‘med’:‘high’; }
if(isOpen!==undefined) u.is_open=isOpen;
if(tonightMessage!==undefined) u.tonight_message=tonightMessage;
const updated=await db.updateRestaurant(o.restaurant_id,u);
cache.flushAll();
res.json({success:true,restaurant:updated});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.get(’/api/dashboard/reservations’, requireAuth, async(req,res)=>{
try{
const o=await db.getOwnerById(req.owner.id);
if(!o?.restaurant_id) return res.json({reservations:[]});
const{status,date}=req.query;
const reservations=await db.getReservationsByRestaurant(o.restaurant_id,{status,date});
res.json({reservations});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.patch(’/api/dashboard/reservations/:ref’, requireAuth, async(req,res)=>{
try{
const{status,ownerNote}=req.body;
const valid=[‘confirmed’,‘declined’,‘seated’,‘no_show’,‘pending’];
if(!valid.includes(status)) return res.status(400).json({error:‘Invalid status’});
const reservation=await db.getReservationByRef(req.params.ref);
if(!reservation) return res.status(404).json({error:‘Reservation not found’});
const o=await db.getOwnerById(req.owner.id);
if(reservation.restaurant_id!==o.restaurant_id) return res.status(403).json({error:‘Not authorized’});
const updated=await db.updateReservationStatus(req.params.ref,status,ownerNote);
await db.trackEvent(reservation.restaurant_id,`reservation_${status}`,{ref:req.params.ref}).catch(()=>{});

```
if(status==='confirmed'){
  await sendEmail({
    to:reservation.guest_email,
    subject:`✅ Confirmed — ${reservation.restaurant_name} at ${reservation.requested_time}`,
    html:`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF8F4"><h2 style="font-family:Georgia,serif">Your table is confirmed! 🎉</h2><p style="color:#5A6A82">Hi ${reservation.guest_name.split(' ')[0]}! ${reservation.restaurant_name} confirmed your reservation.</p><div style="background:white;border:1px solid #E0D8CC;border-radius:8px;padding:14px;font-size:.83rem;margin-bottom:14px"><div style="display:flex;justify-content:space-between;margin-bottom:7px"><span style="color:#5A6A82">Restaurant</span><strong>${reservation.restaurant_name}</strong></div><div style="display:flex;justify-content:space-between;margin-bottom:7px"><span style="color:#5A6A82">Time</span><strong>${reservation.requested_time}</strong></div><div style="display:flex;justify-content:space-between;margin-bottom:7px"><span style="color:#5A6A82">Party Size</span><strong>${reservation.party_size} guests</strong></div><div style="display:flex;justify-content:space-between"><span style="color:#5A6A82">Ref #</span><strong style="color:#E8430A">${reservation.ref}</strong></div></div>${ownerNote?`<div style="background:#EDF8F1;border:1px solid #B8E0C4;border-radius:6px;padding:12px;font-size:.82rem;color:#1D6B3A;margin-bottom:14px"><strong>Message from the restaurant:</strong><br>${ownerNote}</div>`:''}<p style="font-size:.75rem;color:#B8AFA0">See you soon!</p></div>`
  });
  await sendSMS(reservation.guest_phone,`✅ Confirmed! ${reservation.restaurant_name} at ${reservation.requested_time}, party of ${reservation.party_size}. Ref: ${reservation.ref}`);
}
if(status==='declined'){
  await sendEmail({
    to:reservation.guest_email,
    subject:`Update on your reservation at ${reservation.restaurant_name}`,
    html:`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px"><h2 style="font-family:Georgia,serif">Update on your reservation</h2><p style="color:#5A6A82">Hi ${reservation.guest_name.split(' ')[0]}, unfortunately ${reservation.restaurant_name} is unable to accommodate your ${reservation.requested_time} request.</p>${ownerNote?`<p style="color:#5A6A82"><strong>From the restaurant:</strong> ${ownerNote}</p>`:''}<p style="color:#5A6A82">Try another time or find nearby restaurants on <a href="${APP_URL}">GetATableSpot</a>.</p></div>`
  });
}
res.json({success:true,reservation:updated});
```

}catch(e){ console.error(‘Reservation update:’,e.message); res.status(500).json({error:e.message}); }
});

app.get(’/api/dashboard/slots/:date’, requireAuth, async(req,res)=>{
try{
const o=await db.getOwnerById(req.owner.id);
if(!o?.restaurant_id) return res.json({slots:[]});
res.json({slots:await db.getTimeSlots(o.restaurant_id,req.params.date)});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.put(’/api/dashboard/slots/:date’, requireAuth, async(req,res)=>{
try{
const o=await db.getOwnerById(req.owner.id);
if(!o?.restaurant_id) return res.status(404).json({error:‘No restaurant linked’});
const{slots}=req.body;
if(!Array.isArray(slots)) return res.status(400).json({error:‘slots must be an array’});
await db.setTimeSlots(o.restaurant_id,req.params.date,slots);
cache.flushAll();
res.json({success:true,count:slots.length});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.get(’/api/dashboard/analytics’, requireAuth, async(req,res)=>{
try{
const o=await db.getOwnerById(req.owner.id);
if(!o?.restaurant_id) return res.json({views:{},requests:{},confirmed:{},conversionRate:0});
res.json(await db.getAnalytics(o.restaurant_id));
}catch(e){ res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
//  PUBLIC VENUE ROUTES
// ═══════════════════════════════════════════════════════════════

app.get(’/api/venues’, async(req,res)=>{
try{
const{lat,lng,radius=12000,cuisine=‘all’}=req.query;
if(!lat||!lng) return res.status(400).json({error:‘lat and lng required’});
const uLat=parseFloat(lat),uLng=parseFloat(lng);
const results=await googleNearby({lat:uLat,lng:uLng,radius:parseInt(radius),cuisine});
const venues=await Promise.all(results.map(gp=>mergeWithDB(gp,uLat,uLng)));
venues.sort((a,b)=>(b.isFeatured-a.isFeatured)||(b.rating-a.rating));
for(const v of venues) if(v.isFeatured) db.trackEvent(v.id,‘view’,{}).catch(()=>{});
res.json({venues,total:venues.length});
}catch(e){ console.error(‘GET /api/venues:’,e.message); res.status(500).json({error:e.message}); }
});

app.get(’/api/venues/:id’, async(req,res)=>{
try{
const fields=‘id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,currentOpeningHours,photos,reviews,types,internationalPhoneNumber,websiteUri’;
const{data}=await axios.get(`${G_BASE}/places/${req.params.id}`,{headers:{‘X-Goog-Api-Key’:G_KEY,‘X-Goog-FieldMask’:fields}});
db.trackEvent(req.params.id,‘view’,{source:‘detail’}).catch(()=>{});
res.json({venue:data});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.get(’/api/venues/:id/slots’, async(req,res)=>{
try{
const date=req.query.date||new Date().toISOString().split(‘T’)[0];
const dbSlots=await db.getTimeSlots(req.params.id,date);
const slots=dbSlots.length
?dbSlots.map(s=>({time:s.slot_time,available:s.is_available,remaining:s.capacity-s.booked}))
:mockSlots();
res.json({slots,date,venueId:req.params.id});
}catch(e){ res.json({slots:mockSlots(),date:req.query.date,venueId:req.params.id}); }
});

app.get(’/api/search’, async(req,res)=>{
try{
const{q}=req.query;
if(!q) return res.status(400).json({error:‘q required’});
const{data}=await axios.get(‘https://maps.googleapis.com/maps/api/place/textsearch/json’,{params:{query:q,key:G_KEY}});
res.json({results:data.results||[]});
}catch(e){ res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
//  RESERVATIONS  (public — diner facing)
// ═══════════════════════════════════════════════════════════════

app.post(’/api/reservations’, async(req,res)=>{
try{
const{venueId,time,date,partySize,guestName,guestEmail,guestPhone,restaurantName,restaurantPhone,notes}=req.body;
if(!venueId||!guestName||!guestEmail||!time) return res.status(400).json({error:‘Missing required fields’});
const ref=genRef();
await db.createReservation({ref,restaurantId:venueId,restaurantName,guestName,guestEmail,
guestPhone:guestPhone||restaurantPhone||null,partySize:parseInt(partySize)||2,
requestedTime:time,requestedDate:date||new Date().toISOString().split(‘T’)[0],notes});
await db.trackEvent(venueId,‘reservation_request’,{ref,partySize}).catch(()=>{});
if(date&&time) db.incrementSlotBooked(venueId,date,time).catch(()=>{});

```
// Notify restaurant owner
const profile=await db.getRestaurantByPlaceId(venueId).catch(()=>null);
const owner=profile?.owner_id?await db.getOwnerById(profile.owner_id).catch(()=>null):null;

if(owner){
  if(owner.notify_email){
    await sendEmail({
      to:owner.email,
      subject:`📅 New Reservation — ${guestName}, party of ${partySize} at ${time}`,
      html:`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px"><h2 style="font-family:Georgia,serif">New Reservation Request</h2><div style="background:#F5F0E8;border-radius:8px;padding:16px;margin:16px 0;font-size:.85rem;line-height:1.9"><div><strong>${guestName}</strong></div><div>${guestEmail}${guestPhone?` · ${guestPhone}`:''}</div><div>Party of ${partySize} · ${time}${date?` · ${date}`:''}</div>${notes?`<div><em>${notes}</em></div>`:''}<div style="color:#888;font-size:.73rem;margin-top:6px">Ref: ${ref}</div></div><a href="${APP_URL}/restaurant-dashboard.html" style="display:inline-block;background:#E8430A;color:white;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700">Confirm or Decline →</a></div>`
    });
  }
  if(owner.notify_sms&&owner.phone){
    await sendSMS(owner.phone,`GetATableSpot: New reservation! ${guestName}, party of ${partySize} at ${time}. Ref: ${ref}. Dashboard: ${APP_URL}/restaurant-dashboard.html`);
  }
} else {
  await sendEmail({to:NOTIFY_EMAIL,subject:`📅 Reservation — ${restaurantName} · ${guestName} x${partySize} at ${time}`,
    html:`<p>${guestName} · ${guestEmail} · ${guestPhone||'no phone'}<br>x${partySize} at ${time} · ${restaurantName}<br>Ref: ${ref}</p>`});
}

// Diner confirmation
await sendEmail({
  to:guestEmail,
  subject:`✓ Request Sent — ${restaurantName} at ${time}`,
  html:`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF8F4"><h2 style="font-family:Georgia,serif">Request Sent!</h2><p style="color:#5A6A82">Hi ${guestName.split(' ')[0]}! Your request has been sent to ${restaurantName}. They'll confirm shortly.</p><div style="background:white;border:1px solid #E0D8CC;border-radius:8px;padding:14px;font-size:.83rem;margin-bottom:14px"><div style="display:flex;justify-content:space-between;margin-bottom:7px"><span style="color:#5A6A82">Restaurant</span><strong>${restaurantName}</strong></div><div style="display:flex;justify-content:space-between;margin-bottom:7px"><span style="color:#5A6A82">Requested Time</span><strong>${time}</strong></div><div style="display:flex;justify-content:space-between;margin-bottom:7px"><span style="color:#5A6A82">Party Size</span><strong>${partySize} guests</strong></div><div style="display:flex;justify-content:space-between"><span style="color:#5A6A82">Ref #</span><strong style="color:#E8430A">${ref}</strong></div></div><a href="${APP_URL}" style="display:block;background:#111;border-radius:6px;padding:11px;text-align:center;color:#E8430A;font-weight:700;font-size:.82rem;text-decoration:none">Find more restaurants →</a></div>`
});
res.json({success:true,confirmationNumber:ref});
```

}catch(e){ console.error(‘Reservation:’,e.message); res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
//  AI CONCIERGE
// ═══════════════════════════════════════════════════════════════

app.post(’/api/ai-concierge’, async(req,res)=>{
try{
const{messages,restaurantContext}=req.body;
if(!messages||!restaurantContext) return res.status(400).json({error:‘Missing messages or context’});
if(!ANTHROPIC_KEY) return res.status(500).json({error:‘AI not configured’});
const system=`You are a warm helpful AI dining concierge for GetATableSpot.\n\nRESTAURANTS NEAR THE USER:\n${restaurantContext}\n\nRULES:\n- Recommend 2-3 restaurants that best match the request\n- Be warm and conversational\n- Only recommend from the list above\n- Explain briefly why each fits\n- Keep responses concise`;
const{data}=await axios.post(‘https://api.anthropic.com/v1/messages’,
{model:‘claude-sonnet-4-20250514’,max_tokens:600,system,messages},
{headers:{‘Content-Type’:‘application/json’,‘x-api-key’:ANTHROPIC_KEY,‘anthropic-version’:‘2023-06-01’}}
);
res.json(data);
}catch(e){ console.error(‘AI:’,e.response?.data||e.message); res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
//  RESTAURANT CLAIM
// ═══════════════════════════════════════════════════════════════

app.post(’/api/restaurant-claim’, async(req,res)=>{
try{
const{restaurantName,restaurantAddress,ownerName,email,phone,role,plan,venueId}=req.body;
if(!restaurantName||!email||!plan) return res.status(400).json({error:‘restaurantName, email, plan required’});
const pi=PLAN_INFO[plan]||PLAN_INFO.pro;
let stripeLink=’’;
const priceId=STRIPE_PRICES[plan];
if(priceId&&!process.env.STRIPE_SECRET_KEY?.includes(‘placeholder’)){
try{
const s=await stripe.checkout.sessions.create({mode:‘subscription’,payment_method_types:[‘card’],line_items:[{price:priceId,quantity:1}],subscription_data:{trial_period_days:pi.trial,metadata:{restaurantName,ownerName,plan,venueId:venueId||’’}},customer_email:email,success_url:`${APP_URL}/restaurant-dashboard.html?session={CHECKOUT_SESSION_ID}&plan=${plan}`,cancel_url:`${APP_URL}/claim-restaurant.html?cancelled=1`,metadata:{restaurantName,ownerName,email,phone,role,plan,venueId:venueId||’’}});
stripeLink=s.url;
}catch(e){ console.error(‘Stripe:’,e.message); }
}
if(!stripeLink){ const fb={basic:process.env.STRIPE_LINK_BASIC,pro:process.env.STRIPE_LINK_PRO,elite:process.env.STRIPE_LINK_ELITE}; stripeLink=fb[plan]||`${APP_URL}/restaurant-auth.html`; }
await sendEmail({to:NOTIFY_EMAIL,subject:`🍽️ New Claim — ${restaurantName} (${pi.label})`,html:`<div style="font-family:sans-serif;padding:24px"><h2>New Restaurant Claim</h2><p><strong>${restaurantName}</strong> · ${restaurantAddress||''}</p><p>${ownerName} · ${role||'Owner'} · ${email} · ${phone||''}</p><p style="color:#E8430A;font-weight:700">${pi.label} — ${pi.price}</p><a href="${stripeLink}">${stripeLink}</a></div>`});
await sendEmail({to:email,subject:`Welcome to GetATableSpot — ${restaurantName} is being activated 🎉`,html:`<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px"><h2 style="font-family:Georgia,serif">Welcome, ${(ownerName||'there').split(' ')[0]}! 🎉</h2><p style="color:#6B7A8D;line-height:1.65">Your restaurant <strong>${restaurantName}</strong> is being activated on the <strong>${pi.label}</strong> plan.</p><div style="text-align:center;margin:20px 0"><a href="${stripeLink}" style="display:inline-block;background:#E8430A;color:white;font-weight:700;font-size:.9rem;padding:13px 28px;border-radius:6px;text-decoration:none">Complete Setup → Start Free Trial</a><p style="font-size:.72rem;color:#6B7A8D;margin-top:8px">${pi.trial} days free · Cancel anytime</p></div><p style="font-size:.78rem;color:#6B7A8D;text-align:center">— Richard & Stephanie, GetATableSpot</p></div>`});
res.json({success:true,stripeLink});
}catch(e){ console.error(‘Claim:’,e.message); res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
//  STRIPE WEBHOOK
// ═══════════════════════════════════════════════════════════════

async function handleStripeWebhook(req,res){
const sig=req.headers[‘stripe-signature’];
const secret=process.env.STRIPE_WEBHOOK_SECRET;
if(!secret) return res.json({received:true});
let event;
try{ event=stripe.webhooks.constructEvent(req.body,sig,secret); }
catch(e){ return res.status(400).send(`Webhook Error: ${e.message}`); }

if(event.type===‘checkout.session.completed’){
const s=event.data.object;
const{restaurantName,plan,venueId,email}=s.metadata||{};
if(venueId){
await db.upsertRestaurant({googlePlaceId:venueId,name:restaurantName||‘Restaurant’,plan}).catch(console.error);
await db.updateRestaurant(venueId,{plan,is_featured:[‘pro’,‘elite’].includes(plan),stripe_customer_id:s.customer,stripe_subscription_id:s.subscription}).catch(console.error);
}
if(email){
const ex=await db.getOwnerByEmail(email).catch(()=>null);
if(!ex){
await sendEmail({to:email,subject:‘GetATableSpot — Create your dashboard login’,
html:`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px"><h2 style="font-family:Georgia,serif">Payment confirmed! Create your login 🎉</h2><p style="color:#5A6A82">Your ${plan} plan is active. Create your dashboard login to manage reservations and wait times.</p><a href="${APP_URL}/restaurant-auth.html?email=${encodeURIComponent(email)}&placeId=${encodeURIComponent(venueId||'')}&restaurantName=${encodeURIComponent(restaurantName||'')}&plan=${plan}" style="display:inline-block;margin-top:16px;background:#E8430A;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700">Create Dashboard Login →</a></div>`
});
}
}
cache.flushAll();
}
if(event.type===‘customer.subscription.deleted’){
const sub=event.data.object;
const{rows}=await db.query(‘SELECT google_place_id FROM restaurants WHERE stripe_subscription_id=$1’,[sub.id]).catch(()=>({rows:[]}));
if(rows[0]){ await db.updateRestaurant(rows[0].google_place_id,{plan:‘free’,is_featured:false}).catch(console.error); cache.flushAll(); }
}
res.json({received:true});
}

// ═══════════════════════════════════════════════════════════════
//  MISC
// ═══════════════════════════════════════════════════════════════

app.post(’/api/subscribe’, async(req,res)=>{
try{
const{email}=req.body;
if(!email) return res.status(400).json({error:‘email required’});
let checkoutUrl=’’;
if(STRIPE_PRICES.diner&&!process.env.STRIPE_SECRET_KEY?.includes(‘placeholder’)){
try{ const s=await stripe.checkout.sessions.create({mode:‘subscription’,payment_method_types:[‘card’],line_items:[{price:STRIPE_PRICES.diner,quantity:1}],subscription_data:{trial_period_days:7},customer_email:email,success_url:`${APP_URL}/index.html?pro=1`,cancel_url:`${APP_URL}/pro-subscription.html`}); checkoutUrl=s.url; }catch(e){ console.error(‘Diner Stripe:’,e.message); }
}
if(!checkoutUrl) checkoutUrl=process.env.STRIPE_LINK_DINER||`${APP_URL}/pro-subscription.html`;
res.json({success:true,checkoutUrl});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.post(’/api/waitlist’, async(req,res)=>{
try{
const{email,feature}=req.body;
if(!email) return res.status(400).json({error:‘email required’});
await sendEmail({to:NOTIFY_EMAIL,subject:`📬 Waitlist: ${feature}`,html:`<p><strong>${email}</strong> — ${feature}</p>`});
res.json({success:true});
}catch(e){ res.status(500).json({error:e.message}); }
});

app.get(’/health’, async(_,res)=>{
let dbOk=false;
try{ await db.query(‘SELECT 1’); dbOk=true; }catch{}
res.json({status:‘ok’,db:dbOk?‘connected’:‘error’,timestamp:new Date()});
});

const PORT=process.env.PORT||10000;
app.listen(PORT,‘0.0.0.0’,()=>console.log(`GetATableSpot API on :${PORT}`));
module.exports=app;