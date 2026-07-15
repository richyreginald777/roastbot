import * as http from 'http';
import { query } from './db/client';
import { logger } from './utils/logger';

// Render kills Web Services that don't bind a port (Socket Mode is outbound-
// only, so without this server the deploy times out). The /health endpoint
// doubles as a real healthcheck and as the keep-alive ping target.

let slackReady = false;

/** Call once app.start() has resolved so /health reports the truth. */
export function markSlackReady(): void {
  slackReady = true;
}

export function startHealthServer(): void {
  const port = parseInt(process.env.PORT || '3000', 10);

  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      let dbOk = false;
      try {
        await query('SELECT 1');
        dbOk = true;
      } catch {
        // dbOk stays false — reported below
      }

      const healthy = dbOk && slackReady;
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: healthy ? 'ok' : 'degraded',
          slack: slackReady ? 'connected' : 'starting',
          database: dbOk ? 'ok' : 'unreachable',
          uptimeSeconds: Math.floor(process.uptime()),
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('RoastBot is alive and cooking! 🔥\n');
  });

  server.listen(port, () => {
    logger.info(`Health server listening on port ${port} (GET /health)`);
  });
}

// Render free instances spin down after ~15 minutes without INBOUND traffic —
// an open port alone doesn't count, and a spun-down bot drops its Socket Mode
// connection. Pinging our own public URL (Render injects RENDER_EXTERNAL_URL)
// goes through Render's edge, counts as inbound traffic, and prevents the
// spin-down. Off Render (no RENDER_EXTERNAL_URL) this is a no-op.
export function startKeepAlive(): void {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) {
    logger.info('Keep-alive self-ping disabled (RENDER_EXTERNAL_URL not set — not on Render)');
    return;
  }

  const intervalMs = 10 * 60 * 1000; // every 10 min, well inside the ~15 min idle window
  setInterval(() => {
    fetch(`${url}/health`)
      .then((r) => {
        if (!r.ok) logger.warn('Keep-alive ping got non-OK response', { status: r.status });
      })
      .catch((err) => logger.warn('Keep-alive ping failed', { err: String(err) }));
  }, intervalMs);

  logger.info(`Keep-alive self-ping enabled → ${url}/health every 10 min`);
}
