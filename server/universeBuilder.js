// server/universeBuilder.js
/**
 * Builds ONE universe of everything we can see of the user's listening: top artists and
 * top tracks across all three time ranges, recently played tracks, and Liked Songs.
 * Output is the raw { genres, artists, tracks } dataset consumed by buildUniverseGraph().
 *
 * Constraints of the Spotify Web API (Development Mode, 2026):
 *  - GET /artists?ids= (batch) was removed. Artist genres come back empty anyway, so
 *    track artists are used as-is (simplified objects) instead of being fetched.
 *  - Genres, country and occupation come from Wikidata and MusicBrainz (both matched
 *    by exact Spotify artist id) and Last.fm community tags.
 *
 * The browser sends back what earlier loads learned (`knownMeta`), so lookups only run
 * for artists it hasn't seen; this is the persistent cache (no database needed).
 *  - Artist followers/popularity and track popularity were removed.
 *  - Audio features are unavailable to new apps, so features are derived
 *    deterministically from the Spotify id (stable across reloads, not real).
 */
import { normalizeGenre, OCCUPATION_GENRES } from '../src/config/genreTaxonomy.js';
import { fetchWikidataArtistMeta } from './genreEnrichment.js';
import { fetchMusicBrainzArtistMeta } from './musicbrainz.js';
import { fetchLastfmTags, isLastfmConfigured } from './lastfm.js';
import { tagsContradictCountry } from './places.js';
import { clusterArtists } from './clustering.js';

const PAGE_SIZE = 50;
const MAX_TOP_ITEMS_PER_RANGE = 200;
const MAX_SAVED_TRACKS = 5000;
const PAGE_CONCURRENCY = 4;

// Longer horizons say more about lasting taste.
const RANGE_WEIGHTS = { short_term: 1.0, medium_term: 1.2, long_term: 1.5 };
const RECENT_PLAY_SCORE = 250;
// Time budget for Last.fm's per-artist lookups on one load (they run alongside the others).
const METADATA_BUDGET_MS = 26000;
// Client-cached metadata is trusted this long; "nothing found" is rechecked sooner.
const KNOWN_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KNOWN_EMPTY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Bump when the Last.fm lookup method changes, so browsers re-check their cached artists.
const LASTFM_METHOD_VERSION = 3;
// Same cap for fresh and remembered genres, so a cached load clusters identically.
const MAX_GENRES_PER_ARTIST = 16;
const SAVED_TRACK_SCORE = 120;

function hashUnit(str, salt) {
  let h = 2166136261;
  const s = `${salt}:${str}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function estimatedFeatures(id) {
  return {
    energy: Number((0.45 + hashUnit(id, 'energy') * 0.5).toFixed(2)),
    valence: Number((0.3 + hashUnit(id, 'valence') * 0.6).toFixed(2)),
    acoustic: Number((0.05 + hashUnit(id, 'acoustic') * 0.5).toFixed(2)),
    dance: Number((0.4 + hashUnit(id, 'dance') * 0.5).toFixed(2)),
    bpm: Math.round(90 + hashUnit(id, 'bpm') * 60)
  };
}

/** "505 - Remastered 2011", "505 (Live)" and "505" are the same song. */
function cleanTitle(name) {
  return name
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

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

export async function buildUniverseDataset(api, { knownMeta = {} } = {}) {
  const diagnostics = { warnings: [] };
  const ranges = Object.keys(RANGE_WEIGHTS);

  // 1. Gather every listening signal in parallel.
  const [topArtistsByRange, topTracksByRange, recent, saved] = await Promise.all([
    Promise.all(ranges.map(r => fetchAllPages(api, `/me/top/artists?time_range=${r}`, MAX_TOP_ITEMS_PER_RANGE))),
    Promise.all(ranges.map(r => fetchAllPages(api, `/me/top/tracks?time_range=${r}`, MAX_TOP_ITEMS_PER_RANGE))),
    optionalSource(diagnostics, 'recently played tracks', async () =>
      (await api.get('/me/player/recently-played?limit=50')).items || []),
    optionalSource(diagnostics, 'Liked Songs', () => fetchAllPages(api, '/me/tracks', MAX_SAVED_TRACKS))
  ]);
  diagnostics.sources = {
    topArtists: topArtistsByRange.map(l => l.length).join('/'),
    topTracks: topTracksByRange.map(l => l.length).join('/'),
    recentlyPlayed: recent.length,
    likedSongs: saved.length
  };

  // 2. Score tracks and artists across all sources, remembering where each came from.
  //    Spotify lists one song under several ids (single, album, deluxe), so songs are
  //    merged by primary artist + cleaned title and keep every source that mentions them.
  const tracksById = new Map(); // canonical id → track object
  const trackScore = new Map();
  const trackSources = new Map(); // canonical id → { ranks, liked, recentPlays }
  const canonicalId = new Map(); // "artistId|title" → canonical id
  const addTrack = (t, score, source) => {
    if (!t || !t.id || t.is_local || !t.artists?.length) return;
    const key = `${t.artists[0].id}|${cleanTitle(t.name)}`;
    let id = canonicalId.get(key);
    if (!id) {
      id = t.id;
      canonicalId.set(key, id);
      tracksById.set(id, t);
      trackSources.set(id, { ranks: {}, liked: false, recentPlays: 0 });
    }
    trackScore.set(id, (trackScore.get(id) || 0) + score);
    const src = trackSources.get(id);
    if (source.range) src.ranks[source.range] = Math.min(src.ranks[source.range] || Infinity, source.rank);
    if (source.liked) src.liked = true;
    if (source.recent) src.recentPlays++;
  };
  topTracksByRange.forEach((list, ri) => {
    const w = RANGE_WEIGHTS[ranges[ri]];
    list.forEach((t, rank) => addTrack(t, w * 1400 * Math.pow(0.97, rank), { range: ranges[ri], rank: rank + 1 }));
  });
  recent.forEach(item => addTrack(item.track, RECENT_PLAY_SCORE, { recent: true }));
  saved.forEach(item => addTrack(item.track, SAVED_TRACK_SCORE, { liked: true }));

  const artistsById = new Map();
  const artistScore = new Map();
  const artistRanks = new Map(); // id → { short_term: rank, ... } for top artists
  const addArtistScore = (id, s) => artistScore.set(id, (artistScore.get(id) || 0) + s);
  topArtistsByRange.forEach((list, ri) => {
    const w = RANGE_WEIGHTS[ranges[ri]];
    list.forEach((a, rank) => {
      artistsById.set(a.id, a); // full objects (images, urls)
      addArtistScore(a.id, w * 3000 * Math.pow(0.96, rank));
      if (!artistRanks.has(a.id)) artistRanks.set(a.id, {});
      artistRanks.get(a.id)[ranges[ri]] = rank + 1;
    });
  });
  tracksById.forEach((t, id) => {
    const s = trackScore.get(id);
    t.artists.forEach((a, credit) => {
      if (!artistsById.has(a.id)) artistsById.set(a.id, { ...a, genres: [] });
      addArtistScore(a.id, credit === 0 ? s * 0.5 : s * 0.2);
    });
  });

  if (tracksById.size === 0 && artistsById.size === 0) {
    diagnostics.warnings.push('Spotify returned no listening data for this account yet.');
    return { dataset: null, diagnostics };
  }

  // Every artist we know of is a planet: top artists plus all credited track artists.
  const includedArtists = [...artistsById.values()];
  const topTracks = [...tracksById.values()].sort((x, y) => trackScore.get(y.id) - trackScore.get(x.id));

  // 3. Genres, country and occupation for every artist. Order of preference:
  //    Spotify's own genres (empty for Dev Mode apps) → what the browser already knows →
  //    fresh lookups (Wikidata + MusicBrainz in parallel, then Last.fm with the time left).
  const metaStart = Date.now();
  // Entries learned with an older Last.fm method (`l` below LASTFM_METHOD_VERSION, or
  // before Last.fm was configured) are re-checked once.
  const lastfmOn = isLastfmConfigured();
  const isFresh = (m) => m && Array.isArray(m.g)
    && !(lastfmOn && !(Number(m.l) >= LASTFM_METHOD_VERSION))
    && Date.now() - (Number(m.t) || 0) < (m.g.length ? KNOWN_META_TTL_MS : KNOWN_EMPTY_TTL_MS);
  // knownMeta comes from the browser: keep only well-formed strings.
  const cleanList = (list, max) => (Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.length < 60).slice(0, max) : []);
  const unknown = includedArtists.filter(a => !(a.genres || []).length && !isFresh(knownMeta[a.id]));
  const unknownIds = unknown.map(a => a.id);

  // All three sources run in parallel; Last.fm (one request per artist) gets the
  // whole budget, most-listened artists first.
  // Each artist's most-played song here, so Last.fm can tell same-name artists apart.
  const signatureTrack = new Map();
  topTracks.forEach(t => {
    const primary = t.artists[0]?.id;
    if (primary && !signatureTrack.has(primary)) signatureTrack.set(primary, t.name);
  });
  const lastfmQueue = unknown
    .slice()
    .sort((x, y) => (artistScore.get(y.id) || 0) - (artistScore.get(x.id) || 0))
    .map(a => ({ id: a.id, name: a.name, track: signatureTrack.get(a.id) }));
  const noMeta = { metaById: new Map() };
  const [wd, mb, lf] = unknownIds.length
    ? await Promise.all([
      fetchWikidataArtistMeta(unknownIds),
      fetchMusicBrainzArtistMeta(unknownIds),
      fetchLastfmTags(lastfmQueue, METADATA_BUDGET_MS)
    ])
    : [noMeta, noMeta, { tagsById: new Map(), viaById: new Map(), looked: 0, viaTrack: 0, skipped: 0 }];
  if (wd.error) diagnostics.warnings.push(`Wikidata lookup failed (${wd.error}).`);
  if (mb.error) diagnostics.warnings.push(`MusicBrainz lookup failed (${mb.error}).`);
  if (lf.error) diagnostics.warnings.push(`${lf.error}; the rest will be looked up on the next load.`);
  diagnostics.lastfm = lastfmOn ? { looked: lf.looked, viaTrack: lf.viaTrack, pending: lf.skipped } : 'LASTFM_API_KEY not set';

  const genreSource = { spotify: 0, remembered: 0, enriched: 0, none: 0 };
  let lastfmRejected = 0;
  const artistGenres = new Map();
  const artistFeatures = new Map();
  const artistMeta = {};
  const now = Date.now();
  includedArtists.forEach(a => {
    let genres;
    let countries;
    const known = knownMeta[a.id];
    if ((a.genres || []).length) {
      genreSource.spotify++;
      genres = [...new Set(a.genres.map(normalizeGenre))];
      countries = isFresh(known) ? cleanList(known.c, 4) : [];
    } else if (isFresh(known)) {
      genreSource.remembered++;
      genres = cleanList(known.g, MAX_GENRES_PER_ARTIST);
      countries = cleanList(known.c, 4);
    } else {
      const w = wd.metaById.get(a.id) || { genres: [], countries: [], occupations: [] };
      const m = mb.metaById.get(a.id) || { country: null, area: null, tags: [] };
      countries = m.country ? [m.country] : (w.countries.length ? w.countries : (m.area ? [m.area] : []));
      let lfTags = lf.tagsById.get(a.id) || [];
      // An artist page tagged with another country belongs to a same-name artist.
      if (lf.viaById.get(a.id) === 'artist' && tagsContradictCountry(lfTags, countries)) {
        lfTags = [];
        lastfmRejected++;
      }
      const raw = [...w.genres, ...lfTags, ...(w.genres.length || lfTags.length ? [] : m.tags)];
      const implied = w.occupations.map(o => OCCUPATION_GENRES[o.toLowerCase()]).filter(Boolean);
      genres = [...new Set([...raw, ...implied].map(normalizeGenre))].slice(0, MAX_GENRES_PER_ARTIST);
      if (genres.length) genreSource.enriched++;
      else genreSource.none++;
      // Remember it unless Last.fm still owes us a lookup for this artist.
      const lastfmPending = lastfmOn && !lf.tagsById.has(a.id);
      if (!lastfmPending) artistMeta[a.id] = { g: genres, c: countries, t: now, ...(lastfmOn ? { l: LASTFM_METHOD_VERSION } : {}) };
    }
    artistGenres.set(a.id, genres);
    artistFeatures.set(a.id, { genres, countries });
  });
  diagnostics.genreSource = genreSource;
  if (diagnostics.lastfm?.looked !== undefined) diagnostics.lastfm.rejectedSameName = lastfmRejected;
  diagnostics.metadataMs = Date.now() - metaStart;

  // 4. Cluster artists into suns (genre similarity + collaborations).
  const includedIdSet = new Set(includedArtists.map(a => a.id));
  const collabs = new Map();
  topTracks.forEach(t => {
    const ids = [...new Set(t.artists.map(a => a.id).filter(id => includedIdSet.has(id)))];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
        collabs.set(k, (collabs.get(k) || 0) + 1);
      }
    }
  });

  const { clusters, assignment, affinityMatrix, positions } = clusterArtists(
    includedArtists.map(a => ({ id: a.id, name: a.name, ...artistFeatures.get(a.id), score: artistScore.get(a.id) || 1 })),
    collabs
  );
  diagnostics.clusters = clusters.map(c => `${c.name} (${c.members.length})`);

  const titleCase = (g) => g.replace(/\b([a-z])/g, (m) => m.toUpperCase());
  const artists = includedArtists.map(a => {
    const { clusterId, bridge } = assignment.get(a.id);
    return {
      id: a.id,
      name: a.name,
      genres: bridge ? [clusterId, bridge.clusterId] : [clusterId],
      bridgeWeight: bridge ? bridge.weight : 0,
      subgenres: artistGenres.get(a.id).slice(0, 6).map(titleCase),
      basePlays: Math.max(10, Math.round(artistScore.get(a.id) || 10)),
      ...estimatedFeatures(a.id),
      ranks: artistRanks.get(a.id) || {},
      embed: positions.get(a.id),
      spotifyUrl: a.external_urls?.spotify || `https://open.spotify.com/artist/${a.id}`,
      imageUrl: a.images?.[0]?.url
    };
  });

  const genres = clusters.map(c => ({
    id: c.id,
    name: c.name,
    color: c.color,
    family: c.family,
    familyLabel: c.familyLabel,
    subgenres: c.subgenres,
    topArtists: c.topArtists,
    affinity: affinityMatrix[c.id],
    basePlays: c.members.reduce((s, id) => s + (artistScore.get(id) || 0), 0),
    ...estimatedFeatures(c.id)
  }));

  diagnostics.artists = artists.length;
  diagnostics.genres = genres.length;
  if (genreSource.none > artists.length / 2 && !wd.error && !mb.error && !lf.skipped) {
    diagnostics.warnings.push(`No genre data found for ${genreSource.none} of ${artists.length} artists; they are grouped by collaborations or placed in Uncharted.`);
  }

  // 5. Track satellites; every track now has its primary artist in the graph.
  const includedIds = new Set(artists.map(a => a.id));
  const tracks = topTracks
    .filter(t => includedIds.has(t.artists[0]?.id))
    .map(t => {
      const feat = t.artists.slice(1).find(a => includedIds.has(a.id));
      return {
        id: t.id,
        name: t.name,
        artistId: t.artists[0].id,
        featArtistId: feat ? feat.id : null,
        basePlays: Math.max(1, Math.round(trackScore.get(t.id))),
        ...estimatedFeatures(t.id),
        ...trackSources.get(t.id),
        durationMs: t.duration_ms,
        spotifyUrl: t.external_urls?.spotify,
        imageUrl: t.album?.images?.[0]?.url,
        previewUrl: t.preview_url
      };
    });
  diagnostics.tracks = tracks.length;

  return {
    dataset: {
      id: 'spotify_universe',
      name: 'Your Music Universe',
      description: `${artists.length} artists and ${tracks.length} tracks from your top charts, recent plays and Liked Songs.`,
      genres,
      artists,
      tracks
    },
    artistMeta,
    diagnostics
  };
}
