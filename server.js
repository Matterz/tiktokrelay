// server.js — SSE relay + Byline extractor (Node 18+)
const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();

// ---------- tiny utils ----------
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36';
const JSON_OK = (res, code, obj) => res.status(code).json(obj);
const TXT = (res, code, text) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(code).send(text);
};
function timeoutSignal(ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}
function cleanSpaces(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim();
}
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- URL normalization (mirror of the client’s logic) ----------
function normalizeSourceUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return '';
  const low = u.toLowerCase();

  // YouTube → canonical root (handle or UC channel)
  if (low.includes('youtube.com')) {
    const mHandle = u.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i);
    if (mHandle) return `https://www.youtube.com/@${mHandle[1]}`;
    const mUC = u.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})/i);
    if (mUC) return `https://www.youtube.com/channel/${mUC[1]}`;
    try {
      const urlObj = new URL(u);
      const parts = urlObj.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      if (parts.length >= 1 && parts[0].startsWith('@')) return `${urlObj.origin}/@${parts[0].replace(/^@+/, '')}`;
      if (parts.length >= 2 && parts[0].toLowerCase() === 'channel')
        return `${urlObj.origin}/channel/${parts[1]}`;
      return urlObj.origin;
    } catch {
      return u;
    }
  }

  // Twitch → always point at /about
  if (low.includes('twitch.tv')) {
    return u.replace(/\/+$/, '') + '/about';
  }

  // Kick / others → leave as-is
  return u;
}

// Derive channel tokens to redact self-references (handle/id) from the snippet
function tokensForRedaction(url) {
  const toks = new Set();
  try {
    const mYT = url.match(/youtube\.com\/@([^/?#]+)/i);
    const mUC = url.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})/i);
    const mTW = url.match(/twitch\.tv\/([^/?#]+)/i);
    const mKK = url.match(/kick\.com\/([^/?#]+)/i);
    const h = (mYT && mYT[1]) || (mUC && mUC[1]) || (mTW && mTW[1]) || (mKK && mKK[1]) || '';
    if (h) {
      toks.add(h);
      if (h.startsWith('@')) toks.add(h.slice(1));
    }
  } catch {}
  return Array.from(toks).filter(Boolean).sort((a, b) => b.length - a.length);
}

// Score & pick a human-looking “about/byline” line from Markdown-ish text
function pickBylineFromMarkdown(markdown, sourceUrl) {
  if (!markdown) return '';

  // Strip obvious junk first
  const BAD_ANY = /\b(cookie|cookies|consent|privacy|policy|partners|third[- ]party|analytics|advertis|do not sell)\b/i;
  const NAV = /^(home|videos?|shorts|live|playlists|community|channels|store|members|about|search|subscriptions|more|stats|links?)$/i;

  // Twitch-specific boilerplate that caused your bug
  const TWITCH_A11Y = /press escape|shift \+ tab|within chat messages to exit/i;

  // Split to candidate lines/paras
  const paras = String(markdown)
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !NAV.test(s))
        .join(' ')
    )
    .map((p) =>
      p
        // Remove links/URLs & bracketed junk
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/\bhttps?:\/\/[^\s)]+/gi, ' ')
        .replace(/\bwww\.[^\s)]+/gi, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .filter((p) => !BAD_ANY.test(p))
    .filter((p) => !TWITCH_A11Y.test(p));

  // Scoring: prefer “about me”-ish, short, personable lines (20–200 chars)
  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const score = (p) =>
    (p.length >= 20 && p.length <= 220 ? 60 : 0) +
    (/[.!?]["']?$/.test(p) ? 10 : 0) +
    (/\b(i|my|me|we|welcome|happy|business|contact|inquiries)\b/i.test(p) ? 20 : 0) +
    (EMAIL.test(p) ? 20 : 0) +
    // Gentle Twitch bias
    (sourceUrl.includes('twitch.tv') ? 5 : 0);

  let best = '';
  let bestScore = -1;
  for (const p of paras) {
    const s = score(p);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best || '';
}

// Final sanitize + trim to ≤100 chars + redact channel tokens
function finalizeByline(s, sourceUrl) {
  let out = String(s || '')
    .replace(/[\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(?:\.\.\.\s*more)+/gi, '')
    .replace(/^[\s–—•|]+/, ' ')
    .trim();

  // Redact the channel’s own handle/id to prevent giveaway
  const toks = tokensForRedaction(sourceUrl);
  if (toks.length) {
    const re = new RegExp(`\\b(${toks.map(escapeRe).join('|')})\\b`, 'gi');
    out = out.replace(re, '****');
  }

  const MAX = 100;
  if (out.length > MAX) {
    out = out.slice(0, MAX).replace(/\s+\S*$/, '') + '…';
  }
  return out;
}

// ---------- Basic homepage ----------
app.get('/', (_req, res) => res.type('text/plain').send('TikTok SSE relay OK'));

// ---------- SSE endpoint: /tiktok-sse?user=keyaogames ----------
app.get('/tiktok-sse', async (req, res) => {
  const user = String(req.query.user || '').trim().toLowerCase();
  if (!user) return JSON_OK(res, 400, { error: 'Missing ?user=' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const keepAlive = setInterval(() => res.write(':\n\n'), 15000);

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

    tiktok.on('chat', (msg) => {
      writeEvent('chat', {
        comment: String(msg.comment || ''),
        uniqueId: msg.uniqueId || '',
        nickname: msg.nickname || ''
      });
    });

    const onDisc = () => { writeEvent('status', { state: 'disconnected' }); schedule('disconnected'); };
    const onErr  = (e) => { writeEvent('status', { state: 'error', ...errPayload(e) }); schedule('error'); };
    const onEnd  = () => { writeEvent('status', { state: 'ended' }); schedule('streamEnd'); };
    tiktok.on('disconnected', onDisc);
    tiktok.on('error', onErr);
    tiktok.on('streamEnd', onEnd);

    try {
      await tiktok.connect();
      attempt = 0;
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

// ---------- NEW: /byline?u=<channel-url> ----------
app.get('/byline', async (req, res) => {
  try {
    const rawU = String(req.query.u || '').trim();
    if (!rawU) return TXT(res, 400, ''); // empty body on bad request (client treats as unavailable)

    // Normalize (e.g., Twitch → /about)
    const sourceUrl = normalizeSourceUrl(rawU);

    // Use r.jina.ai to get a readable markdown-ish dump
    const jinaUrl = 'https://r.jina.ai/http://' + sourceUrl.replace(/^https?:\/\//i, '');
    const { signal, cancel } = timeoutSignal(12000);
    const r = await fetch(jinaUrl, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'text/plain,*/*;q=0.8' },
      redirect: 'follow',
      signal
    }).catch((e) => ({ ok: false, status: 599, _err: e }));

    cancel();

    if (!r || !r.ok) {
      // return empty to let the client fall back gracefully
      return TXT(res, 502, '');
    }

    const rawText = await r.text();
    if (!rawText) return TXT(res, 204, '');

    // Extract the "Markdown Content:" section if present
    let md = rawText.replace(/\r\n/g, '\n');
    const idx = md.toLowerCase().indexOf('markdown content:');
    if (idx !== -1) md = md.slice(idx + 'markdown content:'.length);

    // Heuristic pick
    const picked = pickBylineFromMarkdown(md, sourceUrl);

    // Final sanitize + trim (≤100 chars) + redact handle/id
    const out = finalizeByline(picked, sourceUrl);

    // Even if empty, reply 200 with empty body — client treats non-text as “not available”
    return TXT(res, 200, out);
  } catch (_e) {
    return TXT(res, 200, ''); // fail-soft
  }
});

// ---------- listen ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Relay listening on', PORT));
