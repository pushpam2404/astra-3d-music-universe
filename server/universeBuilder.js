// server/universeBuilder.js
/**
 * Builds the raw { genres, artists, tracks } dataset consumed by the frontend's
 * buildUniverseGraph() from a user's Spotify top items.
 *
 * Constraints of the Spotify Web API (Development Mode, 2026):
 *  - GET /artists?ids= (batch) was removed, so missing artists are fetched one by one.
 *  - Artist followers/popularity and track popularity were removed.
 *  - Audio features are unavailable to new apps, so features are derived
 *    deterministically from the Spotify id (stable across reloads, not real).
 */
import { GENRE_PALETTES, COLOR_SPOTIFY_GREEN } from '../src/config/constants.js';

const MAX_GENRES = 8;
const MAX_TOP_ARTISTS = 30;
const MAX_TRACKS = 40;
const MAX_INDIVIDUAL_ARTIST_FETCHES = 40;
const ARTIST_FETCH_CONCURRENCY = 4;
const ARTIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const OTHER_GENRE_ID = 'genre_other';
const UNCLASSIFIED_GENRE_ID = 'genre_unclassified';

// Artist objects are not user-specific, so cache them across sessions.
const artistCache = new Map();

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

function genreColor(genreName, index) {
  for (const [key, color] of Object.entries(GENRE_PALETTES)) {
    if (key !== 'default' && genreName.toLowerCase().includes(key.toLowerCase())) return color;
  }
  const palette = Object.values(GENRE_PALETTES);
  return palette[index % palette.length] || COLOR_SPOTIFY_GREEN;
}

const genreIdFor = (name) => `genre_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

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

async function fetchArtist(api, id) {
  const cached = artistCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < ARTIST_CACHE_TTL_MS) return cached.artist;
  const artist = await api.get(`/artists/${id}`);
  artistCache.set(id, { artist, fetchedAt: Date.now() });
  return artist;
}

export async function buildUniverseDataset(api, timeRange) {
  const diagnostics = { timeRange, warnings: [] };

  const [topArtistsRes, topTracksRes] = await Promise.all([
    api.get(`/me/top/artists?limit=${MAX_TOP_ARTISTS}&time_range=${timeRange}`),
    api.get(`/me/top/tracks?limit=50&time_range=${timeRange}`)
  ]);
  const topArtists = topArtistsRes.items || [];
  const topTracks = (topTracksRes.items || []).slice(0, MAX_TRACKS);
  diagnostics.topArtists = topArtists.length;
  diagnostics.topTracks = topTracks.length;

  if (topArtists.length === 0 && topTracks.length === 0) {
    diagnostics.warnings.push(`Spotify returned no top artists or tracks for "${timeRange}". Try a longer time range.`);
    return { dataset: null, diagnostics };
  }

  // 1. Score artists: rank in top artists + contribution from top tracks.
  const artistsById = new Map();
  const artistScore = new Map();
  const addScore = (id, s) => artistScore.set(id, (artistScore.get(id) || 0) + s);

  topArtists.forEach((a, idx) => {
    artistsById.set(a.id, a);
    addScore(a.id, Math.round(3000 * Math.pow(0.92, idx)));
  });

  const trackBase = topTracks.map((_, idx) => Math.round(1400 * Math.pow(0.95, idx)));
  topTracks.forEach((t, idx) => {
    t.artists.forEach((a, credit) => addScore(a.id, credit === 0 ? trackBase[idx] * 0.5 : trackBase[idx] * 0.2));
  });

  // 2. Every track's primary artist must exist as a planet, so fetch missing ones individually.
  const missingPrimaryIds = [...new Set(topTracks.map(t => t.artists[0]?.id).filter(id => id && !artistsById.has(id)))];
  const toFetch = missingPrimaryIds.slice(0, MAX_INDIVIDUAL_ARTIST_FETCHES);
  let fetchFailures = 0;
  await mapWithConcurrency(toFetch, ARTIST_FETCH_CONCURRENCY, async (id) => {
    try {
      artistsById.set(id, await fetchArtist(api, id));
    } catch (err) {
      fetchFailures++;
      // Fall back to the simplified artist object embedded in the track.
      const simplified = topTracks.flatMap(t => t.artists).find(a => a.id === id);
      if (simplified) artistsById.set(id, { ...simplified, genres: [] });
    }
  });
  diagnostics.artistsFetchedIndividually = toFetch.length;
  diagnostics.artistFetchFailures = fetchFailures;
  if (fetchFailures > 0) {
    diagnostics.warnings.push(`${fetchFailures} artist lookups failed; those artists have no genre data.`);
  }

  // Included artists: top artists plus every primary track artist.
  const primaryIds = new Set(topTracks.map(t => t.artists[0]?.id).filter(Boolean));
  const includedArtists = [...artistsById.values()].filter(a =>
    topArtists.some(t => t.id === a.id) || primaryIds.has(a.id)
  );

  // 3. Genre suns weighted by artist score.
  const genreScore = new Map();
  includedArtists.forEach(a => {
    (a.genres || []).forEach(g => genreScore.set(g, (genreScore.get(g) || 0) + (artistScore.get(a.id) || 0)));
  });
  const topGenreNames = [...genreScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_GENRES).map(([g]) => g);
  const topGenreSet = new Set(topGenreNames);

  const genres = topGenreNames.map((name, idx) => ({
    id: genreIdFor(name),
    name: name.toUpperCase(),
    color: genreColor(name, idx),
    basePlays: Math.round(genreScore.get(name)),
    ...estimatedFeatures(name)
  }));

  // 4. Artist planets; artists outside the top genres go to honest catch-all suns.
  let needsOther = false;
  let needsUnclassified = false;
  const artists = includedArtists.map(a => {
    const own = a.genres || [];
    const matched = own.filter(g => topGenreSet.has(g)).slice(0, 2).map(genreIdFor);
    let genreIds = matched;
    if (matched.length === 0) {
      if (own.length > 0) {
        needsOther = true;
        genreIds = [OTHER_GENRE_ID];
      } else {
        needsUnclassified = true;
        genreIds = [UNCLASSIFIED_GENRE_ID];
      }
    }
    return {
      id: a.id,
      name: a.name,
      genres: genreIds,
      spotifyGenres: own,
      basePlays: Math.max(10, Math.round(artistScore.get(a.id) || 10)),
      ...estimatedFeatures(a.id),
      spotifyUrl: a.external_urls?.spotify,
      imageUrl: a.images?.[0]?.url,
      followers: 'N/A'
    };
  });

  const scoreOf = (genreId) => artists.filter(a => a.genres.includes(genreId)).reduce((s, a) => s + a.basePlays, 0);
  if (needsOther) {
    genres.push({ id: OTHER_GENRE_ID, name: 'OTHER GENRES', color: '#8A8FA8', basePlays: scoreOf(OTHER_GENRE_ID), ...estimatedFeatures('other') });
  }
  if (needsUnclassified) {
    genres.push({ id: UNCLASSIFIED_GENRE_ID, name: 'UNCLASSIFIED', color: '#4A4E63', basePlays: scoreOf(UNCLASSIFIED_GENRE_ID), ...estimatedFeatures('unclassified') });
  }

  const unclassifiedCount = artists.filter(a => a.genres[0] === UNCLASSIFIED_GENRE_ID).length;
  diagnostics.artists = artists.length;
  diagnostics.genres = genres.length;
  diagnostics.artistsWithoutSpotifyGenres = unclassifiedCount;
  if (unclassifiedCount > artists.length / 2) {
    diagnostics.warnings.push(`Spotify returned no genres for ${unclassifiedCount} of ${artists.length} artists, so most planets orbit the UNCLASSIFIED sun.`);
  }

  // 5. Track satellites; every track now has its primary artist in the graph.
  const includedIds = new Set(artists.map(a => a.id));
  const tracks = topTracks
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => includedIds.has(t.artists[0]?.id))
    .map(({ t, idx }) => {
      const feat = t.artists.slice(1).find(a => includedIds.has(a.id));
      return {
        id: t.id,
        name: t.name,
        artistId: t.artists[0].id,
        featArtistId: feat ? feat.id : null,
        basePlays: trackBase[idx],
        ...estimatedFeatures(t.id),
        durationMin: Number((t.duration_ms / 60000).toFixed(1)),
        spotifyUrl: t.external_urls?.spotify,
        imageUrl: t.album?.images?.[0]?.url,
        previewUrl: t.preview_url
      };
    });
  diagnostics.tracks = tracks.length;
  diagnostics.droppedTracks = topTracks.length - tracks.length;

  return {
    dataset: {
      id: `spotify_${timeRange}`,
      name: 'Live Spotify Universe',
      description: `Synced live with your Spotify taste (${timeRange.replace('_', ' ')}).`,
      genres,
      artists,
      tracks
    },
    diagnostics
  };
}
