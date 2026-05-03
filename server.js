/**
 * Amaretto H. — Video Store Backend v2
 * Railway + Supabase + Mux + Payhip + Resend
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const Mux      = require('@mux/mux-node');

const app = express();

// ── CLIENTS ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const muxClient = new Mux({
  tokenId:     process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const SITE_URL    = process.env.SITE_URL || 'https://amarettoh.com';
const FROM_EMAIL  = process.env.FROM_EMAIL || 'noreply@amarettoh.com';
const MAX_IPS     = 3;

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({
  origin: [SITE_URL, 'http://localhost:3000', 'http://127.0.0.1:5500'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
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
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ═══════════════════════════════════════════════════════════
// PUBLIC — Videos
// ═══════════════════════════════════════════════════════════

app.get('/api/videos', async (req, res) => {
  const { data, error } = await supabase
    .from('videos')
    .select('id, title, description, price, duration, mux_preview_id, payhip_url')
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ═══════════════════════════════════════════════════════════
// PAYHIP WEBHOOK
// ═══════════════════════════════════════════════════════════

app.post('/webhook/payhip', async (req, res) => {
  // Verify signature
  const sig      = req.headers['x-payhip-signature'] || '';
  const expected = crypto
    .createHmac('sha256', process.env.PAYHIP_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  if (sig !== expected) {
    console.warn('[Webhook] Invalid Payhip signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body.toString());

  // Only process completed payments
  if (event.event !== 'payment:completed') {
    return res.json({ received: true });
  }

  const { buyer_email, order_id, product_link, amount } = event.data;

  // Extract product ID from URL (payhip.com/b/XXXXX → XXXXX)
  const productId = (product_link || '').split('/b/').pop().split('/')[0];

  // Find matching video
  const { data: video } = await supabase
    .from('videos')
    .select('id, title')
    .eq('payhip_product_id', productId)
    .single();

  // Store the purchase — link_sent stays false until fan claims it
  const { error } = await supabase.from('purchases').insert({
    payhip_order_id:   order_id,
    buyer_email:       buyer_email.toLowerCase().trim(),
    video_id:          video?.id || null,
    payhip_product_id: productId,
    amount:            parseFloat(amount) || null,
    payhip_payload:    event.data,
    link_sent:         false,
  });

  if (error && !error.message.includes('duplicate')) {
    console.error('[Webhook] Insert error:', error.message);
  }

  console.log(`[Webhook] Purchase stored: ${buyer_email} → ${video?.title || productId}`);

  // Always 200 to Payhip
  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════
// VERIFY — Fan claims their watch link
// POST /api/verify
// Body: { email, order_id }
// ═══════════════════════════════════════════════════════════

app.post('/api/verify', async (req, res) => {
  const orderId = (req.body.order_id || '').trim();

  if (!orderId) {
    return res.status(400).json({ error: 'Order ID is required.' });
  }

  // Find the purchase by order_id ONLY.
  // The email comes from the webhook record — the fan never types it.
  // This means even if someone knows an order ID, they can't redirect
  // the link anywhere — it always goes to the email Payhip recorded at payment.
  const { data: purchase, error } = await supabase
    .from('purchases')
    .select('*, videos(id, title, mux_full_id, mux_preview_id)')
    .eq('payhip_order_id', orderId)
    .single();

  // Not found — webhook hasn't arrived yet, or invalid order ID
  if (error || !purchase) {
    return res.status(404).json({
      error: 'Order not found. Your payment may still be processing — please wait 30 seconds and try again.'
    });
  }

  // ── ALREADY SENT — permanent lock ──────────────────────────
  if (purchase.link_sent) {
    return res.status(409).json({
      error: 'already_sent',
      message: 'Your watch link was already sent to your email when you first verified. We cannot resend it.',
      support: true,  // tells frontend to show support link
    });
  }

  // ── FIRST TIME CLAIM ───────────────────────────────────────
  const video = purchase.videos;
  if (!video) {
    return res.status(500).json({ error: 'Video not found for this purchase. Please open a support ticket.' });
  }

  try {
    // Create IP-tracked watch token
    const token = makeToken();
    const email = purchase.buyer_email; // from webhook, never from fan input

    await supabase.from('video_tokens').insert({
      token,
      purchase_id:     purchase.id,
      video_id:        video.id,
      video_title:     video.title,
      mux_playback_id: video.mux_full_id || video.mux_preview_id,
      buyer_email:     email,
      allowed_ips:     [],
      is_active:       true,
    });

    const watchUrl = `${SITE_URL}/watch?t=${token}`;

    // Send ONCE via Resend
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      email,
      subject: `Your video is ready — ${video.title}`,
      html:    buildWatchEmail(video.title, watchUrl, orderId),
    });

    // Lock the purchase — permanent, no exceptions
    await supabase.from('purchases').update({
      link_sent:    true,
      link_sent_at: new Date().toISOString(),
      watch_token:  token,
      watch_url:    watchUrl,
    }).eq('id', purchase.id);

    console.log(`[Verify] Link sent to ${purchase.buyer_email} for order ${orderId}`);

    // Return masked email so the frontend can show "sent to j***@gmail.com"
    res.json({
      success: true,
      message: 'Your watch link has been sent to your email.',
      email:   purchase.buyer_email,  // frontend masks this before display
    });

  } catch (err) {
    console.error('[Verify] Error:', err.message);
    res.status(500).json({ error: 'Failed to send your link. Please try again or open a support ticket.' });
  }
});

// ═══════════════════════════════════════════════════════════
// WATCH — Serve the video (IP-gated)
// GET /api/watch/:token
// ═══════════════════════════════════════════════════════════

app.get('/api/watch/:token', async (req, res) => {
  const ip = getIP(req);
  const { token } = req.params;

  const { data: row, error } = await supabase
    .from('video_tokens')
    .select('*')
    .eq('token', token)
    .single();

  if (error || !row) {
    return res.status(404).json({ error: 'invalid', message: 'This link is invalid.' });
  }

  if (!row.is_active) {
    return res.status(403).json({ error: 'revoked', message: 'This link has been deactivated.' });
  }

  const allowedIPs = row.allowed_ips || [];

  // Known IP — pass through
  if (allowedIPs.includes(ip)) {
    await supabase.from('video_tokens')
      .update({ view_count: row.view_count + 1, last_viewed: new Date().toISOString() })
      .eq('token', token);
    return res.json({ url: muxUrl(row.mux_playback_id), title: row.video_title });
  }

  // New IP under limit — allow and record
  if (allowedIPs.length < MAX_IPS) {
    const newIPs = [...allowedIPs, ip];
    await supabase.from('video_tokens')
      .update({
        allowed_ips: newIPs,
        view_count:  row.view_count + 1,
        last_viewed: new Date().toISOString(),
      })
      .eq('token', token);
    return res.json({ url: muxUrl(row.mux_playback_id), title: row.video_title });
  }

  // Over IP limit
  return res.status(403).json({
    error:   'ip_limit',
    message: 'This link has been opened from too many locations. Please open a support ticket.',
    support: true,
  });
});

function muxUrl(playbackId) {
  return `https://stream.mux.com/${playbackId}.m3u8`;
}

// ═══════════════════════════════════════════════════════════
// SUPPORT TICKETS
// All support routes require proof of purchase:
// email + order_id in body (same as /verify but doesn't issue link)
// ═══════════════════════════════════════════════════════════

// Middleware: verify purchase ownership for support routes
async function purchaseAuth(req, res, next) {
  const email   = (req.body?.email || req.query?.email || '').toLowerCase().trim();
  const orderId = (req.body?.order_id || req.query?.order_id || '').trim(); // optional

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  // Look up by email. If order_id is also provided, use it to find the
  // specific purchase (fan could have bought multiple videos).
  let query = supabase
    .from('purchases')
    .select('id, buyer_email, video_id, link_sent, videos(title)')
    .eq('buyer_email', email)
    .eq('link_sent', true); // must have already claimed — proves they're the real buyer

  if (orderId) query = query.eq('payhip_order_id', orderId);

  const { data: purchases } = await query.order('created_at', { ascending: false });

  if (!purchases || purchases.length === 0) {
    return res.status(403).json({ error: 'No verified purchase found for this email.' });
  }

  // Use the most recent verified purchase (or the specific one if order_id was given)
  req.purchase = purchases[0];
  req.allPurchases = purchases; // useful for ticket listing
  next();
}

// POST /api/support/ticket — create ticket
app.post('/api/support/ticket', purchaseAuth, async (req, res) => {
  const { subject, body } = req.body;
  if (!subject?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'Subject and message are required.' });
  }

  const { data: ticket, error } = await supabase
    .from('support_tickets')
    .insert({
      purchase_id: req.purchase.id,
      buyer_email: req.purchase.buyer_email,
      video_id:    req.purchase.video_id,
      subject:     subject.trim(),
      status:      'open',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // First message
  await supabase.from('ticket_messages').insert({
    ticket_id: ticket.id,
    sender:    'customer',
    body:      body.trim(),
  });

  // Notify admin via Resend
  await resend.emails.send({
    from:    FROM_EMAIL,
    to:      process.env.ADMIN_EMAIL,
    subject: `[Support] New ticket from ${req.purchase.buyer_email} — ${subject}`,
    html:    `<p><b>From:</b> ${req.purchase.buyer_email}<br><b>Video:</b> ${req.purchase.videos?.title || '—'}<br><b>Subject:</b> ${subject}</p><hr><p>${body}</p><p><a href="${SITE_URL}/dashboard-admin-tez">Open Admin Dashboard</a></p>`,
  }).catch(() => {});

  res.status(201).json({ ticket_id: ticket.id });
});

// GET /api/support/tickets — list fan's tickets
app.get('/api/support/tickets', purchaseAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('id, subject, status, priority, created_at, updated_at')
    .eq('purchase_id', req.purchase.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/support/ticket/:id — get thread
app.get('/api/support/ticket/:id', async (req, res) => {
  const email   = (req.query?.email || '').toLowerCase().trim();
  const orderId = (req.query?.order_id || '').trim();

  // Verify ownership
  const { data: purchase } = await supabase
    .from('purchases')
    .select('id')
    .eq('buyer_email', email)
    .eq('payhip_order_id', orderId)
    .single();

  if (!purchase) return res.status(403).json({ error: 'Unauthorized' });

  const { data: ticket } = await supabase
    .from('support_tickets')
    .select('*, ticket_messages(*)')
    .eq('id', req.params.id)
    .eq('purchase_id', purchase.id)
    .single();

  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  // Sort messages chronologically
  ticket.ticket_messages?.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  res.json(ticket);
});

// POST /api/support/ticket/:id/reply — fan replies
app.post('/api/support/ticket/:id/reply', async (req, res) => {
  const email   = (req.body?.email || '').toLowerCase().trim();
  const orderId = (req.body?.order_id || '').trim();
  const body    = (req.body?.body || '').trim();

  if (!body) return res.status(400).json({ error: 'Message body is required.' });

  const { data: purchase } = await supabase
    .from('purchases')
    .select('id, buyer_email')
    .eq('buyer_email', email)
    .eq('payhip_order_id', orderId)
    .single();

  if (!purchase) return res.status(403).json({ error: 'Unauthorized' });

  // Verify ticket belongs to this purchase
  const { data: ticket } = await supabase
    .from('support_tickets')
    .select('id, status, subject')
    .eq('id', req.params.id)
    .eq('purchase_id', purchase.id)
    .single();

  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.status === 'closed') return res.status(400).json({ error: 'This ticket is closed.' });

  await supabase.from('ticket_messages').insert({
    ticket_id: ticket.id,
    sender:    'customer',
    body,
  });

  // Reopen if resolved
  if (ticket.status === 'resolved') {
    await supabase.from('support_tickets').update({ status: 'open' }).eq('id', ticket.id);
  }

  // Notify admin
  await resend.emails.send({
    from:    FROM_EMAIL,
    to:      process.env.ADMIN_EMAIL,
    subject: `[Support] Reply from ${email} on: ${ticket.subject}`,
    html:    `<p><b>From:</b> ${email}</p><hr><p>${body}</p><p><a href="${SITE_URL}/dashboard-admin-tez">Open Admin Dashboard</a></p>`,
  }).catch(() => {});

  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// ADMIN — Tickets
// ═══════════════════════════════════════════════════════════

// GET /api/admin/tickets
app.get('/api/admin/tickets', adminAuth, async (req, res) => {
  const status = req.query.status; // optional filter
  let query = supabase
    .from('support_tickets')
    .select('*, videos(title), ticket_messages(id)')
    .order('updated_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Add message count
  res.json(data.map(t => ({ ...t, message_count: t.ticket_messages?.length || 0, ticket_messages: undefined })));
});

// GET /api/admin/ticket/:id — full thread
app.get('/api/admin/ticket/:id', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*, videos(title), purchases(payhip_order_id, amount, link_sent_at), ticket_messages(*)')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Not found' });
  data.ticket_messages?.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  res.json(data);
});

// POST /api/admin/ticket/:id/reply — admin replies
app.post('/api/admin/ticket/:id/reply', adminAuth, async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Body required' });

  const { data: ticket } = await supabase
    .from('support_tickets')
    .select('id, subject, buyer_email, status')
    .eq('id', req.params.id)
    .single();

  if (!ticket) return res.status(404).json({ error: 'Not found' });

  await supabase.from('ticket_messages').insert({
    ticket_id: ticket.id,
    sender:    'admin',
    body:      body.trim(),
  });

  // Update status to in_progress if still open
  if (ticket.status === 'open') {
    await supabase.from('support_tickets').update({ status: 'in_progress' }).eq('id', ticket.id);
  }

  // Email the fan
  await resend.emails.send({
    from:    FROM_EMAIL,
    to:      ticket.buyer_email,
    subject: `Re: ${ticket.subject}`,
    html:    buildSupportReplyEmail(ticket.subject, body.trim(), ticket.id),
  }).catch(console.error);

  res.json({ success: true });
});

// PUT /api/admin/ticket/:id/status — update status
app.put('/api/admin/ticket/:id/status', adminAuth, async (req, res) => {
  const { status } = req.body;
  const valid = ['open', 'in_progress', 'resolved', 'closed'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const update = { status };
  if (status === 'resolved') update.resolved_at = new Date().toISOString();

  const { error } = await supabase.from('support_tickets').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/admin/purchases — purchase audit log
app.get('/api/admin/purchases', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('purchases')
    .select('*, videos(title)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/admin/purchase/:id/flag
app.post('/api/admin/purchase/:id/flag', adminAuth, async (req, res) => {
  const { reason, notes } = req.body;
  await supabase.from('purchases').update({
    flagged:     true,
    flag_reason: reason || '',
    admin_notes: notes || '',
  }).eq('id', req.params.id);
  res.json({ success: true });
});

// POST /api/admin/token/reset-ip/:token — reset IPs on watch token
app.post('/api/admin/token/reset-ip/:token', adminAuth, async (req, res) => {
  await supabase.from('video_tokens').update({ allowed_ips: [] }).eq('token', req.params.token);
  res.json({ success: true });
});

// POST /api/admin/token/revoke/:token
app.post('/api/admin/token/revoke/:token', adminAuth, async (req, res) => {
  await supabase.from('video_tokens').update({ is_active: false }).eq('token', req.params.token);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// ADMIN — Videos (CRUD)
// ═══════════════════════════════════════════════════════════

app.get('/api/admin/videos', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('videos').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/admin/videos', adminAuth, async (req, res) => {
  const { title, description, price, duration, mux_preview_id, mux_full_id, payhip_url, payhip_product_id, active } = req.body;
  if (!title || !mux_preview_id || !payhip_url) return res.status(400).json({ error: 'title, mux_preview_id, payhip_url required' });

  // Auto-extract product ID from URL if not provided
  const prodId = payhip_product_id || (payhip_url.split('/b/').pop().split('/')[0]) || null;

  const { data, error } = await supabase.from('videos').insert({
    title, description, price: parseFloat(price) || 0,
    duration, mux_preview_id, mux_full_id, payhip_url,
    payhip_product_id: prodId,
    active: active !== false,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.put('/api/admin/videos/:id', adminAuth, async (req, res) => {
  // Auto-extract product ID if payhip_url is being updated
  if (req.body.payhip_url && !req.body.payhip_product_id) {
    req.body.payhip_product_id = req.body.payhip_url.split('/b/').pop().split('/')[0] || null;
  }
  const { data, error } = await supabase.from('videos').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/videos/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('videos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

// ═══════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════

function buildWatchEmail(videoTitle, watchUrl, orderId) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#080202;font-family:'Helvetica Neue',Helvetica,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="font-size:1.4rem;letter-spacing:0.2em;color:#fafafa;text-transform:uppercase;margin:0;">AMARETTO H.</h1>
      <p style="font-size:0.65rem;letter-spacing:0.3em;color:#705426;text-transform:uppercase;margin:6px 0 0;">Exclusive Content</p>
    </div>

    <div style="background:#100303;border:1px solid #2a0808;border-radius:16px;padding:32px 28px;text-align:center;">
      <p style="font-size:0.72rem;letter-spacing:0.2em;color:#705426;text-transform:uppercase;margin:0 0 14px;">Your purchase is ready</p>
      <h2 style="font-size:1.3rem;color:#fafafa;margin:0 0 8px;">${videoTitle}</h2>
      <p style="font-size:0.8rem;color:#a3a3a3;line-height:1.65;margin:0 0 28px;">
        Your private watch link is below. This link is for your use only.<br>
        <strong style="color:#bc1b1b;">Do not share it.</strong>
      </p>

      <a href="${watchUrl}" style="display:inline-block;padding:16px 36px;background:linear-gradient(135deg,#4d0b0b,#bc1b1b);border-radius:30px;color:#fafafa;font-size:0.82rem;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;">
        Watch Now
      </a>

      <p style="font-size:0.7rem;color:#525252;margin:20px 0 0;">Or copy this link:<br>
        <span style="color:#705426;word-break:break-all;">${watchUrl}</span>
      </p>
    </div>

    <div style="margin-top:20px;padding:20px 24px;background:#0d0202;border:1px solid #1a0404;border-radius:12px;">
      <p style="font-size:0.68rem;color:#525252;margin:0;line-height:1.7;">
        <strong style="color:#a3a3a3;">Order ID:</strong> ${orderId}<br>
        <strong style="color:#a3a3a3;">Important:</strong> This email will not be resent. Save your watch link.<br>
        If you have an issue, visit <a href="${SITE_URL}/support" style="color:#705426;">amarettoh.com/support</a> with your Order ID.
      </p>
    </div>

    <p style="text-align:center;font-size:0.62rem;color:#2a0808;margin-top:24px;letter-spacing:0.1em;">
      &copy; 2024 Amaretto H. &nbsp;&middot;&nbsp; Private &amp; Discreet
    </p>
  </div>
</body>
</html>`;
}

function buildSupportReplyEmail(subject, body, ticketId) {
  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#080202;font-family:'Helvetica Neue',Helvetica,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <h1 style="font-size:1.2rem;letter-spacing:0.2em;color:#fafafa;text-transform:uppercase;text-align:center;">AMARETTO H.</h1>
    <div style="background:#100303;border:1px solid #2a0808;border-radius:16px;padding:28px;margin-top:20px;">
      <p style="font-size:0.68rem;letter-spacing:0.2em;color:#705426;text-transform:uppercase;margin:0 0 8px;">Support Reply — ${subject}</p>
      <p style="color:#cbcbcb;font-size:0.88rem;line-height:1.65;margin:0 0 20px;">${body.replace(/\n/g, '<br>')}</p>
      <a href="${SITE_URL}/support" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#4d0b0b,#bc1b1b);border-radius:24px;color:#fafafa;font-size:0.75rem;letter-spacing:0.12em;text-transform:uppercase;text-decoration:none;">
        View &amp; Reply
      </a>
    </div>
  </div>
</body>
</html>`;
}

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
