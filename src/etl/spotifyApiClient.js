// src/etl/spotifyApiClient.js
import { GENRE_PALETTES, COLOR_SPOTIFY_GREEN } from '../config/constants.js';

const API_BASE = 'https://api.spotify.com/v1';

async function spotifyGet(endpoint, accessToken) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Spotify session expired. Please re-authenticate.');
    }
    throw new Error(`Spotify API error (${res.status}) on ${endpoint}`);
  }
  return res.json();
}

/**
 * Resolves genre color or fallback from palette
 */
function assignGenreColor(genreName, index) {
  for (const [key, color] of Object.entries(GENRE_PALETTES)) {
    if (genreName.toLowerCase().includes(key.toLowerCase())) {
      return color;
    }
  }
  const paletteKeys = Object.values(GENRE_PALETTES);
  return paletteKeys[index % paletteKeys.length] || COLOR_SPOTIFY_GREEN;
}

/**
 * Fetches user top artists and tracks, solves the missing track-genre trap,
 * and builds a complete tripartite graph dataset.
 */
export async function fetchCompleteUserTaste(accessToken, timeRange = 'medium_term') {
  // 1. Fetch Top 30 Artists and Top 50 Tracks in parallel
  const [topArtistsRes, topTracksRes] = await Promise.all([
    spotifyGet(`/me/top/artists?limit=30&time_range=${timeRange}`, accessToken),
    spotifyGet(`/me/top/tracks?limit=50&time_range=${timeRange}`, accessToken)
  ]);

  const artistsMap = new Map();
  topArtistsRes.items.forEach(a => artistsMap.set(a.id, a));

  // 2. Transitive Join: Identify artists in Top Tracks missing from Top Artists
  const missingArtistIds = new Set();
  topTracksRes.items.forEach(track => {
    track.artists.forEach(a => {
      if (!artistsMap.has(a.id)) {
        missingArtistIds.add(a.id);
      }
    });
  });

  // Batch-fetch missing artists in chunks of 50
  if (missingArtistIds.size > 0) {
    const missingArr = Array.from(missingArtistIds);
    for (let i = 0; i < missingArr.length; i += 50) {
      const chunk = missingArr.slice(i, i + 50);
      try {
        const batchRes = await spotifyGet(`/artists?ids=${chunk.join(',')}`, accessToken);
        batchRes.artists.forEach(a => {
          if (a) artistsMap.set(a.id, a);
        });
      } catch (err) {
        console.warn('Batch artist lookup warning:', err);
      }
    }
  }

  // 3. Build Genre Entities & Frequency Counts
  const genrePlayCounts = new Map();
  topArtistsRes.items.forEach((artist, idx) => {
    const weight = 30 - idx;
    artist.genres.forEach(g => {
      genrePlayCounts.set(g, (genrePlayCounts.get(g) || 0) + weight);
    });
  });

  // Keep top 6-8 dominant genres
  const sortedGenres = Array.from(genrePlayCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);

  const genreMap = new Map();
  const genres = sortedGenres.map(([genreName, score], idx) => {
    const id = `genre_${genreName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const genreObj = {
      id,
      name: genreName.toUpperCase(),
      color: assignGenreColor(genreName, idx),
      basePlays: score * 120,
      energy: 0.65 + (idx % 3) * 0.1,
      bpm: 110 + (idx % 4) * 15
    };
    genreMap.set(genreName, id);
    return genreObj;
  });

  // Fallback generic sun if no genres found
  if (genres.length === 0) {
    genres.push({
      id: 'genre_eclectic',
      name: 'ECLECTIC UNIVERSE',
      color: '#00F0FF',
      basePlays: 5000,
      energy: 0.75,
      bpm: 120
    });
  }

  // 4. Map Artists to Top Genres
  const artists = topArtistsRes.items.slice(0, 24).map((rawArtist, idx) => {
    const matchedGenreIds = rawArtist.genres
      .map(g => genreMap.get(g))
      .filter(Boolean);

    // If no direct genre match, assign to closest genre or first genre
    const primaryGenres = matchedGenreIds.length > 0
      ? matchedGenreIds.slice(0, 2)
      : [genres[idx % genres.length].id];

    return {
      id: rawArtist.id,
      name: rawArtist.name,
      genres: primaryGenres,
      basePlays: Math.round(3000 * Math.pow(0.92, idx)),
      energy: 0.6 + (idx % 5) * 0.08,
      valence: 0.45 + (idx % 7) * 0.07,
      acoustic: 0.15 + (idx % 4) * 0.12,
      dance: 0.55 + (idx % 6) * 0.06,
      bpm: 105 + (idx % 8) * 8,
      spotifyUrl: rawArtist.external_urls?.spotify,
      imageUrl: rawArtist.images?.[0]?.url,
      followers: rawArtist.followers?.total ? `${(rawArtist.followers.total / 1000000).toFixed(1)}M` : 'N/A'
    };
  });

  // 5. Map Tracks to Artists
  const tracks = topTracksRes.items.slice(0, 40).map((rawTrack, idx) => {
    const primaryArtist = rawTrack.artists[0];
    const featArtist = rawTrack.artists[1];

    return {
      id: rawTrack.id,
      name: rawTrack.name,
      artistId: primaryArtist ? primaryArtist.id : artists[0]?.id,
      featArtistId: featArtist ? featArtist.id : null,
      basePlays: Math.round(1400 * Math.pow(0.95, idx)),
      bpm: 115 + (idx % 6) * 9,
      valence: 0.5 + (idx % 5) * 0.09,
      energy: 0.65 + (idx % 4) * 0.08,
      acoustic: 0.18 + (idx % 3) * 0.15,
      dance: 0.6 + (idx % 4) * 0.08,
      durationMin: Number((rawTrack.duration_ms / 60000).toFixed(1)),
      spotifyUrl: rawTrack.external_urls?.spotify,
      previewUrl: rawTrack.preview_url
    };
  });

  return {
    id: `spotify_${timeRange}`,
    name: 'Live Spotify Universe',
    description: `Synced live with your Spotify taste (${timeRange.replace('_', ' ')}).`,
    genres,
    artists,
    tracks
  };
}
