// server/routes.js
import crypto from 'node:crypto';
import express from 'express';
import { isSpotifyConfigured, getRedirectUri } from './config.js';
import { getSession, saveSession, destroySession, parseCookies, setCookie } from './sessions.js';
import { buildAuthorizeUrl, exchangeCode, createApi, SpotifyError } from './spotify.js';
import { buildUniverseDataset } from './universeBuilder.js';

const STATE_COOKIE = 'astra_oauth_state';
const TIME_RANGES = new Set(['short_term', 'medium_term', 'long_term']);

export const apiRouter = express.Router();

apiRouter.get('/auth/status', (req, res) => {
  res.json({
    configured: isSpotifyConfigured(),
    loggedIn: Boolean(getSession(req)),
    redirectUri: getRedirectUri(req)
  });
});

apiRouter.get('/auth/login', (req, res) => {
  if (!isSpotifyConfigured()) {
    return res.redirect('/?auth_error=' + encodeURIComponent('Server is missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (.env locally, Environment Variables on Vercel)'));
  }
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(req, res, STATE_COOKIE, state, { maxAgeSec: 600 });
  res.redirect(buildAuthorizeUrl(state, getRedirectUri(req)));
});

apiRouter.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = parseCookies(req)[STATE_COOKIE];
  setCookie(req, res, STATE_COOKIE, '', { maxAgeSec: 0 });

  if (error) return res.redirect('/?auth_error=' + encodeURIComponent(String(error)));
  if (!code || !state || state !== expectedState) {
    return res.redirect('/?auth_error=' + encodeURIComponent('OAuth state mismatch; please try connecting again.'));
  }
  try {
    saveSession(req, res, await exchangeCode(String(code), getRedirectUri(req)));
    res.redirect('/');
  } catch (err) {
    console.error('[auth] token exchange failed:', err.message);
    res.redirect('/?auth_error=' + encodeURIComponent(`Token exchange failed: ${err.message}`));
  }
});

apiRouter.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

apiRouter.get('/universe', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not connected to Spotify.' });

  const timeRange = TIME_RANGES.has(req.query.time_range) ? req.query.time_range : 'medium_term';
  try {
    const result = await buildUniverseDataset(createApi(session, (s) => saveSession(req, res, s)), timeRange);
    console.log('[universe]', JSON.stringify(result.diagnostics));
    res.json(result);
  } catch (err) {
    console.error('[universe] failed:', err.status, err.endpoint, err.message);
    if (err instanceof SpotifyError) {
      if (err.status === 400 && err.endpoint === '/api/token') {
        // Refresh token revoked or invalid.
        destroySession(req, res);
        return res.status(401).json({ error: 'Spotify session expired. Please reconnect.' });
      }
      if (err.status === 403) {
        return res.status(403).json({
          error: 'Spotify refused access (403). In Development Mode, your Spotify account must be added under ' +
            'User Management in the developer dashboard, and the app owner needs an active Premium subscription.'
        });
      }
      return res.status(502).json({ error: `Spotify API error ${err.status} on ${err.endpoint}: ${err.message}` });
    }
    res.status(500).json({ error: 'Failed to build universe.' });
  }
});
