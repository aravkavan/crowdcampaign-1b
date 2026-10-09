// Builds the Express app: security headers, CORS, JSON parsing, routes, errors.
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { HttpError } from './lib/http.js';
import { aiRouter } from './routes/ai.js';
import { authRouter } from './routes/auth.js';
import { campaignsRouter } from './routes/campaigns.js';
import { trackerRouter } from './routes/tracker.js';
import { usersRouter } from './routes/users.js';

export function createApp() {
  const app = express();

  // Standard security headers. Responses may be read cross-origin because the
  // frontend lives on another origin; CORS below decides WHICH origins may read them.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  // The frontend (localhost:5173) and this API (localhost:4000) are different origins,
  // so the browser first sends an OPTIONS "preflight" asking permission. Only origins on
  // the allow-list get an Access-Control-Allow-Origin header back. We use Bearer tokens,
  // not cookies, so credentials mode (and SameSite) never comes into play.
  app.use(
    cors({
      origin: (origin, done) => done(null, !origin || config.corsOrigins.includes(origin)),
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600, // browsers may reuse a preflight answer for 10 minutes
    }),
  );

  // A tracker run upload (report plus article log) can be larger than a normal request.
  // Whichever parser runs first reads the body; the second one then skips it.
  app.use('/api/tracker', express.json({ limit: '1mb' }));
  app.use(express.json({ limit: '100kb' }));

  // One line per request in the terminal. Bodies are never logged: they contain passwords.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started} ms)`);
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api', aiRouter);
  app.use('/api/tracker', trackerRouter);

  app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

  // Every error becomes JSON. Details of unexpected errors stay in the server log,
  // never in the response (so nothing internal, like a hash, can leak through an error).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request body is too large.' });
    if (err instanceof HttpError) {
      if (err.status === 401 && !res.get('WWW-Authenticate')) res.set('WWW-Authenticate', 'Bearer realm="crowdcampaign"');
      return res.status(err.status).json({ error: err.message });
    }
    if (err.code === '23505') return res.status(409).json({ error: 'That already exists.' });
    if (err.code === '23503') return res.status(409).json({ error: 'That item changed while you were working. Refresh and try again.' });
    const status = err.status ?? err.statusCode;
    if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(status).json({ error: 'Bad request.' });
    console.error('[error]', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}
