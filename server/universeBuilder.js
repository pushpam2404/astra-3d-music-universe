// server/universeBuilder.js
/**
 * Builds ONE universe of everything we can see of the user's listening: top artists and
 * top tracks across all three time ranges, recently played tracks, Liked Songs, AND
 * imported/local Spotify Streaming History.
 * Output is the raw { genres, artists, tracks, historyMeta } dataset consumed by buildUniverseGraph().
 *
 * Includes ALL artists and tracks from the user's records (no artificial truncation or
 * hardcoded artist lists).
 */
import {
  mergeSignalsAndRank,
  assembleUniverseFromSignals,
  RANGE_WEIGHTS
} from '../src/etl/universeAssembler.js';
import { enrichArtists, isFreshMeta, toCacheEntry } from './enrich.js';

const PAGE_SIZE = 50;
const MAX_TOP_ITEMS_PER_RANGE = 200;
const MAX_SAVED_TRACKS = 5000;
const PAGE_CONCURRENCY = 4;

// Time budget for Last.fm's per-artist lookups on one load (they run alongside the others).
const METADATA_BUDGET_MS = 22000;
// Unknown artists looked up during the initial load; the rest happen automatically in the background (/api/enrich).
const INITIAL_ENRICH_LIMIT = 300;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Fetches every page of a paged endpoint (up to `cap` items), pages in parallel. */
async function fetchAllPages(api, path, cap) {
  const sep = path.includes('?') ? '&' : '?';
  const first = await api.get(`${path}${sep}limit=${PAGE_SIZE}&offset=0`);
  const total = Math.min(first.total ?? first.items.length, cap);
  const offsets = [];
  for (let o = PAGE_SIZE; o < total; o += PAGE_SIZE) offsets.push(o);
  const pages = await mapWithConcurrency(offsets, PAGE_CONCURRENCY, (o) => api.get(`${path}${sep}limit=${PAGE_SIZE}&offset=${o}`));
  return [first, ...pages].flatMap(p => p.items || []).slice(0, cap);
}

/** Runs a source, turning failures into a diagnostics warning instead of failing the universe. */
async function optionalSource(diagnostics, label, fn) {
  try {
    return await fn();
  } catch (err) {
    const hint = err.status === 403 || err.status === 401 ? ' Reconnect Spotify to grant access.' : '';
    diagnostics.warnings.push(`Could not load ${label} (${err.status || ''} ${err.message}).${hint}`);
    return [];
  }
}

export async function fetchLiveSpotifySignals(api) {
  const diagnostics = { warnings: [] };
  const ranges = Object.keys(RANGE_WEIGHTS);
  let topArtistsByRange = [[], [], []];
  let topTracksByRange = [[], [], []];
  let recent = [];
  let saved = [];
  let connectedSpotify = false;

  if (api) {
    [topArtistsByRange, topTracksByRange, recent, saved] = await Promise.all([
      Promise.all(ranges.map(r => fetchAllPages(api, `/me/top/artists?time_range=${r}`, MAX_TOP_ITEMS_PER_RANGE))),
      Promise.all(ranges.map(r => fetchAllPages(api, `/me/top/tracks?time_range=${r}`, MAX_TOP_ITEMS_PER_RANGE))),
      optionalSource(diagnostics, 'recently played tracks', async () =>
        (await api.get('/me/player/recently-played?limit=50')).items || []),
      optionalSource(diagnostics, 'Liked Songs', () => fetchAllPages(api, '/me/tracks', MAX_SAVED_TRACKS))
    ]);
    connectedSpotify = true;
  }

  return {
    topArtistsByRange,
    topTracksByRange,
    recent,
    saved,
    connectedSpotify,
    diagnostics
  };
}

export async function buildUniverseDataset(api, { knownMeta = {}, historySummary = null, signalsOnly = false } = {}) {
  const diagnostics = { warnings: [] };
  let topArtistsByRange = [[], [], []];
  let topTracksByRange = [[], [], []];
  let recent = [];
  let saved = [];
  let connectedSpotify = false;

  if (api) {
    try {
      const live = await fetchLiveSpotifySignals(api);
      topArtistsByRange = live.topArtistsByRange;
      topTracksByRange = live.topTracksByRange;
      recent = live.recent;
      saved = live.saved;
      connectedSpotify = live.connectedSpotify;
      diagnostics.warnings.push(...live.diagnostics.warnings);
    } catch (err) {
      if (!historySummary?.validPlays && !signalsOnly) throw err;
      diagnostics.warnings.push(`Live Spotify fetch unavailable (${err.message}); showing your streaming history universe.`);
    }
  }

  if (signalsOnly) {
    return {
      liveSignals: {
        topArtistsByRange,
        topTracksByRange,
        recent,
        saved,
        connectedSpotify
      },
      diagnostics
    };
  }

  const state = mergeSignalsAndRank({
    topArtistsByRange,
    topTracksByRange,
    recent,
    saved,
    historySummary,
    connectedSpotify,
    knownMeta,
    isFreshMetaFn: isFreshMeta
  });

  if (state.tracksById.size === 0 && state.artistsById.size === 0) {
    diagnostics.warnings.push('No Spotify or streaming history data found yet.');
    return { dataset: null, artistMeta: {}, diagnostics };
  }

  const metaStart = Date.now();
  const firstBatch = state.unknown.slice(0, INITIAL_ENRICH_LIMIT);
  const enriched = await enrichArtists(firstBatch, METADATA_BUDGET_MS);
  diagnostics.warnings.push(...enriched.warnings);
  diagnostics.lastfm = enriched.stats;
  diagnostics.metadataMs = Date.now() - metaStart;

  return assembleUniverseFromSignals(state, {
    knownMeta,
    enriched,
    isFreshMetaFn: isFreshMeta,
    toCacheEntryFn: toCacheEntry,
    diagnostics
  });
}
