// server.js
const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');

// If you're on Node < 18, uncomment the next line and add `node-fetch` to deps.
// const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const app = express();

/* ----------------------------- CORS (global) ----------------------------- */
/* Allow the browser to call these endpoints from any origin (Bluehost, etc.) */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ------------------------------ Healthcheck ------------------------------ */
app.get('/', (_req, res) => res.type('text/plain').send('TikTok SSE relay & Byline proxy OK'));

/* ------------------------------- BYLINE API ------------------------------ */
/**
 * GET /byline?u=<absolute URL>
 * - No fallback attempts. We fetch Jina's textified mirror exactly once.
 * - On success: 200 text/plain (raw text body from Jina).
 * - On any failure: 4xx/5xx JSON; client should treat as "hint unavailable".
 */
app.get('/byline', async (req, res) => {
  try {
    const raw = String(req.query.u || '').trim();
    if (!/^https?:\/\//i.test(raw)) {
      return res.status(400).json({ error: 'missing_or_invalid_u' });
    }

    // Build Jina endpoint that returns text for the provided URL
    const endpoint = 'https://r.jina.ai/http://' + raw.replace(/^https?:\/\//, '');

    // Fetch once (no retry/fallback)
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    const r = await fetch(endpoint, {
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }
    });

    const body = await r.text();

    if (!r.ok || !body) {
      return res.status(502).json({
        error: 'upstream_error',
        status: r.status,
        hint: 'byline_unavailable_this_round'
      });
    }

    // Success: return plain text so the client parser can work with it
    return res.type('text/plain').status(200).send(body);
  } catch (e) {
    return res.status(502).json({
      error: 'fetch_failed',
      message: e?.message || String(e),
      hint: 'byline_unavailable_this_round'
    });
  }
});

/* ------------------------------ TikTok SSE ------------------------------- */
/** SSE endpoint: /tiktok-sse?user=keyaogames */
app.get('/tiktok-sse', async (req, res) => {
  const user = String(req.query.user || '').trim().toLowerCase();
  if (!user) return res.status(400).json({ error: 'Missing ?user=' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // keep-alive ping so proxies don’t close the stream
  const keepAlive = setInterval(() => res.write(':\n\n'), 15000);

  // backoff for reconnects when not live yet
  const delays = [2000, 5000, 10000, 20000, 30000, 60000];
  let attempt = 0;
  let tiktok = null;
  let closed = false;

  const cleanup = () => {
    clearInterval(keepAlive);
    try { tiktok && tiktok.disconnect(); } catch {}
  };

  req.on('close', () => { closed = true; cleanup(); });

  function writeEvent(event, data) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  }

  function errPayload(e) {
    if (!e) return { message: 'unknown' };
    const out = { message: e.message || String(e) };
    if (e.code) out.code = e.code;
    if (e.statusCode) out.statusCode = e.statusCode;
    if (e.status) out.status = e.status;
    return out;
  }

  async function connect(trigger) {
    if (closed) return;
    if (tiktok) { try { tiktok.disconnect(); } catch {} tiktok = null; }

    writeEvent('debug', { stage: 'attempt', user, trigger });

    tiktok = new WebcastPushConnection(user, { enableExtendedGiftInfo: false });

    // forward chat messages
    tiktok.on('chat', (msg) => {
      writeEvent('chat', {
        comment: String(msg.comment || ''),
        uniqueId: msg.uniqueId || '',
        nickname: msg.nickname || ''
      });
    });

    // reconnect cases — include details so the client can display them
    const onDisc = () => { writeEvent('status', { state: 'disconnected' }); schedule('disconnected'); };
    const onErr  = (e) => { writeEvent('status', { state: 'error', ...errPayload(e) }); schedule('error'); };
    const onEnd  = () => { writeEvent('status', { state: 'ended' }); schedule('streamEnd'); };
    tiktok.on('disconnected', onDisc);
    tiktok.on('error', onErr);
    tiktok.on('streamEnd', onEnd);

    try {
      await tiktok.connect();
      attempt = 0; // reset backoff
      writeEvent('status', { state: 'connected', user });
      writeEvent('open', { ok: true, user });
    } catch (e) {
      writeEvent('status', { state: 'error', ...errPayload(e) });
      schedule('connect:reject');
    }
  }

  function schedule(reason) {
    if (closed) return;
    const wait = delays[Math.min(attempt++, delays.length - 1)];
    writeEvent('debug', { stage: 'retry', user, inMs: wait, reason });
    setTimeout(() => connect('retry'), wait);
  }

  connect('init');
});

/* --------------------------------- Start -------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Relay listening on', PORT));
