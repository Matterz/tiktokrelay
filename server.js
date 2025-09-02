// server.js
const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');

// If you're on Node < 18, uncomment the next line and add `node-fetch` to deps.
// const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const app = express();

// --- Byline helpers ---------------------------------------------------------
function escRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function unwrapJina(md){
  if (!md) return '';
  let t = String(md).replace(/\r\n/g, '\n');
  const i = t.toLowerCase().indexOf('markdown content:');
  return i !== -1 ? t.slice(i + 'markdown content:'.length) : t;
}
function stripLinksAndJunk(s){
  return String(s)
    // remove "...more" and "…more"
    .replace(/(?:\.{3}|…)\s*more/gi, ' ')
    // strip markdown links completely → ****
    .replace(/\[[^\]]*?\]\([^)]+?\)/g, '****')
    // strip bare URLs → ****
    .replace(/\b(?:https?:\/\/|www\.)[^\s)]+/gi, '****')
    // drop bracketed/braced fragments
    .replace(/[\[\]{}]/g, ' ')
    // drop "and N more links"
    .replace(/\band\s+\d+\s+more\s+links?\b/gi, ' ')
    // collapse whitespace
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim();
}
function dedupeHead(s){
  // If the first ~40 chars repeat immediately (common on some YT scrapes), keep one.
  const txt = String(s).trim();
  if (txt.length < 30) return txt;
  for (let n = 40; n >= 20; n--) {
    const a = txt.slice(0, n);
    const b = txt.slice(n, n*2);
    if (a && b && b.startsWith(a)) return (a + txt.slice(n*2)).trim();
  }
  return txt;
}
function clamp100(s){
  const t = String(s).trim();
  if (t.length <= 100) return t;
  return t.slice(0, 100).replace(/\s+\S*$/, '') + '…';
}

// Dedupe immediate repeated sentences (e.g., "Hi! ... Hi! ...")
function dedupeSentences(s){
  const parts = String(s || '').split(/([.!?]["']?\s+)/); // keep sentence separators
  if (parts.length <= 1) return String(s || '').trim();

  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = (parts[i] || '').trim();
    const sep = parts[i + 1] || '';
    if (!sentence) continue;

    const prev = out.length ? out[out.length - 1].s : null;
    if (prev && prev.toLowerCase() === sentence.toLowerCase()) {
      // skip exact repeat
      continue;
    }
    out.push({ s: sentence, sep });
  }
  return out.map(x => x.s + x.sep).join('').trim();
}

// --- Platform-aware extraction ----------------------------------------------
function extractYouTubeMainByline(markdown, sourceUrl){
  const txt = unwrapJina(markdown);

  // Grab the text immediately AFTER "… subscribers • … videos"
  const m = txt.match(/\bsubscribers\b[^\n]{0,200}?\bvideos\b\s*([^\n]{8,600})/i);
  if (!m || !m[1]) return '';

  // Clean junk/links first
  let body = stripLinksAndJunk(m[1]);

  // Redact channel handle/name derived from URL
  try {
    const handleFromAt = (sourceUrl.match(/youtube\.com\/@([^/?#]+)/i) || [])[1];
    const handleFromUC = (sourceUrl.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})/i) || [])[1];
    const h = handleFromAt || handleFromUC || '';
    if (h) {
      body = body
        .replace(new RegExp('\\b' + escRe(h) + '\\b', 'gi'), '****')
        .replace(new RegExp('\\b' + escRe(h.replace(/^@+/, '')) + '\\b', 'gi'), '****');
    }
  } catch {}

  // Some scrapes echo the first sentence twice; collapse that.
  //  - Start-of-string duplicate collapse
  body = body.replace(/^(.{8,160}?)(?:\s+\1)+/i, '$1');
  //  - Sentence-level dedupe
  body = dedupeSentences(body);

  // Final tidy (also collapses any lingering “more” we missed)
  body = dedupeHead(body);

  // Show a concise hint (100 chars)
  return clamp100(body);
}


function extractTwitchAboutByline(markdown){
  const txt = unwrapJina(markdown);
  if (!txt) return '';

  const lines = txt.split('\n');

  // Prefer followers line that appears AFTER the "### About ..." heading
  let aboutIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^###\s+about\b/i.test(lines[i].trim())) { aboutIdx = i; break; }
  }

  let followersIdx = -1;
  if (aboutIdx !== -1) {
    for (let i = aboutIdx; i < lines.length; i++) {
      if (/\bfollowers\b/i.test(lines[i])) { followersIdx = i; break; }
    }
  }
  // Fallback: second "followers" anywhere
  if (followersIdx === -1) {
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/\bfollowers\b/i.test(lines[i])) {
        hits++;
        if (hits === 2) { followersIdx = i; break; }
      }
    }
  }
  if (followersIdx === -1) return '';

  // Walk forward to next meaningful line, skipping CTAs, bullets, link-only lines, headers, "·", and stop at [![ (image panel)
  const BAD_CTA = /^(follow|following|subscribe|subscribed|gift a sub|gift sub|report|share|chat|send a message|emote[- ]?only|shop|store|block)$/i;
  const LINK_ONLY = /^\s*(?:\*+\s*)?\[[^\]]+\]\([^)]*\)\s*$/i;
  const BULLET_LINK = /^\s*\*\s+\[[^\]]+\]\([^)]*\)\s*$/i;
  const JUST_DOT = /^\s*[·*]+\s*$/;
  const HEADER_LINE = /^\s*#{1,6}\s+\S/;
  const IMAGE_LINK = /^\s*\[\!\[/; // [![Image ...]

  for (let i = followersIdx + 1; i < lines.length; i++) {
    let raw = lines[i].trim();
    if (!raw) continue;
    if (IMAGE_LINK.test(raw)) break;
    if (HEADER_LINE.test(raw)) continue;
    if (JUST_DOT.test(raw)) continue;
    if (BULLET_LINK.test(raw)) continue;
    if (LINK_ONLY.test(raw)) continue;
    if (BAD_CTA.test(raw)) continue;

    // Clean inline links and bare URLs
    let cleaned = raw
      .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned || cleaned === '·') continue;
    if (/^\[\!\[/.test(cleaned)) break;

    return clamp100(cleaned);
  }

  return '';
}

function extractGenericByline(markdown){
  const txt = unwrapJina(markdown);
  const NAV = /^(home|videos|shorts|live|playlists|community|channels|store|members|about|description|search|subscriptions|popular|stats|links?|details?|location|joined|business|email|contact|creator|more)$/i;
  const BAD = /\b(cookie|cookies|consent|privacy|policy|analytics|partners|third[- ]party|marketing|targeting)\b/i;

  const paras = txt.split(/\n{2,}/)
    .map(p => p.split('\n').map(s => s.trim()).filter(Boolean).filter(l => !NAV.test(l)).join(' '))
    .map(stripLinksAndJunk)
    .filter(Boolean)
    .filter(p => !BAD.test(p));

  let best = '';
  let score = -1;
  for (const p of paras) {
    const s =
      (p.length >= 40 && p.length <= 400 ? 60 : 0) +
      (/[.!?]["']?$/.test(p) ? 10 : 0) +
      (/\b(i|my|we|channel|subscribe|video|videos|stream|streaming|gaming|variety)\b/i.test(p) ? 20 : 0);
    if (s > score) { score = s; best = p; }
  }
  return clamp100(best);
}

function extractBylineFor(url, markdown){
  const u = String(url || '').toLowerCase();
  if (/youtube\.com/.test(u))   return extractYouTubeMainByline(markdown, url);
  if (/twitch\.tv/.test(u))     return extractTwitchAboutByline(markdown);
  return extractGenericByline(markdown);
}

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
// --- Byline proxy: YT uses MAIN page; sanitize; single attempt; no client fallback ------
app.get('/byline', async (req, res) => {
  try {
    let rawUrl = String(req.query.u || '').trim();
    if (!rawUrl) return res.status(400).type('text/plain').send('Missing u');

    // Allow only known platforms
    const ok = /^(https?:)?\/\/(?:www\.)?(youtube\.com|twitch\.tv|kick\.com)\b/i.test(rawUrl);
    if (!ok) return res.status(400).type('text/plain').send('Unsupported host');

    // For YouTube: force the MAIN channel page (strip any trailing /about)
    if (/youtube\.com/i.test(rawUrl)) {
      rawUrl = rawUrl.replace(/\/about(?:$|[/?#].*)/i, '');
    }

    // Build Jina fetch (textified mirror)
    const target = rawUrl.replace(/^https?:\/\//i, '');
    const jina   = 'https://r.jina.ai/http://' + target;

    const r = await fetch(jina, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'byline-proxy/1.0', 'accept-language': 'en-US,en;q=0.9' }
    });

    if (!r.ok) return res.status(502).type('text/plain').send('Fetch failed');

    const md = await r.text();
    // Twitch raw=1: return the FULL About page markdown (no cleanup)
    if (/twitch\.tv/i.test(rawUrl) && String(req.query.raw || '') === '1') {
      const fullAbout = unwrapJina(md);
      if (fullAbout) {
        res.set('Cache-Control', 'public, max-age=900');
        return res.type('text/plain').send(fullAbout);
      }
      return res.status(204).end();
    }
    const byline = extractBylineFor(rawUrl, md);

    if (!byline) return res.status(204).end(); // empty → client shows “unavailable this round”
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('text/plain').send(byline);
  } catch (e) {
    console.error('byline error:', e && e.message ? e.message : e);
    res.status(503).type('text/plain').send('Unavailable');
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

// --- Twitch-only helpers for full About page proxy ---

// Is this a Twitch URL?
function isTwitchUrl(u) {
  return /(^|\/\/)(www\.)?twitch\.tv\//i.test(String(u));
}

// Normalize to https://twitch.tv/<user>/about
function normalizeTwitchAboutUrl(raw) {
  const u = String(raw || '').trim();
  try {
    const url = new URL(u);
    const user = (url.pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, '');
    return user ? `${url.origin}/${user}/about` : `${url.origin}/about`;
  } catch {
    return u.replace(/\/+$/, '') + '/about';
  }
}

// 12s abort helper
function timeoutSignal(ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

// Pull out the "Markdown Content:" part from r.jina.ai (if present)
function extractMarkdownSection(rawText) {
  const txt = String(rawText || '');
  const i = txt.toLowerCase().indexOf('markdown content:');
  return i >= 0 ? txt.slice(i + 'markdown content:'.length).trim() : txt.trim();
}

// Light structure for convenience (you can ignore this client-side if you want)
function structureMarkdown(md) {
  const lines = md.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const headings = lines.filter((l) => /^#{1,6}\s+\S/.test(l));
  return { headings, lines };
}

// GET /twitch-about?u=<twitch-channel-url>
// Returns JSON: { sourceUrl, format: "markdown", markdown, headings[], lines[] }
app.get('/twitch-about', async (req, res) => {
  try {
    const rawU = String(req.query.u || '').trim();
    if (!rawU || !isTwitchUrl(rawU)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(400).json({ error: 'Provide ?u= with a twitch.tv URL' });
    }

    const sourceUrl = normalizeTwitchAboutUrl(rawU);
    const jinaUrl = 'https://r.jina.ai/http://' + sourceUrl.replace(/^https?:\/\//i, '');

    const { signal, cancel } = timeoutSignal(12000);
    const r = await fetch(jinaUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RelayBot/1.0)',
        'Accept': 'text/plain,*/*;q=0.8'
      },
      redirect: 'follow',
      signal
    }).catch((e) => ({ ok: false, status: 599, _err: e }));
    cancel();

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!r || !r.ok) {
      return res.status(502).json({ error: 'upstream_unavailable', status: r && r.status });
    }

    const rawText = await r.text();
    const markdown = extractMarkdownSection(rawText);
    const { headings, lines } = structureMarkdown(markdown);

    return res.status(200).json({
      sourceUrl,
      fetchedFrom: 'jina',
      format: 'markdown',
      markdown,
      headings,
      lines,
      fetchedAt: new Date().toISOString()
    });
  } catch (e) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ sourceUrl: null, format: 'markdown', markdown: '' }); // fail-soft
  }
});

/* --------------------------------- Start -------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Relay listening on', PORT));
