// src/etl/streamingHistoryParser.js
import { assignGenreForArtist } from './genreClassifier.js';
import { GENRE_PALETTES } from '../config/constants.js';

/**
 * Parses user-uploaded Spotify GDPR extended history JSON (StreamingHistory_*.json or endsong_*.json)
 */
export function parseStreamingHistoryJson(jsonContent) {
  let records = [];
  try {
    records = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
    if (!Array.isArray(records)) {
      throw new Error('Expected JSON array of streaming records.');
    }
  } catch (err) {
    throw new Error(`Invalid JSON format: ${err.message}`);
  }

  const artistPlays = new Map();
  const trackPlays = new Map();
  const timestampedEvents = [];

  for (const row of records) {
    const rawTime = row.ts || row.endTime;
    const artist = row.artistName || row.master_metadata_album_artist_name;
    const track = row.trackName || row.master_metadata_track_name;
    const msPlayed = row.msPlayed ?? row.ms_played ?? 0;

    // Filter out skips under 30 seconds
    if (!artist || msPlayed < 30000) continue;

    const playCount = 1;
    artistPlays.set(artist, (artistPlays.get(artist) || 0) + playCount);

    if (track) {
      const trackKey = `${track} — ${artist}`;
      trackPlays.set(trackKey, {
        name: track,
        artist,
        plays: (trackPlays.get(trackKey)?.plays || 0) + 1,
        ms: (trackPlays.get(trackKey)?.ms || 0) + msPlayed
      });
    }

    if (rawTime) {
      const timestamp = new Date(rawTime).getTime();
      if (!isNaN(timestamp)) {
        timestampedEvents.push({ timestamp, artist, track, msPlayed });
      }
    }
  }

  if (artistPlays.size === 0) {
    throw new Error('No valid music streams found in uploaded file.');
  }

  // 1. Top 20 Artists
  const topArtistsList = Array.from(artistPlays.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // 2. Discover or classify genres
  const genreBuckets = new Map();
  topArtistsList.forEach(([artistName, plays], idx) => {
    const genre = assignGenreForArtist(artistName);
    if (!genreBuckets.has(genre)) {
      genreBuckets.set(genre, { name: genre, plays: 0, artists: [] });
    }
    const b = genreBuckets.get(genre);
    b.plays += plays;
    b.artists.push(artistName);
  });

  const paletteValues = Object.values(GENRE_PALETTES);
  const genres = Array.from(genreBuckets.values()).map((g, idx) => ({
    id: `genre_${g.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
    name: g.name.toUpperCase(),
    color: paletteValues[idx % paletteValues.length],
    basePlays: g.plays,
    energy: 0.7 + (idx % 3) * 0.1,
    bpm: 112 + (idx % 4) * 12
  }));

  const genreMap = new Map();
  genres.forEach(g => genreMap.set(g.name.toLowerCase(), g.id));

  // 3. Artists
  const artists = topArtistsList.map(([artistName, plays], idx) => {
    const genreName = assignGenreForArtist(artistName);
    const genreId = genreMap.get(genreName.toLowerCase()) || genres[0].id;
    return {
      id: `artist_${artistName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      name: artistName,
      genres: [genreId],
      basePlays: plays,
      energy: 0.65 + (idx % 4) * 0.08,
      valence: 0.5 + (idx % 5) * 0.08,
      acoustic: 0.2 + (idx % 4) * 0.12,
      dance: 0.6 + (idx % 5) * 0.06,
      bpm: 110 + (idx % 6) * 10,
      followers: 'Stream Archive'
    };
  });

  const artistObjMap = new Map();
  artists.forEach(a => artistObjMap.set(a.name.toLowerCase(), a.id));

  // 4. Tracks
  const topTracksList = Array.from(trackPlays.values())
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 35);

  const tracks = topTracksList.map((t, idx) => {
    const parentArtistId = artistObjMap.get(t.artist.toLowerCase()) || artists[0].id;
    return {
      id: `track_${t.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      name: t.name,
      artistId: parentArtistId,
      basePlays: t.plays,
      bpm: 115 + (idx % 5) * 11,
      valence: 0.55 + (idx % 4) * 0.08,
      energy: 0.7 + (idx % 3) * 0.09,
      acoustic: 0.18 + (idx % 4) * 0.14,
      dance: 0.62 + (idx % 5) * 0.06,
      durationMin: Number(((t.ms / Math.max(1, t.plays)) / 60000).toFixed(1))
    };
  });

  return {
    dataset: {
      id: 'custom_upload',
      name: 'Archive Universe',
      description: `Parsed from Spotify Extended Streaming History (${records.length} events).`,
      genres,
      artists,
      tracks
    },
    rawEvents: timestampedEvents
  };
}
