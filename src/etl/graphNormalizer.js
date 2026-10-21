// src/etl/graphNormalizer.js
import { TIER_BOUNDS, COLOR_SPOTIFY_GREEN } from '../config/constants.js';
import { getDistinctClusterColor, UNCLASSIFIED_FAMILY } from '../config/genreTaxonomy.js';

/**
 * Normalizes raw celestial entities (genres, artists, tracks) into graph nodes & edges
 * using Base-10 Logarithmic Normalization to prevent Zipf power-law visual collapse.
 *
 * Assigns each cluster (in size order) a unique maximally-distant color from
 * `ORDERED_CLUSTER_COLORS` (and 137.5° OKLCH overflow past 24 clusters) so even
 * cached snapshots immediately display distinct cluster colors without collisions.
 */
export function buildUniverseGraph(rawDataset, timeMultiplier = 1.0) {
  const { genres = [], artists = [], tracks = [] } = rawDataset;

  // Sort non-uncharted clusters by size/plays descending to assign greedy farthest-point colors in size order
  const rankedGenres = genres
    .filter(g => g.family !== UNCLASSIFIED_FAMILY.id && g.name !== UNCLASSIFIED_FAMILY.label)
    .slice()
    .sort((a, b) => (b.basePlays || 0) - (a.basePlays || 0));

  const assignedColorById = new Map();
  rankedGenres.forEach((g, idx) => {
    assignedColorById.set(g.id, getDistinctClusterColor(idx));
  });

  // Flatten entities with explicit tier types and distinct OKLCH cluster colors
  const rawNodes = [
    ...genres.map(g => ({
      ...g,
      type: 'genre',
      color: (g.family === UNCLASSIFIED_FAMILY.id || g.name === UNCLASSIFIED_FAMILY.label)
        ? UNCLASSIFIED_FAMILY.color
        : (assignedColorById.get(g.id) || g.color || getDistinctClusterColor(0))
    })),
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
      collaboratorArtistIds: new Set(),
      collabTrackIds: new Set(),
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
      node.color = genreColors[0] || getDistinctClusterColor(0);
      node.connectedGenres = parentGenreIds.map(gId => nodeMap.get(gId)?.name).filter(Boolean);
    } else if (node.type === 'track') {
      const parentArtist = nodeMap.get(node.artistId);
      // Moons always match their parent artist's color
      node.color = parentArtist?.color || node.color || COLOR_SPOTIFY_GREEN;
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

    const sizeScore = Math.pow(normScore, bounds.curve || 1);
    const baseRadius = bounds.minR + sizeScore * (bounds.maxR - bounds.minR);
    const haloRadius = baseRadius * bounds.haloMult;

    return {
      ...node,
      normScore: Number(normScore.toFixed(4)),
      baseRadius: Number(baseRadius.toFixed(2)),
      haloRadius: Number(haloRadius.toFixed(2))
    };
  });

  normalizedNodes.forEach(n => nodeMap.set(n.id, n));

  // 4. Build Edge Network (Artist-to-Genre, Track-to-Artist, and Multi-Artist Collaborations)
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

      // Feature collaboration edges use the same color as the parent artist/song
      const featIds = Array.isArray(node.featArtistIds) && node.featArtistIds.length
        ? node.featArtistIds
        : (node.featArtistId ? [node.featArtistId] : []);

      const involvedArtists = [artistNode].filter(Boolean);
      featIds.forEach(fId => {
        const featArtist = nodeMap.get(fId);
        if (!featArtist || featArtist.id === node.artistId) return;
        edges.push({
          id: `edge_collab_${node.id}_${featArtist.id}`,
          source: node,
          target: featArtist,
          type: 'track_collab',
          color: artistNode?.color || node.color || featArtist.color
        });
        node.neighbors.add(featArtist.id);
        featArtist.neighbors.add(node.id);
        involvedArtists.push(featArtist);
        if (!node.connectedArtists.includes(featArtist.name)) {
          node.connectedArtists.push(featArtist.name);
        }
      });

      if (involvedArtists.length > 1) {
        for (let i = 0; i < involvedArtists.length; i++) {
          involvedArtists[i].collabTrackIds.add(node.id);
          for (let j = 0; j < involvedArtists.length; j++) {
            if (i !== j) {
              involvedArtists[i].collaboratorArtistIds.add(involvedArtists[j].id);
            }
          }
        }
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
