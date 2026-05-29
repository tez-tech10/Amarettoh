/**
 * Amaretto H. — Video Store Backend v3
 * pg (direct Postgres) + Resend + Payhip webhook
 * No Mux API — embed codes parsed client-side + server-side
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const multer   = require('multer');
const { Pool } = require('pg');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ── CLIENTS ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const resend = new Resend(process.env.RESEND_API_KEY);

const SITE_URL   = process.env.SITE_URL || 'https://amarettoh.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@amarettoh.com';
const MAX_IPS    = 3;

// getSiteUrl — DB first, env fallback, hardcoded fallback
async function getSiteUrl(modelId) {
  try {
    const m = await getModel(modelId);
    if (m?.site_url) return m.site_url.replace(/\/+$/, ''); // strip trailing slash
  } catch(e) { /* DB not ready */ }
  const envMap = {
    amaretto: process.env.SITE_URL_AMARETTO || process.env.SITE_URL,
    nyla:     process.env.SITE_URL_NYLA,
    sophia:   process.env.SITE_URL_SOPHIA,
    amber:    process.env.SITE_URL_AMBER    || 'https://storied-pegasus-eed2aa.netlify.app',
    ellie:    process.env.SITE_URL_ELLIE,
  };
  const url = envMap[modelId] || SITE_URL || 'https://storied-pegasus-eed2aa.netlify.app';
  return url.replace(/\/+$/, ''); // strip trailing slash
}

// Supabase client for storage operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // Allow all netlify sites, custom domains, and localhost
    const alwaysAllow = [
      'http://localhost:3000',
      'http://127.0.0.1:5500',
    ];
    if (
      alwaysAllow.includes(origin) ||
      origin.endsWith('.netlify.app') ||
      origin.endsWith('.railway.app') ||
      origin === 'https://amberxdyme.com' ||
      origin === 'https://www.amberxdyme.com' ||
      origin === 'https://nylagreen.com' ||
      origin === 'https://www.nylagreen.com' ||
      origin === SITE_URL
    ) {
      return callback(null, true);
    }
    // Also check models table for registered site URLs
    getModels().then(function(models) {
      const modelUrls = Object.values(models).map(function(m) { return m.site_url; }).filter(Boolean);
      if (modelUrls.some(function(u) { return origin === u || origin === u.replace('https://','https://www.'); })) {
        return callback(null, true);
      }
      callback(new Error('CORS: origin not allowed — ' + origin));
    }).catch(function() { callback(null, true); }); // allow if DB fails
  },
  methods: ['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use('/webhook/payhip', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── HELPERS ───────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

// Extract Payhip product ID from any URL format
function extractPayhipId(url) {
  if (!url) return null;
  try {
    // Format 1: payhip.com/b/XXXXX
    let m = url.match(/payhip\.com\/b\/([A-Za-z0-9]+)/);
    if (m) return m[1];
    // Decode percent-encoding first (link%5B%5D -> link[])
    const decoded = decodeURIComponent(url);
    // Format 2: link[]=XXXXX
    m = decoded.match(/link\.{0,1}\[\]=([A-Za-z0-9]+)/);
    if (m) return m[1];
    // Format 3: cart_links[]=XXXXX
    m = decoded.match(/cart_links\[\]=([A-Za-z0-9]+)/);
    if (m) return m[1];
    // Format 4: any param =XXXXX where XXXXX is 4-6 alphanumeric (Payhip product key length)
    m = decoded.match(/[?&][^=]+=([A-Za-z0-9]{4,8})(?:&|$)/);
    if (m) return m[1];
  } catch(e) {}
  return null;
}

// Extract Mux playback ID from embed code, iframe, or URL
function extractMuxId(input) {
  input = (input || '').trim();
  if (!input) return null;
  let m;
  m = input.match(/player\.mux\.com\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  m = input.match(/stream\.mux\.com\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  m = input.match(/mux\.com[^"']*\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(input)) return input;
  m = input.match(/\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return null;
}

// ═══════════════════════════════════════════════════════════
// PUBLIC — Videos for store page
// ═══════════════════════════════════════════════════════════

app.get('/api/videos', async (req, res) => {
  try {
    const model = req.query.model || null;
    const { rows } = await pool.query(
      `SELECT id, title, description, price, duration,
              preview_type, mux_preview_id, mux_full_id, payhip_url,
              COALESCE(payment_method, 'payhip') as payment_method
       FROM videos
       WHERE active = true
       ${model ? 'AND model_id = $1' : ''}
       ORDER BY created_at DESC`,
      model ? [model] : []
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PAYHIP WEBHOOK
// ═══════════════════════════════════════════════════════════

app.post('/webhook/payhip', async (req, res) => {
  const sig    = req.headers['x-payhip-signature'] || '';
  const secret = process.env.PAYHIP_WEBHOOK_SECRET || '';

  // Only verify signature if Payhip sends it (real purchases)
  // Test webhooks from Payhip dashboard don't include the signature header
  if (sig && secret) {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(req.body).digest('hex');
    if (sig !== expected) {
      console.warn('[Webhook] Bad signature — rejecting');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  console.log('[Webhook] Received — sig present:', !!sig);

  let event;
  try {
    event = JSON.parse(req.body.toString());
    console.log('[Webhook] event type:', event.event);
    console.log('[Webhook] full body:', JSON.stringify(event).slice(0, 500));
  } catch(e) {
    console.error('[Webhook] JSON parse error:', e.message);
    return res.json({ received: true });
  }

  // Handle both real purchase format (event.event = 'payment:completed')
  // and Payhip test format (no event field, data directly in body)
  const isRealPurchase = event.event === 'payment:completed';
  const isTestWebhook  = !event.event && event.email && event.items;

  if (!isRealPurchase && !isTestWebhook) {
    console.log('[Webhook] Ignoring event:', event.event);
    return res.json({ received: true });
  }

  // Normalize the data from either format
  let buyer_email, order_id, productId, amount;

  if (isRealPurchase) {
    buyer_email = event.data.buyer_email;
    order_id    = event.data.order_id;
    amount      = event.data.amount;
    const productLink = event.data.product_link || '';
    productId = extractPayhipId(productLink) || productLink.split('/b/').pop().split('/')[0];
  } else {
    // Test webhook format
    buyer_email = event.email;
    order_id    = event.id;
    amount      = event.price;
    productId   = event.items?.[0]?.product_key || '';
  }

  console.log('[Webhook] buyer:', buyer_email, 'order:', order_id, 'product:', productId);

  try {
    // Find matching video — order by created_at to get most recent if duplicates exist
    const { rows: vids } = await pool.query(
      `SELECT id, title, mux_full_id, mux_preview_id, model_id
       FROM videos
       WHERE payhip_product_id = $1 AND active = true
       ORDER BY created_at DESC
       LIMIT 1`,
      [productId]
    );
    const video = vids[0] || null;
    console.log(`[Webhook] product_id: ${productId}, video found: ${video?.title || 'none'}, model: ${video?.model_id || 'none'}`);

    const email = buyer_email.toLowerCase().trim();
    const buyerIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || null;

    const { rows: insertRows } = await pool.query(
      `INSERT INTO purchases
         (payhip_order_id, buyer_email, video_id, payhip_product_id, amount, payhip_payload, buyer_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (payhip_order_id) DO NOTHING
       RETURNING id`,
      [order_id, email, video?.id || null,
       productId, parseFloat(amount) || null, JSON.stringify(event.data), buyerIp]
    );
    const purchase = insertRows[0] || null;
    buyer_email = email;

    console.log(`[Webhook] Purchase stored: ${buyer_email} → ${video?.title || productId}`);

    // ── Send watch link immediately — no verify page needed ──
    if (video) {
      try {
        const token    = makeToken();
        const modelSite = await getSiteUrl(video.model_id || 'amaretto');
        const watchUrl  = `${modelSite}/watch?t=${token}`;
        const muxId    = video.mux_full_id || video.mux_preview_id;

        // Insert watch token
        await pool.query(
          `INSERT INTO video_tokens
             (token, purchase_id, video_id, video_title, mux_playback_id, buyer_email, allowed_ips)
           VALUES ($1,$2,$3,$4,$5,$6,'[]')`,
          [token, purchase.id, video.id, video.title, muxId, buyer_email]
        );

        // Send email via Resend
        console.log(`[Webhook] Sending watch link to ${buyer_email}...`);
        const emailResult = await resend.emails.send({
          from:    FROM_EMAIL,
          to:      buyer_email,
          subject: `Your video is ready — ${video.title}`,
          html:    buildWatchEmail(video.title, watchUrl, order_id, video.model_id),
        });
        console.log(`[Webhook] Resend result:`, JSON.stringify(emailResult));

        // Lock purchase
        await pool.query(
          `UPDATE purchases SET link_sent=true, link_sent_at=NOW(), watch_token=$1, watch_url=$2 WHERE id=$3`,
          [token, watchUrl, purchase.id]
        );

        console.log(`[Webhook] Watch link sent to ${buyer_email}: ${watchUrl}`);
      } catch (emailErr) {
        console.error('[Webhook] Email send error:', emailErr.message);
        // Purchase is stored, can retry via /api/verify
      }
    } else {
      console.warn(`[Webhook] No matching video found for product: ${productId}`);
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[Webhook] Error:', e.message);
    res.json({ received: true }); // always 200
  }
});

// ── RESEND LINK — admin manually resends watch link ──
app.post('/api/admin/resend-link/:purchaseId', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, v.title, v.mux_full_id, v.mux_preview_id, v.model_id
       FROM purchases p LEFT JOIN videos v ON v.id = p.video_id
       WHERE p.id = $1`, [req.params.purchaseId]
    );
    const purchase = rows[0];
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    // Revoke old token
    if (purchase.watch_token) {
      await pool.query('UPDATE video_tokens SET is_active=false WHERE token=$1', [purchase.watch_token]);
    }

    // Generate new token
    const token    = makeToken();
    const watchUrl = `${await getSiteUrl(purchase.model_id || 'amaretto')}/watch?t=${token}`;
    const muxId    = purchase.mux_full_id || purchase.mux_preview_id;

    await pool.query(
      `INSERT INTO video_tokens
         (token, purchase_id, video_id, video_title, mux_playback_id, buyer_email, allowed_ips)
       VALUES ($1,$2,$3,$4,$5,$6,'[]')`,
      [token, purchase.id, purchase.video_id, purchase.title, muxId, purchase.buyer_email]
    );

    // Update purchase with new token
    await pool.query(
      `UPDATE purchases SET watch_token=$1, watch_url=$2, link_sent=true, link_sent_at=NOW() WHERE id=$3`,
      [token, watchUrl, purchase.id]
    );

    // Send new email
    const emailResult = await resend.emails.send({
      from:    FROM_EMAIL,
      to:      purchase.buyer_email,
      subject: `Your new watch link — ${purchase.title}`,
      html:    buildWatchEmail(purchase.title, watchUrl, purchase.payhip_order_id, purchase.model_id),
    });
    console.log('[Resend Link] Sent to:', purchase.buyer_email, JSON.stringify(emailResult));

    res.json({ success: true, watch_url: watchUrl });
  } catch(e) {
    console.error('[Resend Link] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── SALES LOG endpoint (admin) ──
app.get('/api/admin/sales-log', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.payhip_order_id, p.buyer_email, p.buyer_ip,
              p.amount, p.link_sent, p.flagged, p.created_at, p.watch_url,
              v.title AS video_title
       FROM purchases p
       LEFT JOIN videos v ON v.id = p.video_id
       ORDER BY p.created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// VERIFY — Fan claims link (auto, no user input)
// Called by verify.html with order_id from Payhip redirect URL
// ═══════════════════════════════════════════════════════════

app.post('/api/verify', async (req, res) => {
  const orderId = (req.body.order_id || '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order ID is required.' });

  try {
    const { rows } = await pool.query(
      `SELECT p.*, v.id AS vid, v.title, v.mux_full_id, v.mux_preview_id
       FROM purchases p
       LEFT JOIN videos v ON v.id = p.video_id
       WHERE p.payhip_order_id = $1`, [orderId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Order not found. Your payment may still be processing — please wait 30 seconds and try again.' });
    }

    const purchase = rows[0];

    // Already delivered — permanent lock
    if (purchase.link_sent) {
      return res.status(409).json({ error: 'already_sent' });
    }

    if (!purchase.vid) {
      return res.status(500).json({ error: 'Video not found for this purchase. Please open a support ticket.' });
    }

    // Create watch token
    const token   = makeToken();
    const watchUrl = `${await getSiteUrl(purchase.model_id || 'amaretto')}/watch?t=${token}`;
    const email   = purchase.buyer_email;
    const muxId   = purchase.mux_full_id || purchase.mux_preview_id;

    await pool.query(
      `INSERT INTO video_tokens
         (token, purchase_id, video_id, video_title, mux_playback_id, buyer_email, allowed_ips)
       VALUES ($1,$2,$3,$4,$5,$6,'[]')`,
      [token, purchase.id, purchase.vid, purchase.title, muxId, email]
    );

    // Send ONCE via Resend
    console.log(`[Verify] Sending email to ${email} via Resend...`);
    console.log(`[Verify] FROM_EMAIL: ${FROM_EMAIL}`);
    console.log(`[Verify] RESEND_API_KEY set: ${!!process.env.RESEND_API_KEY}`);
    const emailResult = await resend.emails.send({
      from:    FROM_EMAIL,
      to:      email,
      subject: `Your video is ready — ${purchase.title}`,
      html:    buildWatchEmail(purchase.title, watchUrl, orderId),
    });
    console.log(`[Verify] Resend result:`, JSON.stringify(emailResult));

    // Lock forever
    await pool.query(
      `UPDATE purchases
       SET link_sent=true, link_sent_at=NOW(), watch_token=$1, watch_url=$2
       WHERE id=$3`,
      [token, watchUrl, purchase.id]
    );

    console.log(`[Verify] Link sent: ${email} → ${orderId}`);
    res.json({ success: true, email });

  } catch (e) {
    console.error('[Verify] Error:', e.message);
    res.status(500).json({ error: 'Failed to send your link. Please try again or open a support ticket.' });
  }
});

// ═══════════════════════════════════════════════════════════
// WATCH — Validate token + return Mux playback ID
// ═══════════════════════════════════════════════════════════

app.get('/api/watch/:token', async (req, res) => {
  const ip    = getIP(req);
  const token = req.params.token;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM video_tokens WHERE token = $1', [token]
    );

    if (!rows.length)      return res.status(404).json({ error: 'invalid' });
    const row = rows[0];
    if (!row.is_active)    return res.status(403).json({ error: 'revoked' });

    const allowedIPs = row.allowed_ips || [];

    if (allowedIPs.includes(ip)) {
      await pool.query(
        'UPDATE video_tokens SET view_count=view_count+1, last_viewed=NOW() WHERE token=$1', [token]
      );
      return res.json({ playback_id: row.mux_playback_id, title: row.video_title });
    }

    if (allowedIPs.length < MAX_IPS) {
      const newIPs = [...allowedIPs, ip];
      await pool.query(
        'UPDATE video_tokens SET allowed_ips=$1, view_count=view_count+1, last_viewed=NOW() WHERE token=$2',
        [JSON.stringify(newIPs), token]
      );
      return res.json({ playback_id: row.mux_playback_id, title: row.video_title });
    }

    return res.status(403).json({ error: 'ip_limit', support: true });

  } catch (e) {
    console.error('[Watch] Error:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ═══════════════════════════════════════════════════════════
// SUPPORT TICKETS
// Gate: email only (purchase must have link_sent=true)
// ═══════════════════════════════════════════════════════════

async function getPurchaseByEmail(email, orderId = null) {
  let q = `SELECT id, buyer_email, video_id, link_sent
           FROM purchases
           WHERE buyer_email = $1 AND link_sent = true`;
  const params = [email.toLowerCase().trim()];
  if (orderId) { q += ' AND payhip_order_id = $2'; params.push(orderId); }
  q += ' ORDER BY created_at DESC';
  const { rows } = await pool.query(q, params);
  return rows;
}

app.post('/api/support/ticket', async (req, res) => {
  const email   = (req.body?.email || '').toLowerCase().trim();
  const orderId = req.body?.order_id || null;
  const { subject, body } = req.body;

  if (!email || !subject?.trim() || !body?.trim())
    return res.status(400).json({ error: 'Email, subject and message are required.' });

  try {
    const purchases = await getPurchaseByEmail(email, orderId);
    if (!purchases.length) return res.status(403).json({ error: 'No verified purchase found.' });
    const purchase = purchases[0];

    const { rows: [ticket] } = await pool.query(
      `INSERT INTO support_tickets (purchase_id, buyer_email, video_id, subject)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [purchase.id, email, purchase.video_id, subject.trim()]
    );

    await pool.query(
      'INSERT INTO ticket_messages (ticket_id, sender, body) VALUES ($1,$2,$3)',
      [ticket.id, 'customer', body.trim()]
    );

    await resend.emails.send({
      from: FROM_EMAIL, to: process.env.ADMIN_EMAIL,
      subject: `[Support] New ticket from ${email} — ${subject}`,
      html: `<p><b>From:</b> ${email}<br><b>Subject:</b> ${subject}</p><hr><p>${body}</p>`,
    }).catch(() => {});

    res.status(201).json({ ticket_id: ticket.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/support/tickets', async (req, res) => {
  const email   = (req.query?.email || '').toLowerCase().trim();
  const orderId = req.query?.order_id || null;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  try {
    const purchases = await getPurchaseByEmail(email, orderId);
    if (!purchases.length) return res.status(403).json({ error: 'No verified purchase found.' });

    const ids = purchases.map(p => p.id);
    const { rows } = await pool.query(
      `SELECT id, subject, status, priority, created_at, updated_at
       FROM support_tickets
       WHERE purchase_id = ANY($1)
       ORDER BY updated_at DESC`, [ids]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/support/ticket/:id', async (req, res) => {
  const email   = (req.query?.email || '').toLowerCase().trim();
  const orderId = req.query?.order_id || null;

  try {
    const purchases = await getPurchaseByEmail(email, orderId);
    if (!purchases.length) return res.status(403).json({ error: 'Unauthorized' });

    const ids = purchases.map(p => p.id);
    const { rows: [ticket] } = await pool.query(
      'SELECT * FROM support_tickets WHERE id=$1 AND purchase_id = ANY($2)',
      [req.params.id, ids]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const { rows: messages } = await pool.query(
      'SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC',
      [ticket.id]
    );
    res.json({ ...ticket, ticket_messages: messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/support/ticket/:id/reply', async (req, res) => {
  const email   = (req.body?.email || '').toLowerCase().trim();
  const orderId = req.body?.order_id || null;
  const body    = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message required.' });

  try {
    const purchases = await getPurchaseByEmail(email, orderId);
    if (!purchases.length) return res.status(403).json({ error: 'Unauthorized' });

    const ids = purchases.map(p => p.id);
    const { rows: [ticket] } = await pool.query(
      'SELECT * FROM support_tickets WHERE id=$1 AND purchase_id = ANY($2)',
      [req.params.id, ids]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (ticket.status === 'closed') return res.status(400).json({ error: 'Ticket is closed.' });

    await pool.query(
      'INSERT INTO ticket_messages (ticket_id, sender, body) VALUES ($1,$2,$3)',
      [ticket.id, 'customer', body]
    );
    if (ticket.status === 'resolved') {
      await pool.query('UPDATE support_tickets SET status=$1 WHERE id=$2', ['open', ticket.id]);
    }

    await resend.emails.send({
      from: FROM_EMAIL, to: process.env.ADMIN_EMAIL,
      subject: `[Support] Reply from ${email} on: ${ticket.subject}`,
      html: `<p><b>From:</b> ${email}</p><hr><p>${body}</p>`,
    }).catch(() => {});

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ADMIN — Cover photo upload → Supabase Storage
// ═══════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════
// ADMIN — Delete cover photo from storage
// ═══════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════
// ADMIN — Videos CRUD
// ═══════════════════════════════════════════════════════════

app.get('/api/admin/videos', adminAuth, async (req, res) => {
  try {
    const model = req.query.model || null;
    const { rows } = await pool.query(
      model
        ? 'SELECT * FROM videos WHERE model_id = $1 ORDER BY created_at DESC'
        : 'SELECT * FROM videos ORDER BY created_at DESC',
      model ? [model] : []
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/videos', adminAuth, async (req, res) => {
  const { title, description, price, duration, preview_type,
          mux_preview_embed, mux_full_embed, payhip_url, active,
          payment_method, stars_price } = req.body;

  // payhip_url only required when payment method is payhip or both
  const pm = payment_method || 'payhip';
  if (!title || !mux_full_embed)
    return res.status(400).json({ error: 'title and mux_full_embed are required' });
  if ((pm === 'payhip' || pm === 'both') && !payhip_url)
    return res.status(400).json({ error: 'payhip_url required for Payhip payment method' });

  const fullId    = extractMuxId(mux_full_embed);
  const previewId = mux_preview_embed ? extractMuxId(mux_preview_embed) : null;

  if (!fullId)
    return res.status(400).json({ error: 'Could not extract Mux ID from full video embed code.' });

  const prodId = extractPayhipId(payhip_url);
  console.log('[Videos POST] payhip_url:', payhip_url, '→ prodId:', prodId);

  try {
    const { title: _t, model_id } = req.body;
  const modelId = model_id || 'amaretto';

  const { rows: [video] } = await pool.query(
      `INSERT INTO videos
         (title, description, price, duration, preview_type,
          mux_preview_id, mux_full_id, payhip_url, payhip_product_id, active, model_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [title, description || null, parseFloat(price) || 0, duration || null,
       preview_type || 'gif', previewId || null, fullId, payhip_url, prodId,
       active !== false, modelId]
    );
    res.status(201).json(video);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/videos/:id', adminAuth, async (req, res) => {
  const { title, description, price, duration, preview_type,
          mux_preview_embed, mux_full_embed, payhip_url, active,
          payment_method, stars_price } = req.body;

  const fullId    = mux_full_embed    ? extractMuxId(mux_full_embed)    : undefined;
  const previewId = mux_preview_embed ? extractMuxId(mux_preview_embed) : undefined;
  const productId = payhip_url ? extractPayhipId(payhip_url) : undefined;

  console.log('[Videos PUT] payhip_url:', payhip_url, '→ productId:', productId);

  const fields = [];
  const vals   = [];
  let i = 1;
  const set = (col, val) => { if (val !== undefined) { fields.push(col + '=$' + i++); vals.push(val); } };

  set('title',             title);
  set('description',       description);
  set('price',             price !== undefined ? parseFloat(price) : undefined);
  set('duration',          duration);
  set('preview_type',      preview_type);
  set('mux_preview_id',    previewId);
  set('mux_full_id',       fullId);
  set('payhip_url',        payhip_url);
  set('payhip_product_id', productId);
  set('payment_method',    payment_method);
  set('active',            active);

  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  vals.push(req.params.id);
  try {
    const { rows: [video] } = await pool.query(
      `UPDATE videos SET ${fields.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    res.json(video);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/videos/:id', adminAuth, async (req, res) => {
  try {
    // Fetch cover URL before deleting so we can clean up storage
    const { rows } = await pool.query('SELECT cover_photo_url FROM videos WHERE id=$1', [req.params.id]);
    const coverUrl = rows[0]?.cover_photo_url || null;

    await pool.query('DELETE FROM videos WHERE id=$1', [req.params.id]);

    // Delete cover photo from Supabase Storage
    if (coverUrl) {
      const marker = '/object/public/videos/';
      const idx    = coverUrl.indexOf(marker);
      if (idx !== -1) {
        const filePath  = coverUrl.slice(idx + marker.length); // e.g. covers/filename.png
        const deleteUrl = `${process.env.SUPABASE_URL}/storage/v1/object/videos/${filePath}`;
        await fetch(deleteUrl, {
          method:  'DELETE',
          headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
        }).catch(() => {}); // non-fatal if storage delete fails
      }
    }

    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ADMIN — Tickets
// ═══════════════════════════════════════════════════════════

app.get('/api/admin/tickets', adminAuth, async (req, res) => {
  try {
    const status = req.query.status;
    let q = `SELECT t.*, v.title AS video_title,
               (SELECT COUNT(*) FROM ticket_messages WHERE ticket_id=t.id) AS message_count
             FROM support_tickets t
             LEFT JOIN videos v ON v.id = t.video_id`;
    const params = [];
    if (status) { q += ' WHERE t.status=$1'; params.push(status); }
    q += ' ORDER BY t.updated_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/ticket/:id', adminAuth, async (req, res) => {
  try {
    const { rows: [ticket] } = await pool.query(
      `SELECT t.*, v.title AS video_title, p.payhip_order_id, p.amount, p.link_sent_at
       FROM support_tickets t
       LEFT JOIN videos v ON v.id = t.video_id
       LEFT JOIN purchases p ON p.id = t.purchase_id
       WHERE t.id=$1`, [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const { rows: messages } = await pool.query(
      'SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC', [ticket.id]
    );
    res.json({ ...ticket, ticket_messages: messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ticket/:id/reply', adminAuth, async (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Body required' });

  try {
    const { rows: [ticket] } = await pool.query(
      'SELECT * FROM support_tickets WHERE id=$1', [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    await pool.query(
      'INSERT INTO ticket_messages (ticket_id, sender, body) VALUES ($1,$2,$3)',
      [ticket.id, 'admin', body]
    );

    if (ticket.status === 'open') {
      await pool.query('UPDATE support_tickets SET status=$1 WHERE id=$2', ['in_progress', ticket.id]);
    }

    await resend.emails.send({
      from: FROM_EMAIL, to: ticket.buyer_email,
      subject: `Re: ${ticket.subject}`,
      html: buildSupportReplyEmail(ticket.subject, body, ticket.id),
    }).catch(console.error);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/ticket/:id/status', adminAuth, async (req, res) => {
  const { status } = req.body;
  if (!['open','in_progress','resolved','closed'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });

  try {
    const update = status === 'resolved'
      ? 'UPDATE support_tickets SET status=$1, resolved_at=NOW() WHERE id=$2'
      : 'UPDATE support_tickets SET status=$1 WHERE id=$2';
    await pool.query(update, [status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ADMIN — Purchases audit log + token management
// ═══════════════════════════════════════════════════════════

app.get('/api/admin/purchases', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, v.title AS video_title
       FROM purchases p LEFT JOIN videos v ON v.id = p.video_id
       ORDER BY p.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/purchase/:id/flag', adminAuth, async (req, res) => {
  const { reason, notes } = req.body;
  try {
    await pool.query(
      'UPDATE purchases SET flagged=true, flag_reason=$1, admin_notes=$2 WHERE id=$3',
      [reason || '', notes || '', req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/token/reset-ip/:token', adminAuth, async (req, res) => {
  try {
    await pool.query("UPDATE video_tokens SET allowed_ips='[]' WHERE token=$1", [req.params.token]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/token/revoke/:token', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE video_tokens SET is_active=false WHERE token=$1', [req.params.token]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════

function buildWatchEmail(videoTitle, watchUrl, orderId, modelId) {
  const model = modelId || 'amaretto';
  const siteUrl = getSiteUrl(model);

  // Per-model branding
  const brands = {
    amaretto: {
      name:       'AMARETTO H.',
      sub:        'STORE',
      headerImg:  'https://timely-jelly-d669b7.netlify.app/hero-poster.jpg',
      imgPos:     'center 20%',
      accentColor:'#bc1b1b',
      btnGrad:    'linear-gradient(135deg,#4d0b0b,#bc1b1b 50%,#960000)',
      btnShadow:  'rgba(188,27,27,0.4)',
      darkBg:     '#080202',
      borderColor:'#2a0808',
      goldColor:  '#be9a6a',
      darkBorder: '#1a0404',
    },
    nyla: {
      name:       'NYLA GREEN',
      sub:        'STORE',
      headerImg:  'https://nylagreen.com/hero-poster.jpg',
      imgPos:     'center 25%',
      accentColor:'#2d5a27',
      btnGrad:    'linear-gradient(135deg,#1a4a1a,#3d7a3d 50%,#2d5a2d)',
      btnShadow:  'rgba(61,122,61,0.4)',
      darkBg:     '#060f06',
      borderColor:'#1a3a1a',
      goldColor:  '#8ab88a',
      darkBorder: '#0f220f',
    },
    sophia: {
      name:       'SOPHIA VEE',
      sub:        'STORE',
      headerImg:  '', // no hosted image yet
      imgPos:     'center 20%',
      accentColor:'#d4186c',
      btnGrad:    'linear-gradient(135deg,#4d0b35,#d4186c 50%,#a01055)',
      btnShadow:  'rgba(212,24,108,0.4)',
      darkBg:     '#080308',
      borderColor:'#2a0820',
      goldColor:  '#e8c96a',
      darkBorder: '#1e0818',
    },
    ellie: {
      name:       'ELLIE',
      sub:        'STORE',
      headerImg:  '',
      imgPos:     'center 20%',
      accentColor:'#C4547A',
      btnGrad:    'linear-gradient(135deg,#7A1040,#C4547A 50%,#A03560)',
      btnShadow:  'rgba(196,84,122,0.4)',
      darkBg:     '#1A0810',
      borderColor:'#3A1028',
      goldColor:  '#E87DA0',
      darkBorder: '#260D18',
    },
    amber: {
      name:       'AMBERDYME',
      sub:        'STORE',
      headerImg:  '', // no hosted image yet — use text header
      imgPos:     'center 35%',
      accentColor:'#C89000',
      btnGrad:    'linear-gradient(135deg,#8A5A00,#F5B700 50%,#C89000)',
      btnShadow:  'rgba(245,183,0,0.4)',
      darkBg:     '#0F0D00',
      borderColor:'#2A2600',
      goldColor:  '#F5B700',
      darkBorder: '#1A1600',
    },
  };

  const b = brands[model] || brands.amaretto;

  // Hero section — photo if available, text if not
  const heroSection = b.headerImg
    ? '<div style="width:100%;height:380px;' +
        'background:' +
          'linear-gradient(0deg,' + b.darkBg + ' 0%,rgba(0,0,0,0.85) 20%,rgba(0,0,0,0.4) 45%,transparent 70%),' +
          'linear-gradient(180deg,' + b.darkBg + ' 0%,rgba(0,0,0,0.7) 25%,transparent 55%),' +
          'linear-gradient(90deg,' + b.darkBg + ' 0%,rgba(0,0,0,0.8) 10%,transparent 35%),' +
          'linear-gradient(270deg,' + b.darkBg + ' 0%,rgba(0,0,0,0.8) 10%,transparent 35%),' +
          'url(' + b.headerImg + ');' +
        'background-size:cover;background-position:' + b.imgPos + ';background-repeat:no-repeat;">' +
        '<div style="height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;padding:0 28px 28px;">' +
          '<div style="font-family:Cinzel,Georgia,serif;font-size:1.6rem;font-weight:600;letter-spacing:0.22em;color:#fafafa;text-transform:uppercase;text-shadow:0 2px 12px rgba(0,0,0,0.9);margin-bottom:4px;">' + b.name + '</div>' +
          '<div style="font-family:Cinzel,Georgia,serif;font-size:0.7rem;letter-spacing:0.35em;color:' + b.goldColor + ';text-transform:uppercase;text-shadow:0 1px 6px rgba(0,0,0,0.9);">' + b.sub + '</div>' +
        '</div>' +
      '</div>'
    : '<div style="background:' + b.darkBg + ';padding:40px 28px;text-align:center;border-bottom:1px solid ' + b.borderColor + ';">' +
        '<div style="font-family:Cinzel,Georgia,serif;font-size:1.8rem;font-weight:600;letter-spacing:0.22em;color:#fafafa;text-transform:uppercase;margin-bottom:6px;">' + b.name + '</div>' +
        '<div style="font-family:Cinzel,Georgia,serif;font-size:0.7rem;letter-spacing:0.35em;color:' + b.goldColor + ';text-transform:uppercase;">' + b.sub + '</div>' +
      '</div>';

  return '<!DOCTYPE html>' +
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Montserrat:wght@300;400;600&display=swap" rel="stylesheet">' +
    '</head><body style="margin:0;padding:0;background:' + b.darkBg + ';font-family:Montserrat,Helvetica Neue,Helvetica,sans-serif;">' +
    '<div style="max-width:520px;margin:0 auto;background:' + b.darkBg + ';">' +

    heroSection +

    '<div style="padding:32px 28px 0;">' +
    '<div style="text-align:center;margin-bottom:28px;">' +
    '<div style="display:inline-block;padding:4px 20px;border:1px solid ' + b.borderColor + ';border-radius:20px;margin-bottom:16px;">' +
    '<span style="font-family:Montserrat,sans-serif;font-size:0.62rem;letter-spacing:0.25em;color:' + b.goldColor + ';text-transform:uppercase;">Your purchase is ready</span>' +
    '</div>' +
    '<h1 style="font-family:Cinzel,Georgia,serif;font-size:1.4rem;font-weight:400;letter-spacing:0.12em;color:#fafafa;text-transform:uppercase;margin:0 0 10px;">' + videoTitle + '</h1>' +
    '<p style="font-family:Montserrat,sans-serif;font-size:0.78rem;color:#a3a3a3;line-height:1.7;margin:0;">' +
    'Your private watch link is below.<br>' +
    '<span style="color:' + b.accentColor + ';font-weight:600;">This link is for your use only. Do not share it.</span>' +
    '</p></div>' +

    '<div style="text-align:center;margin-bottom:28px;">' +
    '<a href="' + watchUrl + '" style="display:inline-block;padding:16px 48px;background:' + b.btnGrad + ';border-radius:30px;color:#fafafa;font-family:Cinzel,Georgia,serif;font-size:0.8rem;letter-spacing:0.2em;text-transform:uppercase;text-decoration:none;box-shadow:0 6px 24px ' + b.btnShadow + ';">Watch Now</a>' +
    '</div>' +

    '<div style="background:' + b.darkBorder + ';border:1px solid ' + b.borderColor + ';border-radius:12px;padding:16px 20px;margin-bottom:16px;text-align:center;">' +
    '<p style="font-family:Montserrat,sans-serif;font-size:0.62rem;letter-spacing:0.15em;color:#525252;text-transform:uppercase;margin:0 0 8px;">Or copy this link</p>' +
    '<p style="font-family:Courier New,monospace;font-size:0.65rem;color:' + b.goldColor + ';word-break:break-all;margin:0;">' + watchUrl + '</p>' +
    '</div>' +

    '<div style="border:1px solid ' + b.borderColor + ';border-radius:10px;padding:16px 20px;margin-bottom:32px;">' +
    '<table style="width:100%;border-collapse:collapse;">' +
    '<tr><td style="font-family:Montserrat,sans-serif;font-size:0.65rem;color:#525252;letter-spacing:0.08em;text-transform:uppercase;padding:5px 0;">Order ID</td>' +
    '<td style="font-family:Montserrat,sans-serif;font-size:0.65rem;color:#a3a3a3;text-align:right;padding:5px 0;">' + orderId + '</td></tr>' +
    '<tr><td style="font-family:Montserrat,sans-serif;font-size:0.65rem;color:#525252;text-transform:uppercase;padding:5px 0;">Note</td>' +
    '<td style="font-family:Montserrat,sans-serif;font-size:0.65rem;color:#a3a3a3;text-align:right;padding:5px 0;">This email will not be resent</td></tr>' +
    '<tr><td style="font-family:Montserrat,sans-serif;font-size:0.65rem;color:#525252;text-transform:uppercase;padding:5px 0;">Support</td>' +
    '<td style="text-align:right;padding:5px 0;"><a href="' + siteUrl + '/support" style="font-family:Montserrat,sans-serif;font-size:0.65rem;color:' + b.goldColor + ';text-decoration:none;">' + siteUrl + '/support</a></td></tr>' +
    '</table></div></div>' +

    '<div style="border-top:1px solid ' + b.borderColor + ';padding:20px 28px;text-align:center;">' +
    '<p style="font-family:Cinzel,Georgia,serif;font-size:0.62rem;letter-spacing:0.2em;color:#2a2a2a;text-transform:uppercase;margin:0;">' +
    '&copy; 2024 ' + b.name + ' &nbsp;&middot;&nbsp; Private &amp; Discreet' +
    '</p></div></div></body></html>';
}


function buildSupportReplyEmail(subject, body, ticketId) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#080202;font-family:'Helvetica Neue',Helvetica,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <h1 style="font-size:1.1rem;letter-spacing:0.2em;color:#fafafa;text-align:center;text-transform:uppercase;">AMARETTO H.</h1>
    <div style="background:#100303;border:1px solid #2a0808;border-radius:16px;padding:28px;margin-top:20px;">
      <p style="font-size:0.68rem;letter-spacing:0.2em;color:#705426;text-transform:uppercase;margin:0 0 8px;">Support Reply</p>
      <p style="font-size:0.82rem;font-weight:bold;color:#fafafa;margin:0 0 16px;">${subject}</p>
      <p style="color:#cbcbcb;font-size:0.85rem;line-height:1.65;margin:0 0 20px;">${body.replace(/\n/g,'<br>')}</p>
      <a href="${SITE_URL}/support" style="display:inline-block;padding:11px 22px;background:linear-gradient(135deg,#4d0b0b,#bc1b1b);border-radius:22px;color:#fafafa;font-size:0.72rem;letter-spacing:0.12em;text-transform:uppercase;text-decoration:none;">View &amp; Reply</a>
    </div>
  </div></body></html>`;
}


// ── TELEGRAM STARS ──────────────────────────────────────────

// Model config cache — loaded from DB
let _modelCache = {};
let _modelCacheTs = 0;

async function getModels() {
  const now = Date.now();
  if (now - _modelCacheTs < 30000) return _modelCache; // 30s cache
  try {
    const { rows } = await pool.query('SELECT * FROM models WHERE active = true');
    const cache = {};
    rows.forEach(r => { cache[r.model_id] = r; });
    _modelCache = cache;
    _modelCacheTs = now;
    if (Object.keys(cache).length) console.log('[Models] Loaded from DB:', Object.keys(cache));
  } catch(e) {
    // Table may not exist yet — suppress repeated errors, use env vars
    if (!_modelCache._errLogged) {
      console.log('[Models] Table not ready yet, using env vars');
      _modelCache._errLogged = true;
    }
  }
  return _modelCache;
}

async function getModel(modelId) {
  const models = await getModels();
  return models[modelId] || null;
}

// Backward compat helpers
async function getBotToken(modelId) {
  try {
    const m = await getModel(modelId);
    if (m?.bot_token) return m.bot_token;
  } catch(e) { /* DB not ready */ }
  return process.env[`${modelId.toUpperCase()}_BOT_TOKEN`] || null;
}

function usdToStars(usd) {
  // 1 USD ≈ 50 Stars
  return Math.max(1, Math.ceil(parseFloat(usd) * 50));
}

// Generate Stars invoice link
app.get('/api/stars/invoice', async (req, res) => {
  const { video_id, email } = req.query;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });

  try {
    const { rows } = await pool.query(
      'SELECT id, title, description, price, model_id FROM videos WHERE id = $1 AND active = true',
      [video_id]
    );
    const video = rows[0];
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const botToken = await getBotToken(video.model_id);
    if (!botToken) return res.status(500).json({ error: 'Bot token not configured for: ' + video.model_id });

    const stars = usdToStars(video.price);
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title:          video.title.substring(0, 32),
        description:    (video.description || 'Exclusive private video').substring(0, 255),
        payload:        JSON.stringify({ video_id: video.id, model_id: video.model_id, email }),
        provider_token: '',
        currency:       'XTR',
        prices:         [{ label: 'Purchase', amount: stars }],
      }),
    });
    const data = await tgRes.json();
    console.log('[Stars] createInvoiceLink:', JSON.stringify(data));
    if (!data.ok) return res.status(500).json({ error: data.description || 'Telegram error' });
    res.json({ invoice_url: data.result, stars, video_id: video.id });
  } catch (e) {
    console.error('[Stars] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Telegram webhook — handles Stars payment confirmation
// Test endpoint - shows bot info + webhook status
app.get('/webhook/telegram/:model/test', async (req, res) => {
  const model = req.params.model;
  const token = MODEL_BOTS[model];
  if (!token) return res.json({ model, bot_token_set: false });
  try {
    const [meRes, whRes] = await Promise.all([
      fetch(`https://api.telegram.org/bot${token}/getMe`),
      fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`),
    ]);
    const me = await meRes.json();
    const wh = await whRes.json();
    res.json({
      model,
      bot_token_set: true,
      token_first8: token.substring(0, 8),
      bot_username: me.result?.username || 'unknown',
      bot_id: me.result?.id || 'unknown',
      webhook_url: wh.result?.url || '(empty)',
      pending_updates: wh.result?.pending_update_count || 0,
      last_error: wh.result?.last_error_message || 'none',
    });
  } catch(e) {
    res.json({ model, error: e.message });
  }
});

// Telegram sends GET test when registering webhook — must return 200
app.get('/webhook/telegram/:model', (req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/webhook/telegram/:model', (req, res, next) => {
  express.json()(req, res, function(err) {
    if (err) { res.status(200).json({ ok: true }); return; }
    next();
  });
}, async (req, res) => {
  const model  = req.params.model;
  const update = req.body;
  // Log EVERYTHING that comes in
  console.log('[TG Webhook] ===== INCOMING =====');
  console.log('[TG Webhook] model:', model);
  console.log('[TG Webhook] update_id:', update.update_id);
  console.log('[TG Webhook] keys:', Object.keys(update));
  console.log('[TG Webhook] full:', JSON.stringify(update));
  console.log('[TG Webhook] ===================');

  // Must answer pre_checkout_query within 10s
  if (update.pre_checkout_query) {
    const botToken = await getBotToken(model);
    console.log('[TG] pre_checkout_query received, answering...');
    console.log('[TG] botToken set:', !!botToken);
    const pResp = await fetch(`https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true }),
    });
    const pData = await pResp.json();
    console.log('[TG] answerPreCheckoutQuery result:', JSON.stringify(pData));
    return res.json({ ok: true });
  }

  // Successful payment
  if (update.message?.successful_payment) {
    console.log('[TG] ✅ SUCCESSFUL PAYMENT received!');
    const payment  = update.message.successful_payment;
    const chatId   = update.message.chat.id;
    const tgUserId = update.message.from.id;
    const botToken = await getBotToken(model);
    console.log('[TG] payment details:', JSON.stringify(payment));
    console.log('[TG] chatId:', chatId, 'userId:', tgUserId);
    console.log('[TG] botToken set:', !!botToken);

    let payload;
    try { payload = JSON.parse(payment.invoice_payload); } catch(e) { return res.json({ ok: true }); }
    const { video_id, model_id } = payload;

    try {
      const { rows: vids } = await pool.query(
        'SELECT id, title, mux_full_id FROM videos WHERE id = $1',
        [video_id]
      );
      const video = vids[0];
      if (!video) throw new Error('Video not found');

      const token    = makeToken();
      const siteBase = (await getSiteUrl(model_id)).replace(/\/+$/, '');
      const watchUrl  = `${siteBase}/watch?t=${token}`;
      const orderId  = `TG-${tgUserId}-${Date.now()}`;

      const { rows: [purchase] } = await pool.query(
        `INSERT INTO purchases (payhip_order_id, buyer_email, video_id, payhip_product_id, amount, link_sent)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [orderId, `tg:${tgUserId}`, video.id, null, payment.total_amount / 50]
      );

      await pool.query(
        `INSERT INTO video_tokens (token, purchase_id, video_id, video_title, mux_playback_id, buyer_email, allowed_ips)
         VALUES ($1,$2,$3,$4,$5,$6,'[]')`,
        [token, purchase.id, video.id, video.title, video.mux_full_id, `tg:${tgUserId}`]
      );

      const buyerEmail = payload.email || null;
      console.log('[TG] buyer email:', buyerEmail);
      console.log('[TG] watch URL:', watchUrl);

      // ── Send email via Resend ──
      if (buyerEmail) {
        try {
          const emailResult = await resend.emails.send({
            from:    FROM_EMAIL,
            to:      buyerEmail,
            subject: `Your video is ready — ${video.title}`,
            html:    buildWatchEmail(video.title, watchUrl, orderId, model_id),
          });
          console.log('[TG] ✅ Email sent:', JSON.stringify(emailResult));
        } catch(emailErr) {
          console.error('[TG] ❌ Email failed:', emailErr.message);
        }
      } else {
        console.warn('[TG] ⚠️ No email in payload');
      }

      // ── Also confirm in Telegram ──
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id:    chatId,
            parse_mode: 'Markdown',
            text: `✅ *Payment received!*

🎬 *${video.title}*

Your watch link has been sent to *${buyerEmail || 'your email'}*.

Check your inbox! 📧`,
          }),
        });
      } catch(tgErr) {
        console.log('[TG] Could not send TG confirmation:', tgErr.message);
      }

      console.log(`[Stars] ✅ Done — watch link: ${watchUrl}`);
    } catch (e) {
      console.error('[Stars] Delivery error:', e.message);
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: '❌ Payment received but delivery failed. Please contact support.' }),
        });
      } catch(e) { console.log('[Stars] Could not send error msg:', e.message); }
    }
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

// Register Telegram webhook (call once per model after deploy)
// Also support GET so it can be called from browser: /api/stars/register-webhook?model=amber&key=xxx
app.get('/api/stars/register-webhook', async (req, res) => {
  const { model, key } = req.query;
  if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const botToken = await getBotToken(model);
  if (!botToken) return res.status(400).json({ error: 'No token for model: ' + model });
  
  // Show bot info first
  const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const meData = await meRes.json();
  
  const webhookUrl = `https://amarettoh-production.up.railway.app/webhook/telegram/${model}`;
  const setRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'pre_checkout_query'] }),
  });
  const setData = await setRes.json();
  
  // Wait briefly then verify
  await new Promise(r => setTimeout(r, 1500));
  const verifyRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  const verifyData = await verifyRes.json();
  
  res.json({
    bot: meData.result?.username,
    bot_id: meData.result?.id,
    token_first8: botToken.substring(0,8),
    webhook_url: webhookUrl,
    set_result: setData,
    verified_url: verifyData.result?.url,
    webhook_active: verifyData.result?.url === webhookUrl,
  });
});

app.post('/api/stars/register-webhook', adminAuth, async (req, res) => {
  const { model } = req.body;
  const botToken  = MODEL_BOTS[model];
  if (!botToken) return res.status(400).json({ error: 'No token for model: ' + model });
  const webhookUrl = `https://amarettoh-production.up.railway.app/webhook/telegram/${model}`;
  const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'pre_checkout_query'] }),
  });
  const data = await tgRes.json();
  res.json({ webhook_url: webhookUrl, result: data });
});


// ── MODELS API ───────────────────────────────────────────────

// GET all models
app.get('/api/admin/models', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM models ORDER BY created_at ASC');
    // Never expose full bot tokens in list
    const safe = rows.map(r => ({ ...r, bot_token: r.bot_token ? '••••' + r.bot_token.slice(-4) : null, _has_token: !!r.bot_token }));
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET single model (with full token for internal use)
app.get('/api/admin/models/:modelId', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM models WHERE model_id = $1', [req.params.modelId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const m = { ...rows[0], bot_token: rows[0].bot_token ? '••••' + rows[0].bot_token.slice(-4) : null };
    res.json(m);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create model
app.post('/api/admin/models', adminAuth, async (req, res) => {
  const { model_id, name, site_url, bot_token, of_url, telegram_channel, theme_color, admin_password, active } = req.body;
  if (!model_id || !name) return res.status(400).json({ error: 'model_id and name required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO models (model_id, name, site_url, bot_token, of_url, telegram_channel, theme_color, admin_password, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, model_id, name`,
      [model_id, name, site_url||null, bot_token||null, of_url||null, telegram_channel||null,
       theme_color||'#C8960A', admin_password||'admin2024', active !== false]
    );
    _modelCacheTs = 0; // Bust cache
    res.json({ ok: true, model: rows[0] });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Model ID already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT update model
app.put('/api/admin/models/:id', adminAuth, async (req, res) => {
  const { name, site_url, bot_token, of_url, telegram_channel, theme_color, admin_password, active } = req.body;
  try {
    // Only update bot_token if a real value is provided (not masked)
    const existing = await pool.query('SELECT bot_token FROM models WHERE id = $1', [req.params.id]);
    const finalToken = (bot_token && !bot_token.startsWith('••••')) ? bot_token : existing.rows[0]?.bot_token;

    await pool.query(
      `UPDATE models SET name=$1, site_url=$2, bot_token=$3, of_url=$4, telegram_channel=$5,
       theme_color=$6, admin_password=$7, active=$8 WHERE id=$9`,
      [name, site_url||null, finalToken||null, of_url||null, telegram_channel||null,
       theme_color||'#C8960A', admin_password||'admin2024', active !== false, req.params.id]
    );
    _modelCacheTs = 0; // Bust cache
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE model
app.delete('/api/admin/models/:modelId', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM models WHERE model_id = $1', [req.params.modelId]);
    _modelCacheTs = 0;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET stats across all models
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [v, p, r] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM videos'),
      pool.query('SELECT COUNT(*) FROM purchases'),
      pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM purchases'),
    ]);
    res.json({
      total_videos:    parseInt(v.rows[0].count),
      total_purchases: parseInt(p.rows[0].count),
      total_revenue:   parseFloat(r.rows[0].total),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET all purchases across models
app.get('/api/admin/purchases', adminAuth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  try {
    const { rows } = await pool.query(
      `SELECT p.*, v.title as video_title, v.model_id
       FROM purchases p LEFT JOIN videos v ON v.id = p.video_id
       ORDER BY p.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, db: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
