// src/etl/universeAssembler.js
/**
 * Isomorphic universe dataset assembler & clustering pipeline.
 * Runs identically in Node (server/) and in the browser (src/) so large imported
 * Spotify Extended Streaming History files can be merged and clustered directly
 * on the client without hitting serverless payload limits (HTTP 413 on Vercel).
 */
import { normalizeGenre } from '../config/genreTaxonomy.js';
import {
  cleanTrackTitle,
  normalizeArtistKey,
  makeHistoryId
} from './historyParser.js';
import { clusterArtists } from '../../server/clustering.js';

export const HISTORY_ARTIST_PLAY_SCORE = 18;
export const HISTORY_TRACK_PLAY_SCORE = 22;
export const RANGE_WEIGHTS = { short_term: 1.0, medium_term: 1.2, long_term: 1.5 };
export const RECENT_PLAY_SCORE = 250;
export const SAVED_TRACK_SCORE = 120;
export const MAX_GENRES_PER_ARTIST = 16;

const LIKED_WINDOW = 5;
const SESSION_WINDOW = 5;
const KNOWN_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KNOWN_EMPTY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isFreshClientMeta(m) {
  return Boolean(
    m &&
    Array.isArray(m.g) &&
    Date.now() - (Number(m.t) || 0) < (m.g.length ? KNOWN_META_TTL_MS : KNOWN_EMPTY_TTL_MS)
  );
}

export const cleanMetaList = (list, max) =>
  Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.length < 60).slice(0, max) : [];

function hashUnit(str, salt) {
  let h = 2166136261;
  const s = `${salt}:${str}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function estimatedFeatures(id) {
  return {
    energy: Number((0.45 + hashUnit(id, 'energy') * 0.5).toFixed(2)),
    valence: Number((0.3 + hashUnit(id, 'valence') * 0.6).toFixed(2)),
    acoustic: Number((0.05 + hashUnit(id, 'acoustic') * 0.5).toFixed(2)),
    dance: Number((0.4 + hashUnit(id, 'dance') * 0.5).toFixed(2)),
    bpm: Math.round(90 + hashUnit(id, 'bpm') * 60)
  };
}

/**
 * Artists you play alongside each other: songs liked close together (same few days),
 * plays in the same listening session, plus multi-year streaming history sessions.
 */
export function listenedTogether(saved, recent, includedIds, historyPairs = [], artistIdByNorm = new Map()) {
  const together = new Map();
  const addPair = (x, y, w) => {
    if (!x || !y || x === y || !includedIds.has(x) || !includedIds.has(y)) return;
    const k = x < y ? `${x}|${y}` : `${y}|${x}`;
    together.set(k, (together.get(k) || 0) + w);
  };
  const link = (list, timeOf, maxGapMs, window) => {
    const items = (list || [])
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

/**
 * Step 1: Merges live Spotify signals (if any) with `historySummary` (if any) and
 * ranks all artists and tracks. Returns intermediate state including `unknown`
 * artists that need genre metadata enrichment.
 *
 * When `spotifyApiOnly` is true (and Spotify signals exist), history-only tracks and
 * artists are omitted so only items returned by the Spotify API are kept.
 */
export function mergeSignalsAndRank({
  topArtistsByRange = [[], [], []],
  topTracksByRange = [[], [], []],
  recent = [],
  saved = [],
  historySummary = null,
  connectedSpotify = false,
  spotifyApiOnly = false,
  knownMeta = {},
  isFreshMetaFn = isFreshClientMeta
} = {}) {
  const ranges = Object.keys(RANGE_WEIGHTS);
  const tracksById = new Map();
  const trackScore = new Map();
  const trackSources = new Map();
  const canonicalTrackByArtistAndTitle = new Map();

  const artistsById = new Map();
  const artistScore = new Map();
  const artistRanks = new Map();
  const artistHistoryById = new Map();
  const artistIdByNorm = new Map();
  const spotifyApiArtistIds = new Set();
  const spotifyApiTrackIds = new Set();

  const addArtistScore = (id, s) => artistScore.set(id, (artistScore.get(id) || 0) + s);

  const registerArtist = (artistObj, isFromSpotifyApi = false) => {
    const norm = normalizeArtistKey(artistObj.name);
    if (!norm) return null;
    const existingId = artistIdByNorm.get(norm);
    if (existingId) {
      if (isFromSpotifyApi) spotifyApiArtistIds.add(existingId);
      const cur = artistsById.get(existingId);
      if (cur && (!cur.images?.length && artistObj.images?.length)) {
        artistsById.set(existingId, { ...cur, ...artistObj, id: existingId });
      }
      return existingId;
    }
    const id = artistObj.id || makeHistoryId('artist', norm);
    if (isFromSpotifyApi) spotifyApiArtistIds.add(id);
    artistsById.set(id, { ...artistObj, id, genres: artistObj.genres || [] });
    artistIdByNorm.set(norm, id);
    return id;
  };

  topArtistsByRange.forEach((list, ri) => {
    const w = RANGE_WEIGHTS[ranges[ri]];
    (list || []).forEach((a, rank) => {
      const id = registerArtist(a, true);
      if (!id) return;
      addArtistScore(id, w * 3000 * Math.pow(0.96, rank));
      if (!artistRanks.has(id)) artistRanks.set(id, {});
      artistRanks.get(id)[ranges[ri]] = rank + 1;
    });
  });

  const addTrack = (t, score, source, isFromSpotifyApi = false) => {
    if (!t || !t.id || t.is_local || !t.artists?.length) return;
    const primaryName = t.artists[0].name;
    const normArtist = normalizeArtistKey(primaryName);
    const cleaned = cleanTrackTitle(t.name);
    if (!normArtist || !cleaned) return;

    const resolvedArtists = t.artists.map(a => {
      const aId = registerArtist(a, isFromSpotifyApi);
      return { ...a, id: aId };
    }).filter(a => a.id);
    if (!resolvedArtists.length) return;

    const key = `${normArtist}|${cleaned}`;
    let id = canonicalTrackByArtistAndTitle.get(key);
    if (!id) {
      id = t.id;
      canonicalTrackByArtistAndTitle.set(key, id);
      tracksById.set(id, { ...t, id, artists: resolvedArtists });
      trackSources.set(id, { ranks: {}, liked: false, recentPlays: 0, history: null, fromSpotifyApi: isFromSpotifyApi });
    } else {
      const cur = tracksById.get(id);
      if (cur) {
        // Merge any additional featured artists discovered across sources
        const existingArtistIds = new Set(cur.artists.map(a => a.id));
        const mergedArtists = [...cur.artists];
        resolvedArtists.forEach(ra => {
          if (!existingArtistIds.has(ra.id)) {
            existingArtistIds.add(ra.id);
            mergedArtists.push(ra);
          }
        });
        tracksById.set(id, {
          ...cur,
          ...(cur.album ? {} : t),
          id,
          artists: mergedArtists
        });
      }
    }
    if (isFromSpotifyApi) {
      spotifyApiTrackIds.add(id);
      trackSources.get(id).fromSpotifyApi = true;
    }
    trackScore.set(id, (trackScore.get(id) || 0) + score);
    const src = trackSources.get(id);
    if (source.range) src.ranks[source.range] = Math.min(src.ranks[source.range] || Infinity, source.rank);
    if (source.liked) src.liked = true;
    if (source.recent) src.recentPlays++;
    if (source.history) src.history = source.history;
  };

  topTracksByRange.forEach((list, ri) => {
    const w = RANGE_WEIGHTS[ranges[ri]];
    (list || []).forEach((t, rank) => addTrack(t, w * 1400 * Math.pow(0.97, rank), { range: ranges[ri], rank: rank + 1 }, true));
  });
  (recent || []).forEach(item => addTrack(item.track, RECENT_PLAY_SCORE, { recent: true }, true));
  (saved || []).forEach(item => addTrack(item.track, SAVED_TRACK_SCORE, { liked: true }, true));

  tracksById.forEach((t, id) => {
    const s = trackScore.get(id);
    t.artists.forEach((a, credit) => {
      addArtistScore(a.id, credit === 0 ? s * 0.5 : s * 0.2);
    });
  });

  const hasSpotifyApiItems = spotifyApiArtistIds.size > 0 || spotifyApiTrackIds.size > 0;
  const filterHistoryOut = Boolean(spotifyApiOnly && hasSpotifyApiItems);

  if (historySummary && Array.isArray(historySummary.artists) && !filterHistoryOut) {
    for (const hArtist of historySummary.artists) {
      const id = artistIdByNorm.get(hArtist.normName) || registerArtist({
        id: makeHistoryId('artist', hArtist.normName),
        name: hArtist.name,
        genres: []
      }, false);
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

  if (historySummary && Array.isArray(historySummary.tracks) && !filterHistoryOut) {
    for (const hTrack of historySummary.tracks) {
      const primaryArtistId = artistIdByNorm.get(hTrack.normArtist);
      if (!primaryArtistId) continue;

      const key = `${hTrack.normArtist}|${hTrack.cleanName}`;
      const existingTrackId = canonicalTrackByArtistAndTitle.get(key);

      const featArtists = (hTrack.featArtistNames || [])
        .map(fn => {
          const normFeat = normalizeArtistKey(fn);
          if (!normFeat) return null;
          const fId = artistIdByNorm.get(normFeat) || registerArtist({
            id: makeHistoryId('artist', normFeat),
            name: fn,
            genres: []
          }, false);
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
        { history: histMeta },
        false
      );
    }
  }

  const includedArtists = [...artistsById.values()];
  const topTracks = [...tracksById.values()].sort((x, y) => trackScore.get(y.id) - trackScore.get(x.id));

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
    .filter(a => !(a.genres || []).length && !isFreshMetaFn(knownMeta[a.id]))
    .sort((x, y) => (artistScore.get(y.id) || 0) - (artistScore.get(x.id) || 0))
    .map(a => ({ id: a.id, name: a.name, track: signatureTrack.get(a.id) }));

  return {
    tracksById,
    trackScore,
    trackSources,
    artistsById,
    artistScore,
    artistRanks,
    artistHistoryById,
    artistIdByNorm,
    spotifyApiArtistIds,
    spotifyApiTrackIds,
    includedArtists,
    topTracks,
    unknown,
    recent,
    saved,
    historySummary: filterHistoryOut ? null : historySummary,
    connectedSpotify,
    sourcesDiag: {
      topArtists: topArtistsByRange.map(l => (l || []).length).join('/'),
      topTracks: topTracksByRange.map(l => (l || []).length).join('/'),
      recentlyPlayed: (recent || []).length,
      likedSongs: (saved || []).length,
      historyPlays: filterHistoryOut ? 0 : (historySummary?.validPlays || 0),
      historyArtists: filterHistoryOut ? 0 : (historySummary?.artists?.length || 0),
      historyTracks: filterHistoryOut ? 0 : (historySummary?.tracks?.length || 0)
    }
  };
}

/**
 * Step 2: Applies known/enriched artist genre metadata, runs Louvain + 3D UMAP clustering,
 * and constructs the final `{ dataset, artistMeta, diagnostics }` object.
 */
export function assembleUniverseFromSignals(
  state,
  {
    knownMeta = {},
    enriched = { meta: new Map(), done: new Set(), warnings: [], stats: null },
    isFreshMetaFn = isFreshClientMeta,
    toCacheEntryFn = ({ g, c }) => ({ g, c, t: Date.now() }),
    diagnostics = { warnings: [] }
  } = {}
) {
  const {
    tracksById,
    trackScore,
    trackSources,
    artistsById,
    artistScore,
    artistRanks,
    artistHistoryById,
    artistIdByNorm,
    spotifyApiArtistIds = new Set(),
    spotifyApiTrackIds = new Set(),
    includedArtists,
    topTracks,
    unknown,
    recent,
    saved,
    historySummary,
    connectedSpotify,
    sourcesDiag
  } = state;

  diagnostics.sources = sourcesDiag;

  if (tracksById.size === 0 && artistsById.size === 0) {
    diagnostics.warnings.push('No Spotify or streaming history data found yet.');
    return { dataset: null, artistMeta: {}, diagnostics };
  }

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
      countries = isFreshMetaFn(known) ? cleanMetaList(known.c, 4) : [];
    } else if (isFreshMetaFn(known)) {
      genreSource.remembered++;
      genres = cleanMetaList(known.g, MAX_GENRES_PER_ARTIST);
      countries = cleanMetaList(known.c, 4);
    } else {
      const found = enriched.meta.get(a.id) || { g: [], c: [] };
      genres = found.g || [];
      countries = found.c || [];
      if (genres.length) genreSource.enriched++;
      else genreSource.none++;
      if (enriched.done.has(a.id)) artistMeta[a.id] = toCacheEntryFn(found);
    }
    artistGenres.set(a.id, genres);
    artistFeatures.set(a.id, { genres, countries });
  });

  diagnostics.genreSource = genreSource;
  diagnostics.pendingArtists = unknown.filter(a => !artistMeta[a.id] && !isFreshMetaFn(knownMeta[a.id]));

  // Cluster artists into suns (genre similarity + collaborations + co-listening sessions).
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
    const fromSpotifyApi = spotifyApiArtistIds.has(a.id) || Object.keys(artistRanks.get(a.id) || {}).length > 0;
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
      fromSpotifyApi,
      historyOnly: Boolean(!fromSpotifyApi && hist),
      embed: positions.get(a.id),
      spotifyUrl: a.external_urls?.spotify || (isRealSpotifyId ? `https://open.spotify.com/artist/${a.id}` : `https://open.spotify.com/search/${encodeURIComponent(a.name)}`),
      imageUrl: a.images?.[0]?.url
    };
  });

  const includedIds = new Set(artists.map(a => a.id));
  const artistClusterMap = new Map(artists.map(a => [a.id, a.genres[0]]));
  const tracks = topTracks
    .filter(t => includedIds.has(t.artists[0]?.id))
    .map(t => {
      const featList = t.artists.slice(1).filter(a => includedIds.has(a.id) && a.id !== t.artists[0].id);
      const featIds = [...new Set(featList.map(a => a.id))];
      const src = trackSources.get(t.id) || { ranks: {}, liked: false, recentPlays: 0, history: null, fromSpotifyApi: false };
      const isRealTrackId = /^[0-9A-Za-z]{22}$/.test(t.id);
      const fromSpotifyApi = Boolean(src.fromSpotifyApi || spotifyApiTrackIds.has(t.id) || Object.keys(src.ranks || {}).length || src.liked || src.recentPlays > 0);
      return {
        id: t.id,
        name: t.name,
        artistId: t.artists[0].id,
        artistName: t.artists[0].name,
        featArtistId: featIds[0] || null,
        featArtistIds: featIds,
        basePlays: Math.max(1, Math.round(trackScore.get(t.id))),
        ...estimatedFeatures(t.id),
        ranks: src.ranks,
        liked: src.liked,
        recentPlays: src.recentPlays,
        history: src.history,
        fromSpotifyApi,
        historyOnly: Boolean(!fromSpotifyApi && src.history),
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
  if (genreSource.none > artists.length / 2 && !enriched.warnings?.length && !diagnostics.pendingArtists.length) {
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
