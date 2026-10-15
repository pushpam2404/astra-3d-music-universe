// src/etl/graphNormalizer.js
import { TIER_BOUNDS, COLOR_SPOTIFY_GREEN } from '../config/constants.js';

/**
 * Normalizes raw celestial entities (genres, artists, tracks) into graph nodes & edges
 * using Base-10 Logarithmic Normalization to prevent Zipf power-law visual collapse.
 */
export function buildUniverseGraph(rawDataset, timeMultiplier = 1.0) {
  const { genres = [], artists = [], tracks = [] } = rawDataset;

  // Flatten entities with explicit tier types
  const rawNodes = [
    ...genres.map(g => ({ ...g, type: 'genre', color: g.color || '#FF007F' })),
    ...artists.map(a => ({ ...a, type: 'artist' })),
    ...tracks.map(t => ({ ...t, type: 'track' }))
  ];

  // 1. Calculate per-tier log10 bounds and total play sums
  const statsByTier = {
    genre:  { minLog: Infinity, maxLog: -Infinity, totalPlays: 0 },
    artist: { minLog: Infinity, maxLog: -Infinity, totalPlays: 0 },
    track:  { minLog: Infinity, maxLog: -Infinity, totalPlays: 0 }
  };

  const processedNodes = rawNodes.map(node => {
    const plays = Math.max(1, Math.round((node.basePlays || 10) * timeMultiplier));
    const logPlays = Math.log10(plays + 1);
    const tierStat = statsByTier[node.type];
    if (tierStat) {
      tierStat.minLog = Math.min(tierStat.minLog, logPlays);
      tierStat.maxLog = Math.max(tierStat.maxLog, logPlays);
      tierStat.totalPlays += plays;
    }
    return {
      ...node,
      plays,
      logPlays,
      neighbors: new Set(),
      connectedGenres: [],
      connectedArtists: []
    };
  });

  // Map for fast O(1) lookups
  const nodeMap = new Map();
  processedNodes.forEach(node => nodeMap.set(node.id, node));

  // 2. Assign resolved colors and connected references
  processedNodes.forEach(node => {
    if (node.type === 'artist') {
      const parentGenreIds = node.genres || [];
      const genreColors = parentGenreIds.map(gId => nodeMap.get(gId)?.color).filter(Boolean);
      node.color = genreColors[0] || '#00F0FF';
      node.connectedGenres = parentGenreIds.map(gId => nodeMap.get(gId)?.name).filter(Boolean);
    } else if (node.type === 'track') {
      const parentArtist = nodeMap.get(node.artistId);
      // Moons take their planet's (cluster) color unless the dataset sets one.
      node.color = node.color || parentArtist?.color || COLOR_SPOTIFY_GREEN;
      if (parentArtist) {
        node.connectedArtists = [parentArtist.name];
        if (parentArtist.connectedGenres?.length) {
          node.connectedGenres = [...parentArtist.connectedGenres];
        }
      }
    }
  });

  // 3. Normalize radii and compute gravitational mass & telemetry
  const normalizedNodes = processedNodes.map(node => {
    const tierStat = statsByTier[node.type];
    const bounds = TIER_BOUNDS[node.type] || TIER_BOUNDS.track;

    const span = Math.max(1e-6, tierStat.maxLog - tierStat.minLog);
    const normScore = Math.max(0.0, Math.min(1.0, (node.logPlays - tierStat.minLog) / span));

    const baseRadius = bounds.minR + normScore * (bounds.maxR - bounds.minR);
    const haloRadius = baseRadius * bounds.haloMult;

    return {
      ...node,
      normScore: Number(normScore.toFixed(4)),
      baseRadius: Number(baseRadius.toFixed(2)),
      haloRadius: Number(haloRadius.toFixed(2))
    };
  });

  // Update nodeMap with normalized references
  normalizedNodes.forEach(n => nodeMap.set(n.id, n));

  // 4. Build Edge Network (Artist-to-Genre, Track-to-Artist, Collab)
  const edges = [];

  normalizedNodes.forEach(node => {
    if (node.type === 'artist' && Array.isArray(node.genres)) {
      node.genres.forEach(genreId => {
        const genreNode = nodeMap.get(genreId);
        if (genreNode) {
          edges.push({
            id: `edge_${node.id}_${genreId}`,
            source: node,
            target: genreNode,
            type: 'artist_genre',
            color: genreNode.color
          });
          node.neighbors.add(genreId);
          genreNode.neighbors.add(node.id);
        }
      });
    } else if (node.type === 'track') {
      const artistNode = nodeMap.get(node.artistId);
      if (artistNode) {
        edges.push({
          id: `edge_${node.id}_${node.artistId}`,
          source: node,
          target: artistNode,
          type: 'track_artist',
          color: artistNode.color || COLOR_SPOTIFY_GREEN
        });
        node.neighbors.add(node.artistId);
        artistNode.neighbors.add(node.id);
      }

      // Feature collaboration edges if present
      if (node.featArtistId && nodeMap.has(node.featArtistId)) {
        const featArtist = nodeMap.get(node.featArtistId);
        edges.push({
          id: `edge_collab_${node.id}_${featArtist.id}`,
          source: node,
          target: featArtist,
          type: 'track_collab',
          color: '#FFB800'
        });
        node.neighbors.add(featArtist.id);
        featArtist.neighbors.add(node.id);
      }
    }
  });

  return {
    nodes: normalizedNodes,
    edges,
    nodeMap,
    statsByTier
  };
}
