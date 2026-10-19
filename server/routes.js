// server/routes.js
import crypto from 'node:crypto';
import express from 'express';
import { isSpotifyConfigured, getRedirectUri, REQUIRED_SCOPES } from './config.js';
import { getSession, saveSession, destroySession, parseCookies, setCookie } from './sessions.js';
import { buildAuthorizeUrl, exchangeCode, createApi, SpotifyError } from './spotify.js';
import { buildUniverseDataset } from './universeBuilder.js';
import { enrichArtists, toCacheEntry } from './enrich.js';
import { getLocalHistorySummary, getLocalHistoryStatus } from './historyLoader.js';

const STATE_COOKIE = 'astra_oauth_state';

export const apiRouter = express.Router();

apiRouter.get('/auth/status', (req, res) => {
  const session = getSession(req);
  const granted = new Set((session?.scope || '').split(' '));
  const localHistory = getLocalHistoryStatus();
  res.json({
    configured: isSpotifyConfigured(),
    loggedIn: Boolean(session),
    // Sessions from before a scope was added need a fresh login to grant it.
    missingScopes: session ? REQUIRED_SCOPES.filter(s => !granted.has(s)) : [],
    redirectUri: getRedirectUri(req),
    localHistory
  });
});

apiRouter.get('/history/status', (req, res) => {
  res.json(getLocalHistoryStatus());
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

// Background genre lookups for artists the universe load didn't get to.
// Works both when logged into Spotify and when exploring imported streaming history.
const ENRICH_BATCH_MAX = 50;
const ENRICH_BUDGET_MS = 15000;
apiRouter.post('/enrich', express.json({ limit: '500kb' }), async (req, res) => {
  const hasLocalHistory = getLocalHistoryStatus().available;
  if (!getSession(req) && !hasLocalHistory && !req.body?.allowHistoryEnrich) {
    return res.status(401).json({ error: 'Not connected to Spotify.' });
  }
  const artists = (Array.isArray(req.body?.artists) ? req.body.artists : [])
    .filter(a => a && typeof a.id === 'string' && typeof a.name === 'string')
    .slice(0, ENRICH_BATCH_MAX)
    .map(a => ({ id: a.id.slice(0, 64), name: a.name.slice(0, 200), track: typeof a.track === 'string' ? a.track.slice(0, 200) : undefined }));
  const result = await enrichArtists(artists, ENRICH_BUDGET_MS);
  const artistMeta = {};
  result.done.forEach(id => { artistMeta[id] = toCacheEntry(result.meta.get(id)); });
  res.json({ artistMeta, warnings: result.warnings });
});

// POST carries the artist metadata the browser already learned (`knownMeta`) and optional
// browser-imported `historySummary` (or falls back to the local history folder on disk).
apiRouter.post('/universe', express.json({ limit: '25mb' }), universeHandler);
apiRouter.get('/universe', universeHandler);

async function universeHandler(req, res) {
  const session = getSession(req);
  const knownMeta = req.body && typeof req.body.knownMeta === 'object' ? req.body.knownMeta : {};
  const signalsOnly = Boolean(req.body?.signalsOnly || req.query?.signalsOnly);
  const spotifyApiOnly = Boolean(req.body?.spotifyApiOnly || req.query?.spotifyApiOnly);
  const clientHistory = !spotifyApiOnly && req.body?.historySummary?.isAstraHistorySummary ? req.body.historySummary : null;
  const useLocal = !spotifyApiOnly && req.body?.useLocalHistory !== false && !signalsOnly;
  const historySummary = clientHistory || (useLocal ? getLocalHistorySummary() : null);

  if (!session && !historySummary) {
    return res.status(401).json({ error: 'Not connected to Spotify and no streaming history loaded.' });
  }

  try {
    const api = session ? createApi(session, (s) => saveSession(req, res, s)) : null;
    const result = await buildUniverseDataset(api, { knownMeta, historySummary, signalsOnly, spotifyApiOnly });
    if (!signalsOnly) {
      console.log('[universe]', JSON.stringify(result.diagnostics));
    }
    res.json(result);
  } catch (err) {
    console.error('[universe] failed:', err.status, err.endpoint, err.message);
    if (err instanceof SpotifyError) {
      if (err.status === 400 && err.endpoint === '/api/token') {
        destroySession(req, res);
        return res.status(401).json({ error: 'Spotify session expired. Please reconnect.' });
      }
      if (err.status === 403) {
        return res.status(403).json({
          error: 'Spotify refused access (403). In Development Mode, your Spotify account must be added under ' +
            'User Management in the developer dashboard, and the app owner needs an active Premium subscription.'
        });
      }
      if (err.status === 429) {
        const min = Math.max(1, Math.ceil((err.retryAfterSec || 60) / 60));
        const wait = min >= 90 ? `about ${Math.round(min / 60)} hours` : `about ${min} minute${min === 1 ? '' : 's'}`;
        console.error('[universe] rate limited, Retry-After', err.retryAfterSec, 's');
        return res.status(429).json({
          error: `Spotify is limiting requests from Astra for now. Your map will load again in ${wait}; reloading before then makes the wait longer.`
        });
      }
      return res.status(502).json({ error: `Spotify API error ${err.status} on ${err.endpoint}: ${err.message}` });
    }
    res.status(500).json({ error: 'Failed to build universe.' });
  }
}
