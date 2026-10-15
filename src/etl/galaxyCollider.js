// src/etl/galaxyCollider.js
import { COLOR_LAGRANGE_GOLD, COLOR_USER_A_CYAN, COLOR_USER_B_MAGENTA } from '../config/constants.js';

/**
 * Merges two user universe datasets into a Binary-Star Collision Graph (Blueprint 08)
 * and computes the multi-dimensional Cosmic Resonance Score.
 */
export function collideGalaxies(universeA, universeB) {
  const mergedNodesMap = new Map();
  const makeKey = (type, name) => `${type}::${name.trim().toLowerCase()}`;

  // 1. Ingest User A's Nodes (Anchored Left at X = -140)
  universeA.nodes.forEach(node => {
    const key = makeKey(node.type, node.name);
    mergedNodesMap.set(key, {
      ...node,
      canonicalKey: key,
      owner: 'USER_A', // 'USER_A' | 'USER_B' | 'SHARED_BRIDGE'
      playsA: node.plays,
      playsB: 0,
      plays: node.plays,
      galaxyCenter: { x: -140, y: 0, z: 0 },
      color: node.type === 'track' ? COLOR_USER_A_CYAN : (node.color || COLOR_USER_A_CYAN),
      originalColor: node.color
    });
  });

  // 2. Ingest User B's Nodes & Detect Shared Lagrange Bridge Nodes (Anchored Right at X = +140)
  universeB.nodes.forEach(node => {
    const key = makeKey(node.type, node.name);
    if (mergedNodesMap.has(key)) {
      // COLLISION DETECTED: Node exists in both universes!
      const shared = mergedNodesMap.get(key);
      shared.owner = 'SHARED_BRIDGE';
      shared.playsB = node.plays;
      shared.plays = shared.playsA + node.plays;
      // Pull shared bridge nodes into the L1 Lagrange point at the origin (0, 0, 0)
      shared.galaxyCenter = { x: 0, y: 0, z: 0 };
      shared.color = COLOR_LAGRANGE_GOLD; // Supernova Solar Gold for shared taste
      shared.isWormholeBridge = true;
    } else {
      mergedNodesMap.set(key, {
        ...node,
        canonicalKey: key,
        owner: 'USER_B',
        playsA: 0,
        playsB: node.plays,
        plays: node.plays,
        galaxyCenter: { x: 140, y: 0, z: 0 },
        color: node.type === 'track' ? COLOR_USER_B_MAGENTA : (node.color || COLOR_USER_B_MAGENTA),
        originalColor: node.color
      });
    }
  });

  const allMergedNodes = Array.from(mergedNodesMap.values());
  const sharedBridgeNodes = allMergedNodes.filter(n => n.owner === 'SHARED_BRIDGE');

  // 3. Compute Weighted Jaccard Similarity for Artists and Genres
  const calcWeightedJaccard = (tierType) => {
    const tierNodes = allMergedNodes.filter(n => n.type === tierType);
    if (tierNodes.length === 0) return 0;
    let minSum = 0;
    let maxSum = 0;
    tierNodes.forEach(n => {
      minSum += Math.min(n.playsA, n.playsB);
      maxSum += Math.max(n.playsA, n.playsB);
    });
    return maxSum > 0 ? minSum / maxSum : 0;
  };

  const jaccardArtists = calcWeightedJaccard('artist');
  const jaccardGenres = calcWeightedJaccard('genre');

  // 4. Compute 5D Audio DNA Cosine Similarity
  const computeCentroid = (nodes, ownerKey) => {
    const relevant = nodes.filter(n => (n.owner === ownerKey || n.owner === 'SHARED_BRIDGE') && n.energy !== undefined);
    if (relevant.length === 0) return [0.7, 0.6, 0.5, 0.2, 0.4];

    let totalWeight = 0;
    const sum = [0, 0, 0, 0, 0];

    relevant.forEach(n => {
      const w = n.plays || 1;
      totalWeight += w;
      sum[0] += (n.energy ?? 0.7) * w;
      sum[1] += (n.dance ?? 0.6) * w;
      sum[2] += (n.valence ?? 0.5) * w;
      sum[3] += (n.acoustic ?? 0.2) * w;
      sum[4] += (Math.max(0, Math.min(1, ((n.bpm || 120) - 60) / 140))) * w;
    });

    return sum.map(v => v / Math.max(1, totalWeight));
  };

  const centroidA = computeCentroid(allMergedNodes, 'USER_A');
  const centroidB = computeCentroid(allMergedNodes, 'USER_B');

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < 5; i++) {
    dotProduct += centroidA[i] * centroidB[i];
    magA += centroidA[i] * centroidA[i];
    magB += centroidB[i] * centroidB[i];
  }
  const cosineSim = (magA > 0 && magB > 0) ? dotProduct / (Math.sqrt(magA) * Math.sqrt(magB)) : 0.8;

  // 5. Total Compatibility Score S_total
  const resonanceScore = Math.round(
    100 * (0.35 * Math.min(1, jaccardArtists * 1.8 + (sharedBridgeNodes.length > 0 ? 0.2 : 0)) +
           0.35 * Math.min(1, jaccardGenres * 1.5 + 0.15) +
           0.30 * cosineSim)
  );

  return {
    nodes: allMergedNodes,
    edges: [...(universeA.edges || []), ...(universeB.edges || [])],
    metrics: {
      resonanceScore: Math.min(100, Math.max(12, resonanceScore)),
      sharedCount: sharedBridgeNodes.length,
      jaccardArtists: (jaccardArtists * 100).toFixed(1),
      jaccardGenres: (jaccardGenres * 100).toFixed(1),
      cosineSim: (cosineSim * 100).toFixed(1),
      sharedNodes: sharedBridgeNodes
    }
  };
}
