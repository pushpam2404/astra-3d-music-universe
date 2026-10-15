// api/index.js
// Vercel serverless entry: vercel.json rewrites /api/* here, and Express routes on the original URL.
import { createApp } from '../server/app.js';

export default createApp();
