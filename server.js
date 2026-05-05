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

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({
  origin: [SITE_URL, 'http://localhost:3000', 'http://127.0.0.1:5500'],
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
    const { rows } = await pool.query(
      `SELECT id, title, description, price, duration,
              cover_photo_url, mux_preview_id, payhip_url
       FROM videos
       WHERE active = true
       ORDER BY created_at DESC`
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
  const sig      = req.headers['x-payhip-signature'] || '';
  const expected = crypto
    .createHmac('sha256', process.env.PAYHIP_WEBHOOK_SECRET)
    .update(req.body).digest('hex');

  if (sig !== expected) {
    console.warn('[Webhook] Bad signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body.toString());
  if (event.event !== 'payment:completed') return res.json({ received: true });

  const { buyer_email, order_id, product_link, amount } = event.data;
  const productId = (product_link || '').split('/b/').pop().split('/')[0];

  try {
    // Find matching video
    const { rows: vids } = await pool.query(
      'SELECT id, title FROM videos WHERE payhip_product_id = $1', [productId]
    );
    const video = vids[0] || null;

    await pool.query(
      `INSERT INTO purchases
         (payhip_order_id, buyer_email, video_id, payhip_product_id, amount, payhip_payload)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (payhip_order_id) DO NOTHING`,
      [order_id, buyer_email.toLowerCase().trim(), video?.id || null,
       productId, parseFloat(amount) || null, JSON.stringify(event.data)]
    );

    console.log(`[Webhook] Purchase stored: ${buyer_email} → ${video?.title || productId}`);
    res.json({ received: true });
  } catch (e) {
    console.error('[Webhook] Error:', e.message);
    res.json({ received: true }); // always 200
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
    const watchUrl = `${SITE_URL}/watch?t=${token}`;
    const email   = purchase.buyer_email;
    const muxId   = purchase.mux_full_id || purchase.mux_preview_id;

    await pool.query(
      `INSERT INTO video_tokens
         (token, purchase_id, video_id, video_title, mux_playback_id, buyer_email, allowed_ips)
       VALUES ($1,$2,$3,$4,$5,$6,'[]')`,
      [token, purchase.id, purchase.vid, purchase.title, muxId, email]
    );

    // Send ONCE via Resend
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      email,
      subject: `Your video is ready — ${purchase.title}`,
      html:    buildWatchEmail(purchase.title, watchUrl, orderId),
    });

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

app.post('/api/admin/upload-cover', adminAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const ext      = req.file.mimetype.split('/')[1].replace('jpeg','jpg');
  const filename = `covers/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const storageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/videos/${filename}`;

  try {
    const uploadRes = await fetch(storageUrl, {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type':   req.file.mimetype,
        'Cache-Control':  '3600',
      },
      body: req.file.buffer,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      return res.status(500).json({ error: `Storage upload failed: ${err}` });
    }

    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/videos/${filename}`;
    res.json({ url: publicUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ADMIN — Videos CRUD
// ═══════════════════════════════════════════════════════════

app.get('/api/admin/videos', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM videos ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/videos', adminAuth, async (req, res) => {
  const { title, description, price, duration, cover_photo_url,
          mux_preview_embed, mux_full_embed, payhip_url, active } = req.body;

  if (!title || !mux_preview_embed || !payhip_url)
    return res.status(400).json({ error: 'title, mux_preview_embed and payhip_url required' });

  const previewId = extractMuxId(mux_preview_embed);
  const fullId    = mux_full_embed ? extractMuxId(mux_full_embed) : null;

  if (!previewId)
    return res.status(400).json({ error: 'Could not extract Mux ID from preview embed code.' });

  const productId = payhip_url.split('/b/').pop().split('/')[0] || null;

  try {
    const { rows: [video] } = await pool.query(
      `INSERT INTO videos
         (title, description, price, duration, cover_photo_url,
          mux_preview_id, mux_full_id, payhip_url, payhip_product_id, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [title, description || null, parseFloat(price) || 0, duration || null,
       cover_photo_url || null, previewId, fullId, payhip_url, productId,
       active !== false]
    );
    res.status(201).json(video);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/videos/:id', adminAuth, async (req, res) => {
  const { title, description, price, duration, cover_photo_url,
          mux_preview_embed, mux_full_embed, payhip_url, active } = req.body;

  const previewId = mux_preview_embed ? extractMuxId(mux_preview_embed) : undefined;
  const fullId    = mux_full_embed    ? extractMuxId(mux_full_embed)    : undefined;
  const productId = payhip_url ? payhip_url.split('/b/').pop().split('/')[0] : undefined;

  const fields = [];
  const vals   = [];
  let i = 1;

  const set = (col, val) => { if (val !== undefined) { fields.push(`${col}=$${i++}`); vals.push(val); } };

  set('title',             title);
  set('description',       description);
  set('price',             price !== undefined ? parseFloat(price) : undefined);
  set('duration',          duration);
  set('cover_photo_url',   cover_photo_url);
  set('mux_preview_id',    previewId);
  set('mux_full_id',       fullId);
  set('payhip_url',        payhip_url);
  set('payhip_product_id', productId);
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
    await pool.query('DELETE FROM videos WHERE id=$1', [req.params.id]);
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

function buildWatchEmail(videoTitle, watchUrl, orderId) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#080202;font-family:'Helvetica Neue',Helvetica,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="font-size:1.4rem;letter-spacing:0.2em;color:#fafafa;text-transform:uppercase;margin:0;">AMARETTO H.</h1>
      <p style="font-size:0.65rem;letter-spacing:0.3em;color:#705426;text-transform:uppercase;margin:6px 0 0;">Exclusive Content</p>
    </div>
    <div style="background:#100303;border:1px solid #2a0808;border-radius:16px;padding:32px 28px;text-align:center;">
      <p style="font-size:0.72rem;letter-spacing:0.2em;color:#705426;text-transform:uppercase;margin:0 0 14px;">Your purchase is ready</p>
      <h2 style="font-size:1.3rem;color:#fafafa;margin:0 0 8px;">${videoTitle}</h2>
      <p style="font-size:0.8rem;color:#a3a3a3;line-height:1.65;margin:0 0 28px;">Your private watch link is below. This link is for your use only.<br><strong style="color:#bc1b1b;">Do not share it.</strong></p>
      <a href="${watchUrl}" style="display:inline-block;padding:16px 36px;background:linear-gradient(135deg,#4d0b0b,#bc1b1b);border-radius:30px;color:#fafafa;font-size:0.82rem;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;">Watch Now</a>
      <p style="font-size:0.7rem;color:#525252;margin:20px 0 0;">Or copy: <span style="color:#705426;word-break:break-all;">${watchUrl}</span></p>
    </div>
    <div style="margin-top:16px;padding:16px 20px;background:#0d0202;border:1px solid #1a0404;border-radius:10px;">
      <p style="font-size:0.68rem;color:#525252;margin:0;line-height:1.7;">
        <strong style="color:#a3a3a3;">Order ID:</strong> ${orderId}<br>
        <strong style="color:#a3a3a3;">Important:</strong> This email will not be resent.<br>
        Need help? Visit <a href="${SITE_URL}/support" style="color:#705426;">${SITE_URL}/support</a>
      </p>
    </div>
  </div></body></html>`;
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
