// server/app.js
/** The /api Express app, shared by the local server (server/index.js) and Vercel (api/index.js). */
import express from 'express';
import { apiRouter } from './routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind Vercel's proxy; needed for req.secure / req.protocol.
  app.set('trust proxy', true);
  app.use('/api', apiRouter);
  return app;
}
