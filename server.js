// server.js
const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();

/* ----------------------------- CORS (global) ----------------------------- */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ------------------------------ Small utils ------------------------------ */
function unwrapJina(md) {
  if (!md) return '';
  let t = String(md).replace(/\r\n/g, '\n');
  const i = t.toLowerCase().indexOf('markdown content:');
  return i !== -1 ? t.slice(i + 'markdown content:'.length) : t;
}
function clamp100(s) {
  const t = String(s).trim();
  if (t.length <= 100) return t;
  return t.slice(0, 100).replace(/\s+\S*$/, '') + '…';
}
function isTwitchUrl(u) {
  return /(^|\/\/)(www\.)?twitch\.tv\//i.test(String(u));
}
function isYouTubeUrl(u) {
  return /(^|\/\/)(www\.)?youtube\.com\//i.test(String(u));
}

/* ----------------------- Twitch followers-based pick ---------------------- */
/**
 * From a markdown-ish blob, find the first sentence-like paragraph that follows
 * the line containing something like "9.4M followers". Skip CTAs like "Follow".
 */
function extractTwitchBylineAfterFollowers(markdown) {
  const txt = unwrapJina(markdown);
  if (!txt) return '';

  // Split into paragraphs by blank lines
  const paras = txt
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Followers regex examples: "9.4M followers", "9,400,000 followers", "9400 followers", "9.4 million followers"
  const FOLLOWERS_RE = /\b\d[\d.,]*\s*(?:[kmb]|thousand|million|billion)?\s*followers\b/i;

  // Find followers index
  let idx = -1;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (FOLLOWERS_RE.test(p) || /\bfollowers\b/i.test(p)) { idx = i; break; }
  }
  if (idx === -1) return '';

  const BAD_CTA = /^(follow|following|subscribe|subscribed|gift a sub|gift sub|report|share|chat|send a message|emote[- ]?only|shop|store|block)$/i;
  const BAD_PHRASE = /welcome to the chat room!/i;
  const OK_KEY = /\b(streams?|streaming|gaming|plays?|about|bio|welcome|business|contact|creator|videos?)\b/i;

  // Look ahead up to 5 paragraphs for a good candidate
  for (let j = idx + 1; j < Math.min(paras.length, idx + 6); j++) {
    let cand = paras[j]
      .replace(/\[[^\]]*\]\([^)]*\)/g, ' ') // strip markdown links
      .replace(/\s+/g, ' ')
      .trim();

    if (!cand) continue;
    if (BAD_PHRASE.test(cand)) continue;
    if (BAD_CTA.test(cand)) continue;

    const words = cand.split(/\s+/);
    // Skip very short CTAs that slipped through (1–2 words, no sentence punctuation)
    if (words.length <= 2 && !/[.!?]$/.test(cand)) continue;

    // Accept if it's a sentence or contains good keywords
    if (/[.!?]["']?$/.test(cand) || OK_KEY.test(cand)) {
      return clamp100(cand);
    }
  }

  return '';
}

/* ------------------------------- BYLINE API ------------------------------ */
/**
 * GET /byline?u=<absolute URL>
 * - For Twitch: pick the paragraph after the "<count> followers" line, skipping CTAs.
 * - For others: return a concise slice of the readable text (unchanged).
 */
app.get('/byline', async (req, res) => {
  try {
    const rawUrl = String(req.query.u || '').trim();
    if (!rawUrl) return res.status(400).type('text/plain').send('Missing u');

    const target = rawUrl.replace(/^https?:\/\//i, '');
    const jina = 'https://r.jina.ai/http://' + target;

    const r = await fetch(jina, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'byline-proxy/1.0', 'accept-language': 'en-US,en;q=0.9' }
    });

    if (!r.ok) return res.status(502).type('text/plain').send('Fetch failed');

    const md = await r.text();

    if (isTwitchUrl(rawUrl)) {
      const picked = extractTwitchBylineAfterFollowers(md);
      if (picked) {
        res.set('Cache-Control', 'public, max-age=1800');
        return res.type('text/plain').send(picked);
      }
      // If not found for Twitch, return empty (client can fall back or ignore)
      return res.status(204).end();
    }

    // For non-Twitch, leave existing clients unaffected: return a concise slice of readable text.
    const text = unwrapJina(md).split(/\n{2,}/).map(s => s.trim()).filter(Boolean)[0] || '';
    const out = clamp100(text);
    if (!out) return res.status(204).end();
    res.set('Cache-Control', 'public, max-age=1800');
    return res.type('text/plain').send(out);
  } catch (e) {
    console.error('byline error:', e && e.message ? e.message : e);
    return res.status(503).type('text/plain').send('Unavailable');
  }
});

/* ------------------------------ Healthcheck ------------------------------ */
app.get('/', (_req, res) => res.type('text/plain').send('TikTok SSE relay & Byline proxy OK'));

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
