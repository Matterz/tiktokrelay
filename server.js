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

/// --- System-level redaction (applies to ALL platforms) ---------------------
function usernameFromAnyUrl(u) {
  try {
    const s = String(u || '');
    const m = s.match(/^(?:https?:)?\/\/([^\/?#]+)\/([^\/?#]+)/i);
    if (!m) return '';
    const host = m[1].toLowerCase();
    let user = m[2] || '';

    // Normalize key platforms
    if (/youtube\.com$/.test(host)) {
      const at = s.match(/youtube\.com\/@([^\/?#]+)/i);
      if (at) user = at[1];
      else {
        const ch = s.match(/youtube\.com\/channel\/([^\/?#]+)/i);
        if (ch) user = ch[1];
      }
    } else if (/tiktok\.com$/.test(host)) {
      const tt = s.match(/tiktok\.com\/@([^\/?#]+)/i);
      if (tt) user = tt[1];
    }
    // twitch, kick, etc. already use first path segment
    user = String(user || '').replace(/^@/, '');
    return user;
  } catch { return ''; }
}

function redactionTokensFromUsername(username) {
  const out = new Set();
  const orig = String(username || '');
  const base = orig.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!base) return [];

  // Full squashed handle
  out.add(base);

  // Sliding substrings length 4..8 (keeps behavior you liked from Twitch)
  const maxLen = Math.min(8, base.length);
  for (let L = maxLen; L >= 4; L--) {
    for (let i = 0; i + L <= base.length; i++) out.add(base.slice(i, i + L));
  }

  // CamelCase/number parts length ≥4 (e.g., "Maximilian", "dood")
  const parts = (orig.match(/[A-Z]?[a-z]+|[0-9]+|[A-Z]+(?![a-z])/g) || []).map(s => s.toLowerCase());
  for (const p of parts) if (p.length >= 4) out.add(p);

  // Longest first to avoid partial-overlap issues
  return Array.from(out).sort((a, b) => b.length - a.length);
}

function redactBylineSystem(text, sourceUrl) {
  let out = String(text || '');

  // Emails → ****
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '****');

  // Links/URLs → ****
  out = out.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '****');

  // Username-derived tokens → ****  (same strategy across platforms)
  const user = usernameFromAnyUrl(sourceUrl);
  if (user) {
    const toks = redactionTokensFromUsername(user);
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

function clamp200(s){
  const t = String(s).trim();
  if (t.length <= 200) return t;
  return t.slice(0, 200).replace(/\s+\S*$/, '') + '…';
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
// YouTube (About): "Description" → (Links | More info | Sign in | next heading | meta lines)
// If nothing meaningful remains, return '' so the route 204s.
function extractYouTubeMainByline(markdown, sourceUrl) {
  const md = unwrapJina(markdown).replace(/\r\n/g, '\n');

  const lines = md.split('\n');
  const isHr = (s) => /^\s*-{3,}\s*$/.test(s || '');
  const norm = (s) => String(s || '').trim();

  const startsWithWord = (s, word) =>
    new RegExp(`^\\s*(?:#{0,6}\\s*|-{3,}\\s*)?${word}\\b`, 'i').test(norm(s));

  const isHeadingLine = (s, word) => startsWithWord(s, word);
  const isAnyHeading = (s) => /^\s*#{2,6}\s+\S/.test(norm(s)); // next markdown heading

  // Lines that must end the description block even if not true headings
  const SECTION_WORDS = [
    'Links', 'Stats', 'Details', 'Business', 'Contact', 'Email', 'Location',
    'Country', 'Shop', 'Store', 'Join', 'Membership', 'Creator'
  ];
  const isSectionBoundary = (s) => SECTION_WORDS.some(w => startsWithWord(s, w));

  // Lines that begin "More info"/"Sign in"/"Log in" (even with trailing text)
  const isStopLine = (s) => /^\s*(more info|sign in|log in)\b/i.test(norm(s));

  // Meta/data lines we never want in a byline
  const isMetaLine = (s) => {
    const t = norm(s);
    if (!t) return false;
    if (/^share channel\b/i.test(t)) return true;
    if (/^joined\b/i.test(t)) return true;
    if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*$/.test(t)) return false; // country names alone: handle later
    if (/^\d[\d.,]*\s*[kKmM]?\s*(subscribers|views|videos)\b/i.test(t)) return true;
    // Frequently-seen country words after Description when no byline exists:
    if (/^\s*(United States|United Kingdom|Canada|Australia|India)\s*$/i.test(t)) return true;
    return false;
  };

  const isBracketOnly = (s) => /^\s*\[[^\]]*\]\s*$/.test(String(s || ''));

  // --- find start (Description) ---
  let startLine = -1;
  let inlineAfter = '';

  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i] || '';

    // "---- Description ..." same line
    if (/^\s*-{3,}\s*Description\b/i.test(cur)) {
      inlineAfter = cur.replace(/^\s*-{3,}\s*Description\b[:\s-]*/i, '').trim();
      startLine = i + 1;
      break;
    }

    // HR line then "Description"
    if (isHr(cur) && i + 1 < lines.length && isHeadingLine(lines[i + 1], 'Description')) {
      const next = lines[i + 1];
      inlineAfter = String(next).replace(/^\s*(?:#{0,6}\s*)?Description\b[:\s-]*/i, '').trim();
      startLine = i + 2;
      break;
    }

    // Plain "Description" (optional ###)
    if (isHeadingLine(cur, 'Description')) {
      inlineAfter = cur.replace(/^\s*(?:#{0,6}\s*)?Description\b[:\s-]*/i, '').trim();
      startLine = i + 1;
      break;
    }
  }
  if (startLine < 0) return '';

  // --- find end boundary ---
  let endLine = lines.length;
  for (let j = startLine; j < lines.length; j++) {
    const cur = lines[j] || '';
    if (
      isSectionBoundary(cur) ||
      isStopLine(cur) ||
      isAnyHeading(cur) ||
      isMetaLine(cur) ||
      isHeadingLine(cur, 'Links') || /^\s*-{3,}\s*Links\b/i.test(cur)
    ) {
      endLine = j;
      break;
    }
  }

  // --- slice & clean block ---
  let blockLines = lines.slice(startLine, endLine)
    .map(norm)
    .filter(Boolean)
    .filter(s => !isStopLine(s))     // "More info...", "Sign in...", etc.
    .filter(s => !isMetaLine(s))     // Joined / subs / views / videos / Share channel / country
    .filter(s => !isBracketOnly(s))  // pure bracket remnants like "[Sign in]"
    .filter(s => !isHr(s));          // stray horizontal rules

  if (inlineAfter) blockLines.unshift(inlineAfter);

  // Collapse to a single line
  let body = blockLines.join(' ').replace(/\s+/g, ' ').trim();

  // If nothing meaningful, return '' so the route 204s
  if (!/[A-Za-z0-9]/.test(body)) return '';

  // Strip artifacts (some will already be gone, this is belt & suspenders)
  body = body
    .replace(/(?:\.{3}|…)\s*more/gi, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')               // [text](url)
    .replace(/\((?:https?:\/\/|www\.)[^)]+\)/gi, ' ')   // (http...)
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')       // bare URLs
    .replace(/\[\s*\]/g, ' ')                           // stray "[]"
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();

  // System-wide redaction (emails, URLs, username-derived tokens)
  body = redactBylineSystem(body, sourceUrl);

  // Polish + clamp (200 everywhere)
  body = body.replace(/^(.{8,160}?)(?:\s+\1)+/i, '$1');
  body = dedupeSentences(body);
  body = dedupeHead(body);
  body = stripMaskedTail(body);

  return clamp200(body);
}


function extractTwitchAboutByline(markdown, sourceUrl) {
  const md = unwrapJina(markdown);

  // 1) Jump to the "### About" section to avoid nav/header noise
  const aboutMatch = md.match(/^\s*###\s+About\b[^\n]*$/im);
  const startAt = aboutMatch ? md.indexOf(aboutMatch[0]) + aboutMatch[0].length : 0;
  const tail = md.slice(startAt);

  // 2) Find the followers line AFTER the About heading
  const followersRe = /(^|\n)\s*\d[\d.,]*\s*[kKmM]?\s*followers\b[^\S\r\n]*\n+/i;
  const m = followersRe.exec(tail);
  if (!m) {
    // Fallback: generic cleanup
    const cleaned = tail
      .replace(/\*\*\s*·\s*\*\*/g, ' ')
      .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const red = redactBylineSystem(cleaned, sourceUrl);
    return clamp200(red);
  }
  let pos = m.index + m[0].length;

  // 3) End boundary: first [![ (panel image) OR next "###" heading OR end
  const after = tail.slice(pos);
  const endImg = after.indexOf('[![');
  const endHeading = after.search(/\n{2,}###\s+/);
  let end = after.length;
  if (endImg !== -1) end = Math.min(end, endImg);
  if (endHeading !== -1) end = Math.min(end, endHeading);

  // 4) Slice block and clean it
  let block = after.slice(0, end)
    .replace(/\*\*\s*·\s*\*\*/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/\((?:https?:\/\/|www\.)[^)]+\)/gi, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  // 5) First meaningful non-empty line
  const lines = block.split(/\n+/).map(s => s.trim()).filter(Boolean);
  let byline = lines.find(s => s && !/^(?:[-–•·]+|\*+)$/.test(s)) || '';

  // 🔒 System-wide redaction + polish + clamp
  byline = redactBylineSystem(byline, sourceUrl);
  byline = dedupeSentences(byline);
  byline = dedupeHead(byline);
  byline = stripMaskedTail(byline);
  return clamp200(byline);
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

  best = redactBylineSystem(best, '');      // apply system-wide redaction
  best = dedupeSentences(best);
  best = dedupeHead(best);
  best = stripMaskedTail(best);
  return clamp200(best);
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

    // Only known platforms (YouTube, Twitch, Kick)
    const isKnownHost = /^(https?:)?\/\/(?:www\.)?(youtube\.com|twitch\.tv|kick\.com)\b/i.test(rawUrl);
    if (!isKnownHost) return res.status(400).type('text/plain').send('Unsupported host'); // was const ok

    // Normalize and set up YouTube About → Main fallback
    const isYT = /youtube\.com/i.test(rawUrl);
    if (isYT) {
      rawUrl = rawUrl.replace(/[?#].*$/, '').replace(/\/$/, '');
    }

    const rawFlag   = String(req.query.raw   || '') === '1';
    const debugFlag = String(req.query.debug || '') === '1';

    // Build candidate URLs: YouTube = About page only (no main fallback)
	let candidates = [rawUrl];
	if (isYT) {
	  const base = rawUrl.replace(/\/about(?:$|[\/?#].*)/i, '');
	  candidates = [base + '/about'];
	}

    let usedUrl = null;
    let md = '';
    let fetchedOk = false;  // was "let ok = false"

    // Try candidates until one succeeds
    for (const u of candidates) {
      const target = u.replace(/^https?:\/\//i, '');
      const jina   = 'https://r.jina.ai/http://' + target;

      const r = await _fetch(jina, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'user-agent': 'byline-proxy/1.0', 'accept-language': 'en-US,en;q=0.9' }
      });

      if (!r.ok) continue;

      usedUrl = u;
      md = await r.text();
      fetchedOk = true;     // was "ok = true"
      break;
    }

    if (!fetchedOk) {       // was "if (!ok)"
      setCORS(req, res);
      return res.status(502).type('text/plain').send('Fetch failed');
    }

    // Return the raw Jina text for debugging when ?raw=1
    if (rawFlag) {
      if (md.length > 400_000) md = md.slice(0, 400_000);
      res.set('Cache-Control', 'no-store');
      setCORS(req, res);
      return res.type('text/plain').send(md);
    }

    // Avoid huge strings causing memory spikes
    if (md.length > 400_000) md = md.slice(0, 400_000);

    // IMPORTANT: pass the actual URL we used (About or Main) so the extractor knows
    const byline = extractBylineFor(usedUrl || rawUrl, md);

    if (!byline) {
      if (debugFlag) {
        setCORS(req, res);
        return res.status(200).json({
          note: 'no-byline',
          usedUrl: usedUrl || rawUrl,
          length: md.length
        });
      }
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

// Robustly scrape a TikTok @user page to find the current roomId.
// If opts.validate === false, we trust the page and return the first roomId found
// without calling the webcast API. Also returns streamId + pageLive + regionHint.
async function scrapeRoomIdFromWebProfile(user, headers, opts = { validate: true }) {
  const urlLive = `https://www.tiktok.com/@${encodeURIComponent(user)}/live`;
  const urlHome = `https://www.tiktok.com/@${encodeURIComponent(user)}`;

  async function grab(url) {
    const r = await _fetch(url, { method: 'GET', headers, redirect: 'follow' });
    const text = await r.text();
    return { ok: r.ok, text, status: r.status };
  }

  const candidates = [];
  let seenStreamId = null;
  let pageSaysLive = null;
  let regionHint = null;

  for (const url of [urlLive, urlHome]) {
    try {
      const { ok, text } = await grab(url);
      if (!ok || !text) continue;

      // Heuristic for region: look for CDN hosts in the HTML quickly
      if (!regionHint) {
        if (/\btiktokcdn-eu\.com\b/i.test(text)) regionHint = 'EU';
        else if (/\btiktokcdn-us\.com\b/i.test(text) || /-us\.tiktokcdn/i.test(text)) regionHint = 'US';
      }

      const sigi = text.match(/<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
      if (sigi) {
        try {
          const json = JSON.parse(sigi[1]);

          // RoomId sources
          const userRoomId = json?.LiveRoom?.liveRoomUserInfo?.user?.roomId;
          if (userRoomId) candidates.push(String(userRoomId));
          if (json?.LiveRoom?.liveRoomId) candidates.push(String(json.LiveRoom.liveRoomId));
          if (json?.LiveRoom?.roomId) candidates.push(String(json.LiveRoom.roomId));
          if (json?.RoomStore?.roomId) candidates.push(String(json.RoomStore.roomId));

          // Is page showing "live"?
          const roomStatus     = json?.LiveRoom?.liveRoom?.status;
          const pageUserStatus = json?.LiveRoom?.liveRoomUserInfo?.user?.status;
          const isLive =
            roomStatus === 1 || roomStatus === 2 ||
            pageUserStatus === 1 || pageUserStatus === 2 ||
            json?.LiveRoom?.isLive === true ||
            json?.UserLiveState?.isLive === true || null;
          pageSaysLive = Boolean(isLive);

          // Stream id (diagnostics only)
          if (json?.LiveRoom?.streamId) seenStreamId = String(json.LiveRoom.streamId);

          // Fallback roomId regex
          const j = JSON.stringify(json);
          let m = j.match(/"roomId":"(\d+)"/) || j.match(/"room_id":"(\d+)"/);
          if (m) candidates.push(m[1]);

          // Region hint inside JSON (HLS/FLV urls)
          if (!regionHint) {
            if (/\btiktokcdn-eu\.com\b/i.test(j)) regionHint = 'EU';
            else if (/\btiktokcdn-us\.com\b/i.test(j) || /-us\.tiktokcdn/i.test(j)) regionHint = 'US';
          }
        } catch { /* keep scanning */ }
      }

      // Last-ditch: regex over HTML
      let mHtml = text.match(/"roomId":"(\d+)"/) || text.match(/"room_id":"(\d+)"/);
      if (mHtml) candidates.push(mHtml[1]);

      if (candidates.length) break; // stop after first page that yields candidates
    } catch { /* try next URL */ }
  }

  const uniq = Array.from(new Set(candidates));
  if (!uniq.length) return { roomId: null, streamId: seenStreamId, pageLive: false, isLive: false, regionHint, from: null };

  if (opts.validate === false) {
    return { roomId: uniq[0], streamId: seenStreamId, pageLive: pageSaysLive ?? true, isLive: pageSaysLive ?? true, regionHint, from: 'page-trust' };
  }

  // Validate candidates via webcast
  for (const rid of uniq) {
    try {
      const check = await getWebcastRoomStatus(rid, { ...headers, Host: 'webcast.tiktok.com' });
      if (check && check.live) {
        return { roomId: rid, streamId: seenStreamId, pageLive: pageSaysLive, isLive: true, regionHint, from: 'validated' };
      }
    } catch { /* try next candidate */ }
  }

  return { roomId: uniq[0], streamId: seenStreamId, pageLive: pageSaysLive, isLive: false, regionHint, from: 'unvalidated' };
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

  const baseHeaders = {
    'User-Agent': ua,
    'Referer': referer,
    'Origin': 'https://www.tiktok.com',
    'sec-ch-ua': '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  // Acquire TikTok cookies (ttwid, odin_tt, etc.)
  let extraCookie = '';
  try { extraCookie = await getTikTokCookieHeader(user, baseHeaders); } catch {}

  // Build initial cookie as US; we may switch to EU after scraping if needed
  const cookieParts = ['msToken=' + msToken, 'tt-web-region=US'];
  if (extraCookie) cookieParts.push(extraCookie);
  if (sessionId) {
    cookieParts.push('sessionid=' + sessionId);
    cookieParts.push('sessionid_ss=' + sessionId);
  }
  const cookieHeaderUS = cookieParts.join('; ');

  // These headers are used for the initial scrape
  const commonHeaders = { ...baseHeaders, Cookie: cookieHeaderUS };

  // --- Pre-scrape roomId from public web page ---
  const trust = String(req.query.trust || '') === '1';
  const force = String(req.query.force || '') === '1';
  let roomId = null;
  let scraped;

  try {
    scraped = await scrapeRoomIdFromWebProfile(user, commonHeaders, { validate: !trust });
    send('debug', { stage: 'room-scrape', user, scraped });

    const shouldConnect =
      scraped && scraped.roomId &&
      (trust || force || scraped.isLive === true || scraped.pageLive === true);

    if (!shouldConnect) {
      send('room', { user, isLive: false });
      send('status', { state: 'offline', user, reason: 'scrape-validate-failed', trust, pageLive: scraped?.pageLive ?? null });
      return schedule('no-live');
    }

    roomId = scraped.roomId;
    send('room', { user, roomId, isLive: true, trust, pageLive: scraped.pageLive === true });
  } catch (e) {
    send('status', { state: 'error', where: 'scrape', error: serializeErr(e) });
    return schedule('scrape');
  }

  // --- Region selection (US default; EU if hinted or forced) ---
  const qpRegion = String(req.query.region || '').trim().toUpperCase();       // allow ?region=EU
  let selectedRegion = qpRegion || (scraped.regionHint || '').toUpperCase() || 'US';
  if (!/^(US|EU)$/.test(selectedRegion)) selectedRegion = 'US';

  let activeCookieHeader = cookieHeaderUS;
  if (!activeCookieHeader.includes(`tt-web-region=${selectedRegion}`)) {
    activeCookieHeader = activeCookieHeader.replace(/tt-web-region=(US|EU)/, `tt-web-region=${selectedRegion}`);
  }
  const activeWebcastHeaders = { ...baseHeaders, Cookie: activeCookieHeader, Host: 'webcast.tiktok.com' };
  send('debug', { stage: 'region', selected: selectedRegion, hinted: scraped.regionHint || null });

  /* --- Create the connector with the scraped roomId --- */
  tiktok = new WebcastPushConnection(user, {
    roomId,
    userAgent: ua,
    sessionId: sessionId || undefined,
    clientParams: { room_id: roomId },
    requestOptions: {
      withCredentials: true,
      headers: activeWebcastHeaders,
      timeout: 15000
    }
  });

  /* (Optional) still force headers into any internal axios instances if present */
  try {
    if (tiktok.http?.defaults) {
      tiktok.http.defaults.withCredentials = true;
      tiktok.http.defaults.headers = { ...(tiktok.http.defaults.headers || {}), ...activeWebcastHeaders };
      if (tiktok.http.defaults.headers.common) Object.assign(tiktok.http.defaults.headers.common, activeWebcastHeaders);
    }
    if (tiktok.webcastClient?.http?.defaults) {
      tiktok.webcastClient.http.defaults.withCredentials = true;
      tiktok.webcastClient.http.defaults.headers = { ...(tiktok.webcastClient.http.defaults.headers || {}), ...activeWebcastHeaders };
      if (tiktok.webcastClient.http.defaults.headers.common) Object.assign(tiktok.webcastClient.http.defaults.headers.common, activeWebcastHeaders);
    }
  } catch {}

  /* --- events --- */
  tiktok.on('chat', (msg) => {
    send('chat', { comment: String(msg.comment || ''), uniqueId: msg.uniqueId || '', nickname: msg.nickname || '' });
  });
  const onDisc = () => { send('status', { state: 'disconnected' }); schedule('disconnected'); };
  const onErr  = (e) => { send('status', { state: 'error', error: serializeErr(e) }); schedule('error'); };
  const onEnd  = () => { send('status', { state: 'ended' }); schedule('streamEnd'); };
  tiktok.on('disconnected', onDisc);
  tiktok.on('error', onErr);
  tiktok.on('streamEnd', onEnd);

  /* --- connect --- */
  try {
    await tiktok.connect();     // no arg; roomId provided in constructor
    attempt = 0;
    send('status', { state: 'connected', user, roomId, region: selectedRegion });
    send('open',   { ok: true, user, roomId, region: selectedRegion });
  } catch (e) {
    send('status', { state: 'error', where: 'connect', error: serializeErr(e) });
    schedule('connect:reject');
  }
}

// --- Pre-scrape roomId from public web page ---
// Add ?trust=1 to bypass webcast validation if the page shows a live room.
// Add ?force=1 to always try connecting when a roomId is present.
const trust = String(req.query.trust || '') === '1';
const force = String(req.query.force || '') === '1';
let roomId = null;

try {
  const scraped = await scrapeRoomIdFromWebProfile(user, commonHeaders, { validate: !trust });
  send('debug', { stage: 'room-scrape', user, scraped });

  const shouldConnect =
    scraped && scraped.roomId &&
    (trust || force || scraped.isLive === true || scraped.pageLive === true);

  if (!shouldConnect) {
    send('room', { user, isLive: false });
    send('status', { state: 'offline', user, reason: 'scrape-validate-failed', trust, pageLive: scraped?.pageLive ?? null });
    return schedule('no-live');
  }

  roomId = scraped.roomId;
  send('room', { user, roomId, isLive: true, trust, pageLive: scraped.pageLive === true });
} catch (e) {
  send('status', { state: 'error', where: 'scrape', error: serializeErr(e) });
  return schedule('scrape');
}


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

/* --- Create the connector with the scraped roomId --- */
tiktok = new WebcastPushConnection(user, {
  roomId,                 // ⬅️ this tells the lib to connect to this exact room
  userAgent: ua,          // pass-through UA
  sessionId: sessionId || undefined,  // optional: your login cookie if set

  // belt & suspenders: also surface the room id in client params used by some edges
  clientParams: { room_id: roomId },

  // Make sure every internal request uses our headers/cookies
  requestOptions: {
    withCredentials: true,
    headers: webcastHeaders,
    timeout: 15000
  }
});

/* (Optional) still force headers into any internal axios instances if present */
try {
  if (tiktok.http?.defaults) {
    tiktok.http.defaults.withCredentials = true;
    tiktok.http.defaults.headers = { ...(tiktok.http.defaults.headers || {}), ...webcastHeaders };
    if (tiktok.http.defaults.headers.common) Object.assign(tiktok.http.defaults.headers.common, webcastHeaders);
  }
  if (tiktok.webcastClient?.http?.defaults) {
    tiktok.webcastClient.http.defaults.withCredentials = true;
    tiktok.webcastClient.http.defaults.headers = { ...(tiktok.webcastClient.http.defaults.headers || {}), ...webcastHeaders };
    if (tiktok.webcastClient.http.defaults.headers.common) Object.assign(tiktok.webcastClient.http.defaults.headers.common, webcastHeaders);
  }
} catch {}

/* --- events --- */
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

/* --- connect --- */
try {
  await tiktok.connect();          // ⬅️ no arg; roomId was provided in constructor
  attempt = 0;
  send('status', { state: 'connected', user, roomId });
  send('open',   { ok: true, user, roomId });
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
    let markdown = unwrapJina(rawText);

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

// GET /debug/tiktok?user=<handle>
// Scrapes the page (no auth) and also calls webcast status (if possible).
app.get('/debug/tiktok', async (req, res) => {
  try {
    setCORS(req, res);
    const user = String(req.query.user || '').trim().toLowerCase();
    if (!user) return res.status(400).json({ error: 'Missing ?user=' });

    const referer = `https://www.tiktok.com/@${encodeURIComponent(user)}/live`;
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
    const baseHeaders = {
      'User-Agent': ua, 'Referer': referer, 'Origin': 'https://www.tiktok.com',
      'sec-ch-ua': '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
      'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
      'Accept-Encoding': 'gzip, deflate, br', 'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    let extraCookie = '';
    try { extraCookie = await getTikTokCookieHeader(user, baseHeaders); } catch {}
    const msToken = Array.from({length:107},()=> 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[(Math.random()*62)|0]).join('');
    const cookieHeader = ['msToken=' + msToken, 'tt-web-region=US', extraCookie].filter(Boolean).join('; ');
    const commonHeaders = { ...baseHeaders, Cookie: cookieHeader };

    const scrapedNoValidate = await scrapeRoomIdFromWebProfile(user, commonHeaders, { validate: false });
    let webcast = null;
    if (scrapedNoValidate.roomId) {
      webcast = await getWebcastRoomStatus(scrapedNoValidate.roomId, { ...commonHeaders, Host: 'webcast.tiktok.com' });
    }

    return res.json({ user, scrapedNoValidate, webcast, hadCookies: Boolean(extraCookie) });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
});

/* --------------------------------- Start -------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Relay listening on', PORT));
