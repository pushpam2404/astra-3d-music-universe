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
import { normalizeGenre } from '../src/config/genreTaxonomy.js';
import {
  cleanTrackTitle,
  normalizeArtistKey,
  makeHistoryId
} from '../src/etl/historyParser.js';
import { enrichArtists, isFreshMeta, cleanList, toCacheEntry, MAX_GENRES_PER_ARTIST } from './enrich.js';
import { clusterArtists } from './clustering.js';

const PAGE_SIZE = 50;
const MAX_TOP_ITEMS_PER_RANGE = 200;
const MAX_SAVED_TRACKS = 5000;
const PAGE_CONCURRENCY = 4;

const HISTORY_ARTIST_PLAY_SCORE = 18;
const HISTORY_TRACK_PLAY_SCORE = 22;

// Longer horizons say more about lasting taste.
const RANGE_WEIGHTS = { short_term: 1.0, medium_term: 1.2, long_term: 1.5 };
const RECENT_PLAY_SCORE = 250;
// Time budget for Last.fm's per-artist lookups on one load (they run alongside the others).
const METADATA_BUDGET_MS = 22000;
// Unknown artists looked up during the initial load; the rest happen automatically in the background (/api/enrich).
const INITIAL_ENRICH_LIMIT = 300;
const SAVED_TRACK_SCORE = 120;
// How many neighbouring likes / session plays count as "listened together".
const LIKED_WINDOW = 5;
const SESSION_WINDOW = 5;

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

const cleanTitle = cleanTrackTitle;

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

/**
 * Artists you play alongside each other: songs liked close together (same few days),
 * plays in the same listening session, plus multi-year streaming history sessions.
 */
function listenedTogether(saved, recent, includedIds, historyPairs = [], artistIdByNorm = new Map()) {
  const together = new Map();
  const addPair = (x, y, w) => {
    if (!x || !y || x === y || !includedIds.has(x) || !includedIds.has(y)) return;
    const k = x < y ? `${x}|${y}` : `${y}|${x}`;
    together.set(k, (together.get(k) || 0) + w);
  };
  const link = (list, timeOf, maxGapMs, window) => {
    const items = list
      .map(item => ({ ids: (item.track?.artists || []).map(a => a.id).filter(id => includedIds.has(id)), t: Date.parse(timeOf(item)) }))
      .filter(x => x.ids.length && Number.isFinite(x.t));
    for (let i = 0; i < items.length; i++) {
      for (let d = 1; d <= window && i + d < items.length; d++) {
        const b = items[i + d];
        if (Math.abs(items[i].t - b.t) > maxGapMs) break;
        items[i].ids.forEach(x => b.ids.forEach(y => addPair(x, y, 1 / d)));
      }
    }
  };
  link(saved, item => item.added_at, 3 * 24 * 3600 * 1000, LIKED_WINDOW);
  link(recent, item => item.played_at, 30 * 60 * 1000, SESSION_WINDOW);

  // Feed multi-year streaming history session co-listening pairs
  if (Array.isArray(historyPairs)) {
    for (const entry of historyPairs) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [pairKey, weight] = entry;
      const [normA, normB] = String(pairKey).split('|');
      const idA = artistIdByNorm.get(normA);
      const idB = artistIdByNorm.get(normB);
      if (idA && idB) addPair(idA, idB, Number(weight) || 1);
    }
  }
  return together;
}

export async function buildUniverseDataset(api, { knownMeta = {}, historySummary = null } = {}) {
  const diagnostics = { warnings: [] };
  const ranges = Object.keys(RANGE_WEIGHTS);

  let topArtistsByRange = [[], [], []];
  let topTracksByRange = [[], [], []];
  let recent = [];
  let saved = [];
  let connectedSpotify = false;

  // 1. Gather live Spotify listening signals in parallel if connected.
  if (api) {
    try {
      [topArtistsByRange, topTracksByRange, recent, saved] = await Promise.all([
        Promise.all(ranges.map(r => fetchAllPages(api, `/me/top/artists?time_range=${r}`, MAX_TOP_ITEMS_PER_RANGE))),
        Promise.all(ranges.map(r => fetchAllPages(api, `/me/top/tracks?time_range=${r}`, MAX_TOP_ITEMS_PER_RANGE))),
        optionalSource(diagnostics, 'recently played tracks', async () =>
          (await api.get('/me/player/recently-played?limit=50')).items || []),
        optionalSource(diagnostics, 'Liked Songs', () => fetchAllPages(api, '/me/tracks', MAX_SAVED_TRACKS))
      ]);
      connectedSpotify = true;
    } catch (err) {
      if (!historySummary?.validPlays) throw err;
      diagnostics.warnings.push(`Live Spotify fetch unavailable (${err.message}); showing your streaming history universe.`);
    }
  }

  diagnostics.sources = {
    topArtists: topArtistsByRange.map(l => l.length).join('/'),
    topTracks: topTracksByRange.map(l => l.length).join('/'),
    recentlyPlayed: recent.length,
    likedSongs: saved.length,
    historyPlays: historySummary?.validPlays || 0,
    historyArtists: historySummary?.artists?.length || 0,
    historyTracks: historySummary?.tracks?.length || 0
  };

  // 2. Score tracks and artists across all live sources + ALL streaming history records.
  const tracksById = new Map(); // canonical id → track object
  const trackScore = new Map();
  const trackSources = new Map(); // canonical id → { ranks, liked, recentPlays, history }
  const canonicalTrackByArtistAndTitle = new Map(); // "normArtist|cleanTitle" → canonical id

  const artistsById = new Map();
  const artistScore = new Map();
  const artistRanks = new Map(); // id → { short_term: rank, ... }
  const artistHistoryById = new Map(); // id → history profile
  const artistIdByNorm = new Map(); // normArtist → artist id

  const addArtistScore = (id, s) => artistScore.set(id, (artistScore.get(id) || 0) + s);

  const registerArtist = (artistObj) => {
    const norm = normalizeArtistKey(artistObj.name);
    if (!norm) return null;
    const existingId = artistIdByNorm.get(norm);
    if (existingId) {
      const cur = artistsById.get(existingId);
      if (cur && (!cur.images?.length && artistObj.images?.length)) {
        artistsById.set(existingId, { ...cur, ...artistObj, id: existingId });
      }
      return existingId;
    }
    const id = artistObj.id || makeHistoryId('artist', norm);
    artistsById.set(id, { ...artistObj, id, genres: artistObj.genres || [] });
    artistIdByNorm.set(norm, id);
    return id;
  };

  // 2a. Live Top Artists
  topArtistsByRange.forEach((list, ri) => {
    const w = RANGE_WEIGHTS[ranges[ri]];
    list.forEach((a, rank) => {
      const id = registerArtist(a);
      if (!id) return;
      addArtistScore(id, w * 3000 * Math.pow(0.96, rank));
      if (!artistRanks.has(id)) artistRanks.set(id, {});
      artistRanks.get(id)[ranges[ri]] = rank + 1;
    });
  });

  const addTrack = (t, score, source) => {
    if (!t || !t.id || t.is_local || !t.artists?.length) return;
    const primaryName = t.artists[0].name;
    const normArtist = normalizeArtistKey(primaryName);
    const cleaned = cleanTitle(t.name);
    if (!normArtist || !cleaned) return;

    const resolvedArtists = t.artists.map(a => {
      const aId = registerArtist(a);
      return { ...a, id: aId };
    }).filter(a => a.id);
    if (!resolvedArtists.length) return;

    const key = `${normArtist}|${cleaned}`;
    let id = canonicalTrackByArtistAndTitle.get(key);
    if (!id) {
      id = t.id;
      canonicalTrackByArtistAndTitle.set(key, id);
      tracksById.set(id, { ...t, id, artists: resolvedArtists });
      trackSources.set(id, { ranks: {}, liked: false, recentPlays: 0, history: null });
    } else {
      const cur = tracksById.get(id);
      if (cur && !cur.album && t.album) {
        tracksById.set(id, { ...cur, ...t, id, artists: resolvedArtists });
      }
    }
    trackScore.set(id, (trackScore.get(id) || 0) + score);
    const src = trackSources.get(id);
    if (source.range) src.ranks[source.range] = Math.min(src.ranks[source.range] || Infinity, source.rank);
    if (source.liked) src.liked = true;
    if (source.recent) src.recentPlays++;
    if (source.history) src.history = source.history;
  };

  // 2b. Live Top Tracks, Recent Plays, Liked Songs
  topTracksByRange.forEach((list, ri) => {
    const w = RANGE_WEIGHTS[ranges[ri]];
    list.forEach((t, rank) => addTrack(t, w * 1400 * Math.pow(0.97, rank), { range: ranges[ri], rank: rank + 1 }));
  });
  recent.forEach(item => addTrack(item.track, RECENT_PLAY_SCORE, { recent: true }));
  saved.forEach(item => addTrack(item.track, SAVED_TRACK_SCORE, { liked: true }));

  tracksById.forEach((t, id) => {
    const s = trackScore.get(id);
    t.artists.forEach((a, credit) => {
      addArtistScore(a.id, credit === 0 ? s * 0.5 : s * 0.2);
    });
  });

  // 2c. Merge ALL Streaming History artists & tracks (no artificial cap)
  if (historySummary && Array.isArray(historySummary.artists)) {
    for (const hArtist of historySummary.artists) {
      const id = artistIdByNorm.get(hArtist.normName) || registerArtist({
        id: makeHistoryId('artist', hArtist.normName),
        name: hArtist.name,
        genres: []
      });
      if (!id) continue;

      addArtistScore(id, Math.max(1, hArtist.plays) * HISTORY_ARTIST_PLAY_SCORE);
      artistHistoryById.set(id, {
        plays: hArtist.plays,
        minutes: hArtist.minutes,
        firstPlayed: hArtist.firstPlayed,
        lastPlayed: hArtist.lastPlayed,
        daysSinceLast: hArtist.daysSinceLast,
        firstEra: hArtist.firstEra,
        peakEra: hArtist.peakEra,
        peakYear: hArtist.peakYear,
        lastEra: hArtist.lastEra,
        byYear: hArtist.byYear,
        byEra: hArtist.byEra,
        status: hArtist.status,
        statusLabel: hArtist.statusLabel,
        shortBadge: hArtist.shortBadge,
        tags: hArtist.tags,
        memoryNote: hArtist.memoryNote,
        topTrackName: hArtist.topTrackName
      });
    }
  }

  if (historySummary && Array.isArray(historySummary.tracks)) {
    for (const hTrack of historySummary.tracks) {
      const primaryArtistId = artistIdByNorm.get(hTrack.normArtist);
      if (!primaryArtistId) continue;

      const key = `${hTrack.normArtist}|${hTrack.cleanName}`;
      const existingTrackId = canonicalTrackByArtistAndTitle.get(key);

      const featArtists = (hTrack.featArtistNames || [])
        .map(fn => {
          const fId = artistIdByNorm.get(normalizeArtistKey(fn));
          return fId ? artistsById.get(fId) : null;
        })
        .filter(Boolean);

      const primaryArtistObj = artistsById.get(primaryArtistId);
      const trackId = existingTrackId || hTrack.spotifyTrackId || makeHistoryId('track', key);
      const spotifyUrl = hTrack.spotifyTrackId ? `https://open.spotify.com/track/${hTrack.spotifyTrackId}` : undefined;

      const histMeta = {
        plays: hTrack.plays,
        minutes: hTrack.minutes,
        firstPlayed: hTrack.firstPlayed,
        lastPlayed: hTrack.lastPlayed,
        daysSinceLast: hTrack.daysSinceLast,
        firstEra: hTrack.firstEra,
        peakEra: hTrack.peakEra,
        peakYear: hTrack.peakYear,
        lastEra: hTrack.lastEra,
        byYear: hTrack.byYear,
        byEra: hTrack.byEra,
        status: hTrack.status,
        statusLabel: hTrack.statusLabel,
        shortBadge: hTrack.shortBadge,
        tags: hTrack.tags,
        memoryNote: hTrack.memoryNote
      };

      addTrack(
        {
          id: trackId,
          name: hTrack.name,
          artists: [primaryArtistObj, ...featArtists],
          external_urls: spotifyUrl ? { spotify: spotifyUrl } : undefined
        },
        Math.max(1, hTrack.plays) * HISTORY_TRACK_PLAY_SCORE,
        { history: histMeta }
      );
    }
  }

  if (tracksById.size === 0 && artistsById.size === 0) {
    diagnostics.warnings.push('No Spotify or streaming history data found yet.');
    return { dataset: null, diagnostics };
  }

  const includedArtists = [...artistsById.values()];
  const topTracks = [...tracksById.values()].sort((x, y) => trackScore.get(y.id) - trackScore.get(x.id));

  // 3. Genres and country for every artist:
  //    Spotify's own → browser cache (`knownMeta`) → live Wikidata/MusicBrainz/Last.fm
  const metaStart = Date.now();
  const signatureTrack = new Map();
  topTracks.forEach(t => {
    const primary = t.artists[0]?.id;
    if (primary && !signatureTrack.has(primary)) signatureTrack.set(primary, t.name);
  });
  includedArtists.forEach(a => {
    if (!signatureTrack.has(a.id)) {
      const h = artistHistoryById.get(a.id);
      if (h?.topTrackName) signatureTrack.set(a.id, h.topTrackName);
    }
  });

  const unknown = includedArtists
    .filter(a => !(a.genres || []).length && !isFreshMeta(knownMeta[a.id]))
    .sort((x, y) => (artistScore.get(y.id) || 0) - (artistScore.get(x.id) || 0))
    .map(a => ({ id: a.id, name: a.name, track: signatureTrack.get(a.id) }));
  const firstBatch = unknown.slice(0, INITIAL_ENRICH_LIMIT);
  const enriched = await enrichArtists(firstBatch, METADATA_BUDGET_MS);
  diagnostics.warnings.push(...enriched.warnings);
  diagnostics.lastfm = enriched.stats;

  const genreSource = { spotify: 0, remembered: 0, enriched: 0, none: 0 };
  const artistGenres = new Map();
  const artistFeatures = new Map();
  const artistMeta = {};
  includedArtists.forEach(a => {
    let genres;
    let countries;
    const known = knownMeta[a.id];
    if ((a.genres || []).length) {
      genreSource.spotify++;
      genres = [...new Set(a.genres.map(normalizeGenre))];
      countries = isFreshMeta(known) ? cleanList(known.c, 4) : [];
    } else if (isFreshMeta(known)) {
      genreSource.remembered++;
      genres = cleanList(known.g, MAX_GENRES_PER_ARTIST);
      countries = cleanList(known.c, 4);
    } else {
      const found = enriched.meta.get(a.id) || { g: [], c: [] };
      genres = found.g;
      countries = found.c;
      if (genres.length) genreSource.enriched++;
      else genreSource.none++;
      if (enriched.done.has(a.id)) artistMeta[a.id] = toCacheEntry(found);
    }
    artistGenres.set(a.id, genres);
    artistFeatures.set(a.id, { genres, countries });
  });
  diagnostics.genreSource = genreSource;
  diagnostics.metadataMs = Date.now() - metaStart;
  diagnostics.pendingArtists = unknown.filter(a => !artistMeta[a.id]);

  // 4. Cluster artists into suns (genre similarity + collaborations + co-listening sessions).
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

  const together = listenedTogether(saved, recent, includedIdSet, historySummary?.togetherPairs || [], artistIdByNorm);
  diagnostics.listenedTogetherPairs = together.size;
  const { clusters, assignment, affinityMatrix, positions } = clusterArtists(
    includedArtists.map(a => ({ id: a.id, name: a.name, ...artistFeatures.get(a.id), score: artistScore.get(a.id) || 1 })),
    collabs,
    together
  );
  diagnostics.clusters = clusters.map(c => `${c.name} (${c.members.length})`);

  const titleCase = (g) => g.replace(/\b([a-z])/g, (m) => m.toUpperCase());
  const artists = includedArtists.map(a => {
    const { clusterId, bridge } = assignment.get(a.id);
    const hist = artistHistoryById.get(a.id) || null;
    const isRealSpotifyId = /^[0-9A-Za-z]{22}$/.test(a.id);
    return {
      id: a.id,
      name: a.name,
      genres: bridge ? [clusterId, bridge.clusterId] : [clusterId],
      bridgeWeight: bridge ? bridge.weight : 0,
      subgenres: artistGenres.get(a.id).slice(0, 6).map(titleCase),
      basePlays: Math.max(10, Math.round(artistScore.get(a.id) || 10)),
      ...estimatedFeatures(a.id),
      ranks: artistRanks.get(a.id) || {},
      history: hist,
      embed: positions.get(a.id),
      spotifyUrl: a.external_urls?.spotify || (isRealSpotifyId ? `https://open.spotify.com/artist/${a.id}` : `https://open.spotify.com/search/${encodeURIComponent(a.name)}`),
      imageUrl: a.images?.[0]?.url
    };
  });

  // 5. Track satellites; every track now has its primary artist in the graph.
  const includedIds = new Set(artists.map(a => a.id));
  const artistClusterMap = new Map(artists.map(a => [a.id, a.genres[0]]));
  const tracks = topTracks
    .filter(t => includedIds.has(t.artists[0]?.id))
    .map(t => {
      const feat = t.artists.slice(1).find(a => includedIds.has(a.id));
      const src = trackSources.get(t.id) || { ranks: {}, liked: false, recentPlays: 0, history: null };
      const isRealTrackId = /^[0-9A-Za-z]{22}$/.test(t.id);
      return {
        id: t.id,
        name: t.name,
        artistId: t.artists[0].id,
        artistName: t.artists[0].name,
        featArtistId: feat ? feat.id : null,
        basePlays: Math.max(1, Math.round(trackScore.get(t.id))),
        ...estimatedFeatures(t.id),
        ranks: src.ranks,
        liked: src.liked,
        recentPlays: src.recentPlays,
        history: src.history,
        durationMs: t.duration_ms,
        spotifyUrl: t.external_urls?.spotify || (isRealTrackId ? `https://open.spotify.com/track/${t.id}` : `https://open.spotify.com/search/${encodeURIComponent(`${t.name} ${t.artists[0].name}`)}`),
        imageUrl: t.album?.images?.[0]?.url,
        previewUrl: t.preview_url
      };
    });
  diagnostics.tracks = tracks.length;

  const clusterTracksMap = new Map();
  tracks.forEach(t => {
    const cId = artistClusterMap.get(t.artistId);
    if (!cId) return;
    if (!clusterTracksMap.has(cId)) clusterTracksMap.set(cId, []);
    clusterTracksMap.get(cId).push(t);
  });

  const genres = clusters.map(c => {
    const cTracks = clusterTracksMap.get(c.id) || [];
    const byYear = {};
    let totalHistPlays = 0;
    let totalHistMinutes = 0;
    let pastFavCount = 0;
    let dormantCount = 0;

    c.members.forEach(aId => {
      const h = artistHistoryById.get(aId);
      if (!h) return;
      totalHistPlays += h.plays || 0;
      totalHistMinutes += h.minutes || 0;
      if (h.tags?.includes('past_fav')) pastFavCount++;
      if (h.tags?.includes('dormant')) dormantCount++;
      Object.entries(h.byYear || {}).forEach(([y, count]) => {
        byYear[y] = (byYear[y] || 0) + count;
      });
    });

    cTracks.forEach(t => {
      if (t.history?.tags?.includes('past_fav')) pastFavCount++;
      if (t.history?.tags?.includes('dormant')) dormantCount++;
    });

    let peakYear = null;
    let peakPlays = 0;
    Object.entries(byYear).forEach(([y, cnt]) => {
      if (cnt > peakPlays) { peakPlays = cnt; peakYear = y; }
    });

    return {
      id: c.id,
      name: c.name,
      color: c.color,
      family: c.family,
      familyLabel: c.familyLabel,
      subgenres: c.subgenres,
      topArtists: c.topArtists,
      affinity: affinityMatrix[c.id],
      basePlays: c.members.reduce((s, id) => s + (artistScore.get(id) || 0), 0),
      trackCount: cTracks.length,
      history: totalHistPlays > 0 ? {
        plays: totalHistPlays,
        minutes: totalHistMinutes,
        byYear,
        peakYear,
        pastFavCount,
        dormantCount
      } : null,
      ...estimatedFeatures(c.id)
    };
  });

  diagnostics.artists = artists.length;
  diagnostics.genres = genres.length;
  if (genreSource.none > artists.length / 2 && !enriched.warnings.length && !diagnostics.pendingArtists.length) {
    diagnostics.warnings.push(`No genre data found for ${genreSource.none} of ${artists.length} artists; they are grouped by collaborations or placed in Uncharted.`);
  }

  const historyMeta = historySummary?.validPlays ? {
    validPlays: historySummary.validPlays,
    totalHours: historySummary.totalHours,
    firstDate: historySummary.firstDate,
    lastDate: historySummary.lastDate,
    years: historySummary.years,
    sourceFolder: historySummary.sourceFolder || 'Imported History',
    connectedSpotify
  } : null;

  return {
    dataset: {
      id: 'spotify_universe',
      name: connectedSpotify && historyMeta ? 'Your Complete Music Universe' : (historyMeta ? 'Your Listening History Universe' : 'Your Music Universe'),
      description: historyMeta
        ? `${artists.length.toLocaleString()} artists and ${tracks.length.toLocaleString()} songs across ${historyMeta.firstDate?.slice(0, 4)}–${historyMeta.lastDate?.slice(0, 4)} (${historyMeta.validPlays.toLocaleString()} plays${connectedSpotify ? ' merged with Spotify' : ''}).`
        : `${artists.length.toLocaleString()} artists and ${tracks.length.toLocaleString()} tracks from your top charts, recent plays and Liked Songs.`,
      genres,
      artists,
      tracks,
      historyMeta
    },
    artistMeta,
    diagnostics
  };
}
