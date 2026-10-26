// server/app.js
/** The /api Express app, shared by the local server (server/index.js) and Vercel (api/index.js). */
import express from 'express';
import { apiRouter } from './routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // One hop (Vercel's proxy); needed for req.secure / req.protocol and for per-IP rate limits.
  app.set('trust proxy', 1);
  app.use('/api', apiRouter);
  // Bad JSON or an oversized body should read as a client error, not an HTML 500 page.
  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, req, res, _next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[api]', err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong.' : err.type === 'entity.too.large' ? 'Request body is too large.' : 'Bad request.' });
  });
  return app;
}
