// src/etl/graphNormalizer.js
import { TIER_BOUNDS, COLOR_SPOTIFY_GREEN } from '../config/constants.js';
import { GENRE_FAMILIES } from '../config/genreTaxonomy.js';

/**
 * Maps legacy bright/neon hex colors (from cached snapshots or older builds)
 * onto Astra's refined celestial luxury palette.
 */
const LEGACY_COLOR_UPGRADE = {
  '#FF7A1A': '#D98A5B', // Hip-Hop: Warm Terracotta Copper
  '#FFC53D': '#E2B86B', // South Asian: Champagne Saffron Gold
  '#FFB800': '#E2B86B',
  '#FF4FA3': '#D87A9E', // Pop: Velvet Rose
  '#FF007F': '#D87A9E',
  '#4F8BFF': '#6E98C8', // Rock & Indie: Celestial Slate Sapphire
  '#0070F3': '#6E98C8',
  '#00E5FF': '#5DB5B0', // Electronic: Sea-Glass Verdigris
  '#00F0FF': '#5DB5B0',
  '#B36BFF': '#A582C8', // R&B: Twilight Amethyst
  '#9D00FF': '#A582C8',
  '#FF3B4A': '#C96567', // Metal: Garnet Oxide
  '#FF3366': '#C96567',
  '#8BE36B': '#88B382', // Folk: Sage Celadon
  '#00FFA3': '#82B8A0',
  '#38EF7D': '#82B8A0',
  '#3DDBB5': '#64A8A0', // Jazz: Aegean Teal
  '#E9E1C8': '#DFD3BA', // Classical: Warm Alabaster Pearl
  '#FF6B4A': '#D97762', // Latin: Spiced Cinnabar
  '#FF8000': '#D98A5B',
  '#FF9BE0': '#CFA0C8', // Asian Pop: Orchid Silk
  '#7FD1FF': '#7BA7C2',
  '#FFB3C7': '#D495A7',
  '#C9A2FF': '#A892C4',
  '#9EF0C4': '#82B8A0',
  '#FFD59E': '#D9B67E',
  '#A3B8FF': '#8C9EC9',
  '#F7A8FF': '#C796B8',
  '#B8F2E6': '#8ABCB9',
  '#6B7290': '#6E768C'
};

function refineClusterColor(rawColor, familyId) {
  if (familyId && GENRE_FAMILIES[familyId] && (!rawColor || LEGACY_COLOR_UPGRADE[rawColor.toUpperCase()])) {
    const up = rawColor ? LEGACY_COLOR_UPGRADE[rawColor.toUpperCase()] : null;
    return up || GENRE_FAMILIES[familyId].color;
  }
  if (!rawColor) return '#D87A9E';
  const upper = String(rawColor).toUpperCase();
  if (LEGACY_COLOR_UPGRADE[upper]) return LEGACY_COLOR_UPGRADE[upper];

  // Soften any overly saturated legacy HSL variant color into a muted jewel tone
  if (/^#[0-9A-F]{6}$/.test(upper)) {
    const v = parseInt(upper.slice(1), 16);
    const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d > 0) {
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (s > 0.65) {
        const h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
        const targetS = 0.48;
        const targetL = Math.min(0.68, Math.max(0.54, l));
        const k = (x) => (x + h / 30) % 12;
        const a = targetS * Math.min(targetL, 1 - targetL);
        const f = (x) => Math.round(255 * (targetL - a * Math.max(-1, Math.min(k(x) - 3, Math.min(9 - k(x), 1)))));
        return `#${[f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
      }
    }
  }
  return rawColor;
}

/**
 * Normalizes raw celestial entities (genres, artists, tracks) into graph nodes & edges
 * using Base-10 Logarithmic Normalization to prevent Zipf power-law visual collapse.
 */
export function buildUniverseGraph(rawDataset, timeMultiplier = 1.0) {
  const { genres = [], artists = [], tracks = [] } = rawDataset;

  // Flatten entities with explicit tier types and refined luxury cluster colors
  const rawNodes = [
    ...genres.map(g => ({ ...g, type: 'genre', color: refineClusterColor(g.color, g.family) })),
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
      node.color = genreColors[0] || '#7BA7C2';
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

      // Feature collaboration edges use the same color as the parent artist/song (not blue)
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
