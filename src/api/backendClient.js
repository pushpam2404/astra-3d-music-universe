// src/api/backendClient.js
/**
 * Thin client for the ASTRA backend (server/). Spotify tokens never reach the browser.
 * When browser-imported `historySummary` is present, universe merging & clustering runs
 * directly in the browser so multi-megabyte history payloads never hit serverless
 * request/response limits (HTTP 413 on Vercel).
 */
import { mergeSignalsAndRank, assembleUniverseFromSignals } from '../etl/universeAssembler.js';

export const SPOTIFY_LOGIN_URL = '/api/auth/login';

const INITIAL_CLIENT_ENRICH_BATCH = 50;
const INITIAL_CLIENT_ENRICH_CONCURRENCY = 3; // Top 150 artists enriched in parallel (~2.5 KB/req) before first render
const MAX_POST_KNOWN_META = 1200;

async function requestJson(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Keeps knownMeta payload well under serverless body limits (< 60 KB). */
function compactKnownMetaForPost(knownMeta = {}) {
  const entries = Object.entries(knownMeta || {});
  if (entries.length <= MAX_POST_KNOWN_META) return knownMeta;
  entries.sort((a, b) => {
    const aHas = Array.isArray(a[1]?.g) && a[1].g.length ? 1 : 0;
    const bHas = Array.isArray(b[1]?.g) && b[1].g.length ? 1 : 0;
    if (bHas !== aHas) return bHas - aHas;
    return (Number(b[1]?.t) || 0) - (Number(a[1]?.t) || 0);
  });
  return Object.fromEntries(entries.slice(0, MAX_POST_KNOWN_META));
}

export async function getAuthStatus() {
  try {
    return await requestJson('/api/auth/status');
  } catch {
    // Backend not running (e.g. plain `vite` dev server); presets and client history still work.
    return { configured: false, loggedIn: false, backendUnavailable: true };
  }
}

export async function getHistoryStatus() {
  try {
    return await requestJson('/api/history/status');
  } catch {
    return { available: false };
  }
}

/** Looks up genres for up to 50 artists; resolves to { artistMeta, warnings }. */
export function enrichArtists(artists) {
  return requestJson('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artists, allowHistoryEnrich: true })
  });
}

/**
 * Builds the complete universe directly in the browser when `historySummary` is present,
 * fetching only lightweight live Spotify signals (if logged in) and small `/api/enrich`
 * genre batches (~2 KB each) so request bodies never exceed a few kilobytes.
 */
async function buildBrowserHistoryUniverse(
  knownMeta = {},
  { historySummary, loggedIn = false, skipInitialEnrich = false, spotifyApiOnly = false } = {}
) {
  const diagnostics = { warnings: [], clientBuilt: true };
  let liveSignals = {
    topArtistsByRange: [[], [], []],
    topTracksByRange: [[], [], []],
    recent: [],
    saved: [],
    connectedSpotify: false
  };

  if (loggedIn) {
    try {
      const res = await requestJson('/api/universe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signalsOnly: true, useLocalHistory: false })
      });
      if (res?.liveSignals) liveSignals = res.liveSignals;
      if (res?.diagnostics?.warnings?.length) diagnostics.warnings.push(...res.diagnostics.warnings);
    } catch (err) {
      diagnostics.warnings.push(`Live Spotify fetch unavailable (${err.message}); showing your streaming history universe.`);
    }
  }

  const mergedKnown = { ...knownMeta };
  const state = mergeSignalsAndRank({
    ...liveSignals,
    historySummary,
    spotifyApiOnly,
    knownMeta: mergedKnown
  });

  const newlyEnrichedMeta = {};
  if (!skipInitialEnrich && state.unknown.length > 0) {
    const batches = [];
    for (let i = 0; i < INITIAL_CLIENT_ENRICH_CONCURRENCY; i++) {
      const slice = state.unknown.slice(i * INITIAL_CLIENT_ENRICH_BATCH, (i + 1) * INITIAL_CLIENT_ENRICH_BATCH);
      if (slice.length) batches.push(slice);
    }
    try {
      const results = await Promise.all(
        batches.map(batch => enrichArtists(batch).catch(() => ({ artistMeta: {}, warnings: [] })))
      );
      results.forEach(r => {
        if (r?.artistMeta) {
          Object.assign(newlyEnrichedMeta, r.artistMeta);
          Object.assign(mergedKnown, r.artistMeta);
        }
      });
    } catch {
      // Offline or rate-limited; continue with cached genres + co-listening clustering
    }
  }

  const assembled = assembleUniverseFromSignals(state, {
    knownMeta: mergedKnown,
    diagnostics
  });

  return {
    dataset: assembled.dataset,
    artistMeta: { ...newlyEnrichedMeta, ...assembled.artistMeta },
    diagnostics: assembled.diagnostics
  };
}

/**
 * Resolves to { dataset, artistMeta, diagnostics }; dataset is null when Spotify has no
 * data yet. knownMeta is what earlier loads learned (see artistMetaCache.js).
 * historySummary is optional browser-imported streaming history.
 */
export async function fetchUniverse(
  knownMeta = {},
  { historySummary = null, useLocalHistory = true, loggedIn = false, skipInitialEnrich = false, spotifyApiOnly = false } = {}
) {
  if (historySummary?.isAstraHistorySummary && !spotifyApiOnly) {
    return buildBrowserHistoryUniverse(knownMeta, {
      historySummary,
      loggedIn,
      skipInitialEnrich,
      spotifyApiOnly
    });
  }

  return requestJson('/api/universe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      knownMeta: compactKnownMetaForPost(knownMeta),
      useLocalHistory: spotifyApiOnly ? false : useLocalHistory,
      spotifyApiOnly
    })
  });
}

export function logout() {
  return requestJson('/api/auth/logout', { method: 'POST' });
}
