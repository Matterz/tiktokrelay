// server.js
const express = require('express');
const { WebcastPushConnection } = require('@qixils/tiktok-live-connector');

// Debug: confirm which TikTok connector actually loads at runtime
try {
  const modPath = require.resolve('@qixils/tiktok-live-connector');
  const modPkg = require('@qixils/tiktok-live-connector/package.json');
  console.log('[TikTok LC] Using', modPath, 'version', modPkg.version);
} catch (e) {
  console.warn('[TikTok LC] Could not resolve @qixils package:', e && e.message);
}

// If you're on Node < 18, uncomment the next line and add `node-fetch` to deps.
// const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const app = express();

// Ensure Express trusts proxies (Render/NGINX)
app.set('trust proxy', 1);

// CORS allowlist (can be '*' if you prefer; here we still send '*' as fallback)
const ALLOW_ORIGINS = new Set([
  'https://keyguessing.com',
  'https://www.keyguessing.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:8080'
]);
function setCORS(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

// Global CORS middleware
app.use((req, res, next) => {
  setCORS(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Fetch shim (works on Node < 18 too)
const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));


// --- Byline helpers ---------------------------------------------------------
function escRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Remove ugly masked tail like "********;)" or trailing asterisks + punctuation
function stripMaskedTail(s){
  let out = String(s || '');
  // Only do aggressive tail cleaning if masked tokens appear near the end
  if (/\*{4,}[^\S\r\n]*(?:[;:]-?\)|[)\]}.,;:!?]+)?\s*$/.test(out)) {
    let prev;
    do {
      prev = out;
      // remove smileys like ;) or :) at the very end
      out = out.replace(/\s*(?:;|:)-?\)\s*$/,'')
               // then trailing brackets/parens
               .replace(/\s*[)\]}]+\s*$/,'')
               // then trailing punctuation runs
               .replace(/\s*[,.;:!?]+\s*$/,'')
               // finally trailing runs of masked asterisks
               .replace(/\s*\*{4,}\s*$/,'');
    } while (out.length < prev.length);
  }
  return out.trim();
}

// --- Twitch redaction helpers (mask email, links, and handle/partials ≥4 chars) ---
function twitchUsernameFromUrl(u) {
  try {
    const url = new URL(u);
    const seg = (url.pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, '');
    return seg || '';
  } catch {
    const m = String(u || '').match(/twitch\.tv\/([^\/?#]+)/i);
    return m ? m[1] : '';
  }
}

function twitchRedactionTokens(username) {
  const out = new Set();
  const orig = String(username || '');
  const base = orig.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!base) return [];

  // Full handle
  out.add(base);

  // Sliding substrings length 4..8 (avoid masking 3-letter words like "the")
  const maxLen = Math.min(8, base.length);
  for (let L = maxLen; L >= 4; L--) {
    for (let i = 0; i + L <= base.length; i++) {
      out.add(base.slice(i, i + L));
    }
  }

  // Also camelCase/number segments length ≥4 (e.g., "Dark", "Viper", "100")
  const parts = (orig.match(/[A-Z]?[a-z]+|[0-9]+|[A-Z]+(?![a-z])/g) || []).map(s => s.toLowerCase());
  for (const p of parts) if (p.length >= 4) out.add(p);

  // Longest first to avoid partial-overlap issues
  return Array.from(out).sort((a, b) => b.length - a.length);
}

function redactBylineForTwitch(text, sourceUrl) {
  let out = String(text || '');

  // Emails → ****
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '****');

  // Links/URLs → ****
  out = out.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '****');

  // Username & partials ≥4 → ****
  const user = twitchUsernameFromUrl(sourceUrl);
  if (user) {
    const toks = twitchRedactionTokens(user);
    if (toks.length) {
      const re = new RegExp(toks.map(escRe).join('|'), 'gi');
      out = out.replace(re, '****');
    }
  }

  return out.replace(/\s+/g, ' ').trim();
}

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
// YouTube (About tab): take text between the horizontal rule "----" + "Description"
function extractYouTubeMainByline(markdown, sourceUrl){
  const txt = unwrapJina(markdown);

  // 1) Prefer the canonical About → Description block:
  //    match a line of --- (or more), then "Description", then capture until "Links"/next section.
  const section =
    txt.match(/(?:^|\n)-{3,}\s*\n+Description\s*\n+([\s\S]*?)(?:\n{2,}(?:Links|Stats|Details|Business|More)\b|$)/i)
    || txt.match(/(?:^|\n)Description\s*\n+([\s\S]*?)(?:\n{2,}(?:Links|Stats|Details|Business|More)\b|$)/i);

  if (!section) return '';

  // 2) Clean the captured block
  let body = section[1] || '';

  // Remove markdown links and bare URLs first
  body = body
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')             // [text](url)
    .replace(/\((?:https?:\/\/|www\.)[^)]+\)/gi, ' ') // (http...)
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')     // bare urls
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  // Use the first meaningful non-empty line as the byline basis
  const lines = body.split(/\n+/).map(s => s.trim()).filter(Boolean);
  body = lines.find(s => s && !/^(?:[-–•·]+|\*+)$/.test(s)) || '';

  // 3) Redact channel handle/name derived from URL (keep existing behavior)
  try {
    const handleFromAt = (sourceUrl.match(/youtube\.com\/@([^/?#]+)/i) || [])[1];
    const handleFromUC = (sourceUrl.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})/i) || [])[1];
    const h = handleFromAt || handleFromUC || '';
    if (h) {
      // Mask exact handle and handle without leading @
      body = body
        .replace(new RegExp('\\b' + escRe(h) + '\\b', 'gi'), '****')
        .replace(new RegExp('\\b' + escRe(h.replace(/^@+/, '')) + '\\b', 'gi'), '****');
    }
  } catch {}

  // Also redact emails if present
  body = body.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '****');

  // 4) Dedupe/clean like before
  body = body.replace(/^(.{8,160}?)(?:\s+\1)+/i, '$1'); // leading duplicate sentence collapse
  body = dedupeSentences(body);
  body = dedupeHead(body);

  // Drop masked junk at the very end (handles "********;)")
  body = stripMaskedTail(body);

  // 5) Clamp to 100 chars (existing API behavior)
  return clamp100(body);
}

// Extract Twitch "About" byline by taking the text after the followers line
function extractTwitchAboutByline(markdown, sourceUrl) {
  const md = unwrapJina(markdown);

  // 1) Jump to the "### About ..." section to avoid nav/header noise
  const aboutMatch = md.match(/^\s*###\s+About\b[^\n]*$/im);
  const startAt = aboutMatch ? md.indexOf(aboutMatch[0]) + aboutMatch[0].length : 0;
  const tail = md.slice(startAt);

  // 2) Find the followers line AFTER the About heading
  // Accepts formats like: "1.3M followers", "9,450 followers", "123K followers"
  const followersRe = /(^|\n)\s*\d[\d.,]*\s*[kKmM]?\s*followers\b[^\S\r\n]*\n+/i;
  const m = followersRe.exec(tail);
  if (!m) {
    // Fallback: if no followers line was found in the About section, do a generic cleanup
    // so we never return accessibility/chat boilerplate.
    const cleaned = tail
      .replace(/\*\*\s*·\s*\*\*/g, ' ')
      .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return clamp100(redactBylineForTwitch(cleaned, sourceUrl));
  }
  let pos = m.index + m[0].length;

  // 3) Define the end boundary: first [![ (panel image) OR next "###" heading OR end of doc
  const after = tail.slice(pos);
  const endImg = after.indexOf('[![');
  const endHeading = after.search(/\n{2,}###\s+/);
  let end = after.length;
  if (endImg !== -1) end = Math.min(end, endImg);
  if (endHeading !== -1) end = Math.min(end, endHeading);

  // 4) Slice the byline block and clean it
  let block = after.slice(0, end);

  // Remove obvious decoration lines and links (e.g., "**·**", "[Team](link)")
  block = block
    .replace(/\*\*\s*·\s*\*\*/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')       // strip markdown links
    .replace(/\((?:https?:\/\/|www\.)[^)]+\)/gi, ' ') // stray bare URLs in parens
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')     // any remaining bare URLs
    .replace(/[ \t]+\n/g, '\n')                 // trim trailing spaces on lines
    .trim();

  // 5) Choose the first meaningful non-empty line as the byline
  const lines = block.split(/\n+/).map(s => s.trim()).filter(Boolean);
  let byline = lines.find(s => s && !/^(?:[-–•·]+|\*+)$/.test(s)) || '';

  // 6) Redact emails/links + username partials (>=4 chars), then clamp to 100 chars
  byline = redactBylineForTwitch(byline, sourceUrl);
  return clamp100(byline);
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
  if (/twitch\.tv/.test(u))     return extractTwitchAboutByline(markdown, url);
  return extractGenericByline(markdown);
}

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
    setCORS(req, res); // belt & suspenders

    let rawUrl = String(req.query.u || '').trim();
    if (!rawUrl) return res.status(400).type('text/plain').send('Missing u');

    // Only known platforms
    const ok = /^(https?:)?\/\/(?:www\.)?(youtube\.com|twitch\.tv|kick\.com)\b/i.test(rawUrl);
    if (!ok) return res.status(400).type('text/plain').send('Unsupported host');

    // YouTube: force the About tab
	if (/youtube\.com/i.test(rawUrl)) {
	  // strip query/hash, trailing slash
	  rawUrl = rawUrl.replace(/[?#].*$/, '').replace(/\/$/, '');
	  // ensure /about is present
	  if (!/\/about(?:$|[/?#])/.test(rawUrl)) rawUrl = rawUrl + '/about';
	}

    // Fetch via r.jina.ai mirror
    const target = rawUrl.replace(/^https?:\/\//i, '');
    const jina   = 'https://r.jina.ai/http://' + target;

    const r = await _fetch(jina, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'byline-proxy/1.0', 'accept-language': 'en-US,en;q=0.9' }
    });

    if (!r.ok) {
      // Important: include CORS headers even on error
      setCORS(req, res);
      return res.status(502).type('text/plain').send('Fetch failed');
    }

    let md = await r.text();
	
	// Avoid huge strings causing memory spikes
	if (md.length > 400_000) md = md.slice(0, 400_000);

    const byline = extractBylineFor(rawUrl, md);

    if (!byline) {
      setCORS(req, res);
      return res.status(204).end();
    }

    res.set('Cache-Control', 'public, max-age=3600');
    setCORS(req, res);
    return res.type('text/plain').send(byline);
  } catch (e) {
    console.error('byline error:', e && e.message ? e.message : e);
    setCORS(req, res);
    return res.status(503).type('text/plain').send('Unavailable');
  }
});

/* ------------------------------ TikTok SSE ------------------------------- */
/** SSE endpoint: /tiktok-sse?user=keyaogames */

// Safely serialize any thrown/reported error so it never crashes the SSE writer
function serializeErr(e) {
  try {
    if (!e) return { message: 'unknown' };
    if (e instanceof Error) {
      return {
        name: e.name || 'Error',
        message: String(e.message || 'unknown'),
        code: e.code,
        stack: e.stack
      };
    }
    if (typeof e === 'object') {
      const out = {};
      for (const k of ['message','name','code','status','statusCode','type','errno','syscall']) {
        if (e && e[k] !== undefined) out[k] = typeof e[k] === 'object' ? JSON.stringify(e[k]) : String(e[k]);
      }
      // Common axios-style nesting
      if (e && e.response && typeof e.response === 'object') {
        out.response = {};
        for (const k of ['status','statusText']) {
          if (e.response[k] !== undefined) out.response[k] = e.response[k];
        }
      }
      return out.message || Object.keys(out).length ? out : { message: String(e) };
    }
    return { message: String(e) };
  } catch {
    // As a last resort, coerce to string
    return { message: String(e || 'unknown') };
  }
}

// Extract Set-Cookie headers across fetch implementations
function getSetCookieArray(resp) {
  try {
    if (resp && typeof resp.headers?.getSetCookie === 'function') {
      return resp.headers.getSetCookie();             // node 18 fetch on some hosts
    }
    if (resp && typeof resp.headers?.raw === 'function') {
      const raw = resp.headers.raw();                 // node-fetch
      if (raw && raw['set-cookie']) return raw['set-cookie'];
    }
    const v = resp && resp.headers && resp.headers.get && resp.headers.get('set-cookie');
    return v ? [v] : [];
  } catch { return []; }
}

// Parse cookie strings into a map
function parseCookies(setCookieArr) {
  const jar = {};
  for (const line of (setCookieArr || [])) {
    const pair = String(line).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) {
      const name = pair.slice(0, i).trim();
      const val  = pair.slice(i + 1).trim();
      if (name && val) jar[name] = val;
    }
  }
  return jar;
}

// Try to get useful TikTok cookies (ttwid, odin_tt, etc.) to reduce rejections
async function getTikTokCookieHeader(user, baseHeaders) {
  const urls = [
    `https://www.tiktok.com/@${encodeURIComponent(user)}/live`,
    `https://www.tiktok.com/@${encodeURIComponent(user)}`,
    `https://www.tiktok.com/`
  ];
  const jar = {};
  for (const url of urls) {
    try {
      const r = await _fetch(url, { method: 'GET', headers: baseHeaders, redirect: 'follow' });
      const arr = getSetCookieArray(r);
      const got = parseCookies(arr);
      Object.assign(jar, got);
      if (jar.ttwid) break; // usually enough
    } catch {}
  }
  const parts = [];
  if (jar.ttwid) parts.push(`ttwid=${jar.ttwid}`);
  if (jar.odin_tt) parts.push(`odin_tt=${jar.odin_tt}`);
  if (jar['tt_csrf_token']) parts.push(`tt_csrf_token=${jar['tt_csrf_token']}`);
  if (jar['s_v_web_id']) parts.push(`s_v_web_id=${jar['s_v_web_id']}`);
  return parts.join('; ');
}

// Robustly scrape a TikTok @user page to find a current live roomId (validated)
async function scrapeRoomIdFromWebProfile(user, headers) {
  const urlLive = `https://www.tiktok.com/@${encodeURIComponent(user)}/live`;
  const urlHome = `https://www.tiktok.com/@${encodeURIComponent(user)}`;

  async function grab(url) {
    const r = await _fetch(url, { method: 'GET', headers, redirect: 'follow' });
    const text = await r.text();
    return { ok: r.ok, text, status: r.status };
  }

  // Try /live, then /@user
  for (const url of [urlLive, urlHome]) {
    try {
      const { ok, text } = await grab(url);
      if (!ok || !text) continue;

      // SIGI_STATE JSON blob usually has the LiveRoom info
      const sigi = text.match(/<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
      if (sigi) {
        try {
          const json = JSON.parse(sigi[1]);

          // Look for an explicit flag that the user is live
          const liveRoomId =
            json?.LiveRoom?.liveRoomId ||
            json?.LiveRoom?.roomId ||
            json?.RoomStore?.roomId ||
            null;

          const liveFlag =
            json?.LiveRoom?.isLive === true ||
            json?.LiveRoom?.status === 1 ||
            json?.LiveRoom?.status === 2 ||
            json?.UserLiveState?.isLive === true ||
            null;

          if (liveRoomId) {
            // Double-check with webcast API to avoid stale IDs
            const check = await getWebcastRoomStatus(liveRoomId, { ...headers, Host: 'webcast.tiktok.com' });
            if (check.live) return { roomId: String(liveRoomId), isLive: true };
          }

          // No validated live room; fall through to try a regex, then validate again
          const mm = (JSON.stringify(json).match(/"roomId":"(\d+)"/) || JSON.stringify(json).match(/"room_id":"(\d+)"/));
          const rid = mm ? mm[1] : null;
          if (rid) {
            const check = await getWebcastRoomStatus(rid, { ...headers, Host: 'webcast.tiktok.com' });
            if (check.live) return { roomId: String(rid), isLive: true };
          }
        } catch { /* ignore parse errors and continue */ }
      }

      // Fast path: sometimes the HTML directly contains a current "roomId"
      const m = text.match(/"roomId":"(\d+)"/) || text.match(/"room_id":"(\d+)"/);
      if (m) {
        const rid = m[1];
        const check = await getWebcastRoomStatus(rid, { ...headers, Host: 'webcast.tiktok.com' });
        if (check.live) return { roomId: String(rid), isLive: true };
      }
    } catch { /* ignore and try next */ }
  }

  // If we get here, we couldn't validate any live room
  return { roomId: null, isLive: false };
}

// Check if a roomId is actually live via the webcast API
async function getWebcastRoomStatus(roomId, headers) {
  try {
    const url = `https://webcast.tiktok.com/webcast/room/info/?aid=1988&room_id=${encodeURIComponent(roomId)}`;
    const r = await _fetch(url, {
      method: 'GET',
      headers: { ...headers, Host: 'webcast.tiktok.com', Accept: 'application/json, text/plain, */*' },
      redirect: 'follow'
    });
    const data = await r.json().catch(() => null);
    // Look for status in common places
    const status =
      data?.data?.room_info?.status ??
      data?.roomInfo?.status ??
      data?.room?.status ??
      null;

    // Treat 1 or 2 as "live" (values vary by edge), anything else = offline
    const live = [1, 2].includes(Number(status));
    return { live, status, rawOk: r.ok };
  } catch (e) {
    return { live: false, status: null, error: String(e && e.message || e) };
  }
}


app.get('/tiktok-sse', async (req, res) => {
  setCORS(req, res);

  const user = String(req.query.user || '').trim().toLowerCase();
  if (!user) return res.status(400).json({ error: 'Missing ?user=' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) { /* socket closed */ }
  };
  
  // Report which library is actually in use
	try {
	  send('debug', {
		stage: 'lib',
		module: require.resolve('@qixils/tiktok-live-connector'),
		version: require('@qixils/tiktok-live-connector/package.json').version
	  });
	} catch (e) {
	  send('debug', { stage: 'lib', module: 'unresolved', error: String(e && e.message || e) });
	}

  // Keep the stream open
  const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (_) {} }, 15000);

  const delays = [2000, 5000, 10000, 20000, 30000, 60000];
  let attempt = 0;
  let tiktok = null;
  let closed = false;

  const cleanup = () => {
    clearInterval(keepAlive);
    try { tiktok && tiktok.disconnect(); } catch {}
  };
  req.on('close', () => { closed = true; cleanup(); });

  function schedule(reason) {
    if (closed) return;
    const wait = delays[Math.min(attempt++, delays.length - 1)];
    send('debug', { stage: 'retry', user, inMs: wait, reason });
    setTimeout(() => connect('retry'), wait);
  }

async function connect(trigger) {
  if (closed) return;
  if (tiktok) { try { tiktok.disconnect(); } catch {} tiktok = null; }

  send('debug', { stage: 'attempt', user, trigger });

  // --- Client fingerprint / headers ---
// --- Client fingerprint / headers ---
const referer = `https://www.tiktok.com/@${encodeURIComponent(user)}/live`;
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function makeMsToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let t = '';
  for (let i = 0; i < 107; i++) t += chars[(Math.random() * chars.length) | 0];
  return t;
}
const msToken = makeMsToken();
const sessionId = (process.env.TIKTOK_SESSIONID || '').trim();


// Start with browser-like headers (for cookie fetch + connector)
const baseHeaders = {
  'User-Agent': ua,
  'Referer': referer,
  'Origin': 'https://www.tiktok.com',

  // IMPORTANT: modern hint headers to avoid 4xx on webcast endpoints
  'sec-ch-ua': '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',

  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  'Accept-Encoding': 'gzip, deflate, br',

  // Typical accept set used by the site
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Acquire TikTok cookies (ttwid, odin_tt, etc.)
let extraCookie = '';
try { extraCookie = await getTikTokCookieHeader(user, baseHeaders); } catch {}

// Final Cookie header we’ll use everywhere
const cookieParts = ['msToken=' + msToken, 'tt-web-region=US'];
if (extraCookie) cookieParts.push(extraCookie);
if (sessionId) {
  cookieParts.push('sessionid=' + sessionId);     // primary login cookie
  cookieParts.push('sessionid_ss=' + sessionId);  // secondary key some edges check
}
const cookieHeader = cookieParts.join('; ');

// Single headers object for both scraping and connector requests
const commonHeaders = {
  ...baseHeaders,
  'Cookie': cookieHeader
};

// Webcast endpoints are on a different host; some edges check Host explicitly
const webcastHeaders = {
  ...commonHeaders,
  Host: 'webcast.tiktok.com'
};


  // --- Pre-scrape roomId from public web page to avoid library’s brittle path
  let roomId = null;
  try {
    const scraped = await scrapeRoomIdFromWebProfile(user, commonHeaders);
	if (!scraped || !scraped.roomId || scraped.isLive === false) {
	  send('room', { user, isLive: false });
	  send('status', { state: 'offline', user });
	  return schedule('no-live');
	}

	roomId = scraped.roomId;
	send('room', { user, roomId, isLive: true });

  } catch (e) {
    send('status', { state: 'error', where: 'scrape', error: serializeErr(e) });
    return schedule('scrape');
  }

tiktok = new WebcastPushConnection(user, {
  enableExtendedGiftInfo: false,

  // Some versions read this:
  roomId,
	userAgent: ua,
  sessionId: sessionId || undefined, 

  // Query params appended to the internal HTTP calls
  clientParams: {
    app_language: 'en-US',
    browser_language: 'en-US',
    region: 'US',
    referer,
    device_platform: 'web',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version: '5.0',
    msToken,
	room_id: roomId
  },

  // Axios request options used internally
  requestOptions: {
    timeout: 15000,
    withCredentials: true,
    headers: webcastHeaders   // <- use the webcast host override here
  }
});


// Force our headers/cookies into the connector’s internal axios instances
try {
  if (tiktok && tiktok.http && tiktok.http.defaults) {
    tiktok.http.defaults.withCredentials = true;
    tiktok.http.defaults.headers = {
      ...(tiktok.http.defaults.headers || {}),
      ...webcastHeaders
    };
    if (tiktok.http.defaults.headers.common) {
      Object.assign(tiktok.http.defaults.headers.common, webcastHeaders);
    }
  }
} catch {}

try {
  // Some versions have a nested webcast client
  if (tiktok && tiktok.webcastClient && tiktok.webcastClient.http && tiktok.webcastClient.http.defaults) {
    tiktok.webcastClient.http.defaults.withCredentials = true;
    tiktok.webcastClient.http.defaults.headers = {
      ...(tiktok.webcastClient.http.defaults.headers || {}),
      ...webcastHeaders
    };
    if (tiktok.webcastClient.http.defaults.headers.common) {
      Object.assign(tiktok.webcastClient.http.defaults.headers.common, webcastHeaders);
    }
  }
} catch {}

  // --- events (unchanged)
  tiktok.on('chat', (msg) => {
    send('chat', {
      comment: String(msg.comment || ''),
      uniqueId: msg.uniqueId || '',
      nickname: msg.nickname || ''
    });
  });
  const onDisc = () => { send('status', { state: 'disconnected' }); schedule('disconnected'); };
  const onErr  = (e) => { send('status', { state: 'error', error: serializeErr(e) }); schedule('error'); };
  const onEnd  = () => { send('status', { state: 'ended' }); schedule('streamEnd'); };
  tiktok.on('disconnected', onDisc);
  tiktok.on('error', onErr);
  tiktok.on('streamEnd', onEnd);

// Connect directly with the known room id (fork honors this and skips HTML scraping)
try {
  await tiktok.connect(roomId);     // <- no internal room-id fetch
  attempt = 0;
  send('status', { state: 'connected', user, roomId });
  send('open', { ok: true, user, roomId });
} catch (e) {
  send('status', { state: 'error', where: 'connect', error: serializeErr(e) });
  schedule('connect:reject');
}
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
// Returns JSON: { sourceUrl, format: "markdown", markdown, fetchedAt }
app.get('/twitch-about', async (req, res) => {
  try {
    setCORS(req, res);

    const rawU = String(req.query.u || '').trim();
    if (!rawU || !isTwitchUrl(rawU)) {
      return res.status(400).json({ error: 'Provide ?u= with a twitch.tv URL' });
    }

    const sourceUrl = normalizeTwitchAboutUrl(rawU);
    const jinaUrl = 'https://r.jina.ai/http://' + sourceUrl.replace(/^https?:\/\//i, '');

    const r = await _fetch(jinaUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RelayBot/1.0)',
        'Accept': 'text/plain,*/*;q=0.8'
      },
      redirect: 'follow'
    });

    if (!r.ok) {
      return res.status(502).json({ error: 'upstream_unavailable', status: r.status });
    }

    let rawText = await r.text();
    let markdown = extractMarkdownSection(rawText);

    // (Optional safety) cap extremely large responses to avoid memory spikes
    if (markdown.length > 400_000) markdown = markdown.slice(0, 400_000);

    return res.status(200).json({
      sourceUrl,
      fetchedFrom: 'jina',
      format: 'markdown',
      markdown,
      fetchedAt: new Date().toISOString()
    });
  } catch (e) {
    setCORS(req, res);
    return res.status(503).json({ error: 'twitch_about_unavailable' });
  }
});

/* --------------------------------- Start -------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Relay listening on', PORT));
