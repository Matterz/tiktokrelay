const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();

// Basic homepage (optional)
app.get('/', (_req, res) => res.type('text/plain').send('TikTok SSE relay OK'));

// SSE endpoint: /tiktok-sse?user=keyaogames
app.get('/tiktok-sse', async (req, res) => {
  const user = String(req.query.user || '').trim().toLowerCase().replace(/^@+/, '');
  if (!user) return res.status(400).json({ error: 'Missing ?user=' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // keep-alive ping so proxies don’t close the stream
  const keepAlive = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 15000);

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  };

  // Backoff for reconnects when not live yet
  const delays = [2000, 5000, 10000, 20000, 30000, 60000];
  let attempt = 0;

  let conn = null;
  let closed = false;

  function cleanup() {
    clearInterval(keepAlive);
    try { conn && conn.disconnect(); } catch {}
  }

  req.on('close', () => { closed = true; cleanup(); });

  function schedule(reason) {
    if (closed) return;
    const wait = delays[Math.min(attempt++, delays.length - 1)];
    send('debug', { stage: 'retry', user, inMs: wait, reason });
    setTimeout(() => connect('retry'), wait);
  }

  async function connect(trigger) {
    if (closed) return;
    if (conn) { try { conn.disconnect(); } catch {} conn = null; }

    send('debug', { stage: 'attempt', user, trigger });

    conn = new WebcastPushConnection(user, { enableExtendedGiftInfo: false });

    conn.on('chat', (msg) => {
      send('chat', {
        comment: String(msg.comment || ''),
        uniqueId: msg.uniqueId || '',
        nickname: msg.nickname || ''
      });
    });

    const onDisc = () => schedule('disconnected');
    const onErr  = () => schedule('error');
    const onEnd  = () => schedule('streamEnd');
    conn.on('disconnected', onDisc);
    conn.on('error', onErr);
    conn.on('streamEnd', onEnd);

    try {
      await conn.connect();
      attempt = 0; // reset backoff
      send('status', { state: 'connected', user });
    } catch (e) {
      schedule('connect-failed');
    }
  }

  connect('init');
});

// Render provides PORT via env
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('TikTok SSE relay listening on', PORT));
