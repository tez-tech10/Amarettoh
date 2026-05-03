/**
 * Amaretto H. — Video Store Backend
 * Railway + Supabase + Mux + Payhip
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const Mux      = require('@mux/mux-node');

const app = express();

// ── CLIENTS ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service key — never expose to frontend
);

const muxClient = new Mux({
  tokenId:     process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.SITE_URL || 'https://amarettoh.com',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

// Raw body for Payhip webhook signature verification
app.use('/webhook/payhip', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── ADMIN AUTH MIDDLEWARE ────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const key  = auth.replace('Bearer ', '').trim();
  if (key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────

// GET /api/videos — returns all active videos for the store page
app.get('/api/videos', async (req, res) => {
  const { data, error } = await supabase
    .from('videos')
    .select('id, title, description, price, duration, mux_preview_id, payhip_url')
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/watch/:token — validate token, return signed Mux URL
app.get('/api/watch/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, process.env.JWT_SECRET);

    // Check not revoked
    const { data: order } = await supabase
      .from('orders')
      .select('id, video_id, revoked')
      .eq('token', req.params.token)
      .single();

    if (!order || order.revoked) {
      return res.status(410).json({ expired: true });
    }

    // Get video
    const { data: video } = await supabase
      .from('videos')
      .select('title, mux_full_id')
      .eq('id', order.video_id)
      .single();

    if (!video || !video.mux_full_id) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Generate a short-lived Mux signed URL (2 hours)
    const signedToken = await muxClient.jwt.signPlaybackId(video.mux_full_id, {
      type:       'video',
      expiration: '2h',
    });
    const streamUrl = `https://stream.mux.com/${video.mux_full_id}.m3u8?token=${signedToken}`;

    res.json({ url: streamUrl, title: video.title });
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(410).json({ expired: true });
    }
    console.error('Watch error:', e);
    res.status(400).json({ error: 'Invalid token' });
  }
});

// ── PAYHIP WEBHOOK ────────────────────────────────────────────────────────────
// Payhip calls this after a successful purchase
app.post('/webhook/payhip', async (req, res) => {
  // Verify Payhip signature
  const sig       = req.headers['x-payhip-signature'] || '';
  const secret    = process.env.PAYHIP_WEBHOOK_SECRET;
  const expected  = crypto
    .createHmac('sha256', secret)
    .update(req.body)
    .digest('hex');

  if (sig !== expected) {
    console.warn('Invalid Payhip signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body.toString());
  if (event.event !== 'payment:completed') {
    return res.json({ received: true }); // ignore other events
  }

  const { buyer_email, product_link } = event.data;

  // Find which video this Payhip product matches
  const { data: video } = await supabase
    .from('videos')
    .select('id, title')
    .eq('payhip_url', product_link)
    .single();

  if (!video) {
    console.error('No video found for payhip product:', product_link);
    return res.status(200).json({ ok: true }); // always 200 to Payhip
  }

  // Generate watch token — expires in 48h
  const token = jwt.sign(
    { email: buyer_email, videoId: video.id },
    process.env.JWT_SECRET,
    { expiresIn: '48h' }
  );

  // Store the order
  await supabase.from('orders').insert({
    video_id:     video.id,
    buyer_email:  buyer_email,
    token:        token,
    payhip_event: JSON.stringify(event.data),
    expires_at:   new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  });

  // The watch link we'll send to the buyer via Payhip's thank-you content
  const siteUrl   = process.env.SITE_URL || 'https://amarettoh.com';
  const watchLink = `${siteUrl}/watch?t=${token}`;

  console.log(`Order for "${video.title}" by ${buyer_email} → ${watchLink}`);

  // Return the link to Payhip (shown on thank-you page + email)
  res.json({ download_url: watchLink });
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// GET /api/admin/videos — all videos (active + hidden)
app.get('/api/admin/videos', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/admin/videos — create video
app.post('/api/admin/videos', adminAuth, async (req, res) => {
  const { title, description, price, duration, mux_preview_id, mux_full_id, payhip_url, active } = req.body;
  if (!title || !mux_preview_id || !payhip_url) {
    return res.status(400).json({ error: 'title, mux_preview_id and payhip_url are required' });
  }
  const { data, error } = await supabase.from('videos').insert({
    title, description, price, duration,
    mux_preview_id, mux_full_id, payhip_url,
    active: active !== false,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/admin/videos/:id — update video
app.put('/api/admin/videos/:id', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('videos')
    .update(req.body)
    .eq('id', req.params.id)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/admin/videos/:id — delete video
app.delete('/api/admin/videos/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('videos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

// GET /api/admin/orders — all orders
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('id, buyer_email, expires_at, revoked, created_at, videos(title)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/admin/orders/:id/revoke — revoke a watch token
app.post('/api/admin/orders/:id/revoke', adminAuth, async (req, res) => {
  const { error } = await supabase
    .from('orders')
    .update({ revoked: true })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ revoked: true });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
