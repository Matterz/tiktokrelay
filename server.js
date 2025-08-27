const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();

// Basic homepage (optional)
app.get('/', (_req, res) => res.type('text/plain').send('TikTok SSE relay OK'));

// SSE endpoint: /tiktok-sse?user=keyaogames
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

  async function connect(trigger) {
    if (closed) return;
    if (tiktok) { try { tiktok.disconnect(); } catch {} tiktok = null; }

    writeEvent('debug', { stage: 'attempt', user, trigger });

    tiktok = new WebcastPushConnection(user, { // public data only
      enableExtendedGiftInfo: false
    });

    // forward chat messages
    tiktok.on('chat', (msg) => {
      // keep payload small/consistent with frontend
      writeEvent('chat', {
        comment: String(msg.comment || ''),
        uniqueId: msg.uniqueId || '',
        nickname: msg.nickname || ''
      });
    });

    // reconnect cases
const onDisc = () => { writeEvent('status', { state: 'disconnected' }); schedule('disconnected'); };
const onErr  = (e) => { writeEvent('status', { state: 'error', error: String(e||'') }); schedule('error'); };
const onEnd  = () => { writeEvent('status', { state: 'ended' }); schedule('streamEnd'); };
tiktok.on('disconnected', onDisc);
tiktok.on('error', onErr);
tiktok.on('streamEnd', onEnd);


    try {
      await tiktok.connect();
      attempt = 0; // reset backoff
      writeEvent('open', { ok: true, user });
    } catch (e) {
      schedule('connect:reject');
    }
  }
  
  writeEvent('status', { state: 'connected', user });

  function schedule(reason) {
    if (closed) return;
    const wait = delays[Math.min(attempt++, delays.length - 1)];
    writeEvent('debug', { stage: 'retry', user, inMs: wait, reason });
    setTimeout(() => connect('retry'), wait);
  }

  connect('init');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SSE relay listening on', PORT));
