// server/universeBuilder.js
/**
 * Builds the raw { genres, artists, tracks } dataset consumed by the frontend's
 * buildUniverseGraph() from a user's Spotify top items.
 *
 * Constraints of the Spotify Web API (Development Mode, 2026):
 *  - GET /artists?ids= (batch) was removed, so missing artists are fetched one by one.
 *  - Artist followers/popularity and track popularity were removed.
 *  - Artist genres come back empty, so genres, country and occupation come from
 *    Wikidata and MusicBrainz (both matched by exact Spotify artist id).
 *  - Audio features are unavailable to new apps, so features are derived
 *    deterministically from the Spotify id (stable across reloads, not real).
 */
import { normalizeGenre, OCCUPATION_GENRES } from '../src/config/genreTaxonomy.js';
import { fetchWikidataArtistMeta } from './genreEnrichment.js';
import { fetchMusicBrainzArtistMeta } from './musicbrainz.js';
import { clusterArtists } from './clustering.js';

const MAX_TOP_ARTISTS = 30;
const MAX_TRACKS = 40;
const MAX_INDIVIDUAL_ARTIST_FETCHES = 40;
const ARTIST_FETCH_CONCURRENCY = 4;
const ARTIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

  // 3. Genres: Spotify's own when present (empty for Dev Mode apps), otherwise the union of
  //    Wikidata genres and MusicBrainz tags. Country (MusicBrainz first, it is cleaner) and
  //    occupation drive clustering for artists whose genre tags are missing or generic.
  const ids = includedArtists.map(a => a.id);
  const [wd, mb] = await Promise.all([fetchWikidataArtistMeta(ids), fetchMusicBrainzArtistMeta(ids)]);
  if (wd.error) diagnostics.warnings.push(`Wikidata lookup failed (${wd.error}).`);
  if (mb.error) diagnostics.warnings.push(`MusicBrainz lookup failed (${mb.error}).`);

  const genreSource = { spotify: 0, enriched: 0, none: 0 };
  const artistGenres = new Map();
  const artistFeatures = new Map();
  includedArtists.forEach(a => {
    const w = wd.metaById.get(a.id) || { genres: [], countries: [], occupations: [] };
    const m = mb.metaById.get(a.id) || { country: null, area: null, tags: [] };
    let raw = a.genres || [];
    if (raw.length) genreSource.spotify++;
    else if ((raw = [...w.genres, ...m.tags]).length) genreSource.enriched++;
    else genreSource.none++;
    const genres = [...new Set(raw.map(normalizeGenre))];
    const implied = w.occupations.map(o => OCCUPATION_GENRES[o.toLowerCase()]).filter(Boolean);
    const countries = m.country ? [m.country] : (w.countries.length ? w.countries : (m.area ? [m.area] : []));
    artistGenres.set(a.id, genres);
    artistFeatures.set(a.id, { genres: [...new Set([...genres, ...implied])], countries });
  });
  diagnostics.genreSource = genreSource;

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

  const { clusters, assignment, affinityMatrix } = clusterArtists(
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
      spotifyUrl: a.external_urls?.spotify,
      imageUrl: a.images?.[0]?.url,
      followers: 'N/A'
    };
  });

  const genres = clusters.map(c => ({
    id: c.id,
    name: c.name.toUpperCase(),
    color: c.color,
    family: c.family,
    familyLabel: c.familyLabel,
    subgenres: c.subgenres,
    affinity: affinityMatrix[c.id],
    basePlays: c.members.reduce((s, id) => s + (artistScore.get(id) || 0), 0),
    ...estimatedFeatures(c.id)
  }));

  diagnostics.artists = artists.length;
  diagnostics.genres = genres.length;
  if (genreSource.none > artists.length / 2 && !wd.error && !mb.error) {
    diagnostics.warnings.push(`No genre data found for ${genreSource.none} of ${artists.length} artists; they are grouped by collaborations or placed in Uncharted.`);
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
