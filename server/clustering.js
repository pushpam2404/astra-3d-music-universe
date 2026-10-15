// server/clustering.js
/**
 * Data-driven artist clustering.
 *
 * 1. Similarity graph: artists are linked by tag overlap (TF-IDF cosine over fine genres
 *    and country, so a shared "qawwali" or "India" counts more than a shared "pop")
 *    blended with genre-family overlap, plus a bonus for collaborating on a top track.
 * 2. Louvain community detection on that graph finds the clusters.
 * 3. Splinter clusters (under ~1% of artists) merge into their best-linked neighbour;
 *    isolated artists join the cluster they resemble most, or "Uncharted" if nothing.
 * 4. clusterNaming.js names each cluster by its most distinctive genres and home, and
 *    artists with strong ties to a second cluster are marked as bridges.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { UMAP } from 'umap-js';
import { familyVector, UNCLASSIFIED_FAMILY } from '../src/config/genreTaxonomy.js';
import { describeClusters } from './clusterNaming.js';

const LOUVAIN_RESOLUTION = 1.3;
// Countries are a scene signal, slightly weaker than an actual genre tag.
const COUNTRY_TAG_WEIGHT = 0.85;
const EDGE_THRESHOLD = 0.12;
const BRIDGE_MIN_AFFINITY = 0.18;
const BRIDGE_RATIO = 0.65;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cosine(a, b) {
  let dot = 0;
  for (const k in a) if (b[k]) dot += a[k] * b[k];
  return dot;
}

function l2normalize(vec) {
  const norm = Math.sqrt(Object.values(vec).reduce((s, v) => s + v * v, 0)) || 1;
  Object.keys(vec).forEach(k => { vec[k] /= norm; });
  return vec;
}

function famCosine(a, b) {
  const na = Math.sqrt(Object.values(a).reduce((s, v) => s + v * v, 0));
  const nb = Math.sqrt(Object.values(b).reduce((s, v) => s + v * v, 0));
  return na && nb ? cosine(a, b) / (na * nb) : 0;
}

const EMBED_NEIGHBORS = 15;
// How strongly cluster membership pulls the embedding together (0 = pure similarity).
const EMBED_CLUSTER_WEIGHT = 0.35;

/**
 * UMAP on the artist similarity matrix → 3D coordinates where nearby means similar.
 * Neighbours are taken straight from the similarity scores (distance = 1 − similarity),
 * and cluster labels are blended in so each cluster stays a coherent region.
 * Output is centered, with the 90th-percentile radius scaled to 1. Deterministic.
 */
function embed3d(n, simMatrix, labels) {
  if (n < 8) return null;
  const k = Math.min(EMBED_NEIGHBORS, n - 1);
  const knnIndices = [];
  const knnDistances = [];
  const order = new Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) order[j] = j;
    order.sort((x, y) => (y === i) - (x === i) || simMatrix[i * n + y] - simMatrix[i * n + x]);
    const idx = order.slice(0, k);
    knnIndices.push(idx);
    knnDistances.push(idx.map(j => (j === i ? 0 : 1 - Math.min(1, simMatrix[i * n + j]))));
  }

  const umap = new UMAP({ nComponents: 3, nNeighbors: k, minDist: 0.3, spread: 1.0, nEpochs: 300, random: mulberry32(7) });
  umap.setPrecomputedKNN(knnIndices, knnDistances);
  umap.setSupervisedProjection(labels, { targetWeight: EMBED_CLUSTER_WEIGHT });
  const raw = umap.fit(Array.from({ length: n }, (_, i) => [i]));

  const mean = [0, 1, 2].map(d => raw.reduce((s, p) => s + p[d], 0) / n);
  const centered = raw.map(p => p.map((v, d) => v - mean[d]));
  const radii = centered.map(p => Math.hypot(...p)).sort((a, b) => a - b);
  const scale = radii[Math.floor(n * 0.9)] || 1;
  return centered.map(p => p.map(v => Number((v / scale).toFixed(4))));
}

/**
 * @param {Array<{id, name, genres: string[], countries: string[], score: number}>} artists  genres normalized
 * @param {Map<string, number>} collabs  key "idA|idB" (sorted) → number of shared top tracks
 */
export function clusterArtists(artists, collabs) {
  const byId = new Map(artists.map(a => [a.id, a]));
  // Bigger libraries earn more clusters, within what a legend can still show.
  const maxClusters = Math.max(8, Math.min(16, Math.round(Math.sqrt(artists.length) * 0.9)));

  // Tag TF-IDF vectors (genres + "@country") and family vectors (genres only).
  artists.forEach(a => {
    a.countries = a.countries || [];
    a.tags = [...new Set([...a.genres, ...a.countries.map(c => `@${c}`)])];
  });
  const df = new Map();
  artists.forEach(a => a.tags.forEach(t => df.set(t, (df.get(t) || 0) + 1)));
  const n = artists.length;
  artists.forEach(a => {
    const vec = {};
    a.tags.forEach(t => { vec[t] = Math.log(1 + n / df.get(t)) * (t.startsWith('@') ? COUNTRY_TAG_WEIGHT : 1); });
    a.tfidf = l2normalize(vec);
    a.fam = familyVector(a.genres);
  });

  // Pairwise link weights.
  const weight = new Map();
  const key = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const rawSim = (a, b) => {
    let w = 0;
    if (a.tags.length && b.tags.length) {
      w = 0.55 * cosine(a.tfidf, b.tfidf) + 0.45 * famCosine(a.fam, b.fam);
    }
    const shared = collabs.get(key(a.id, b.id)) || 0;
    if (shared) w += Math.min(1, 0.45 * shared);
    return w;
  };
  // Full similarity matrix (kept for the 3D embedding) + thresholded graph edges.
  const simMatrix = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const w = rawSim(artists[i], artists[j]);
      simMatrix[i * n + j] = simMatrix[j * n + i] = w;
      if (w >= EDGE_THRESHOLD) weight.set(key(artists[i].id, artists[j].id), w);
    }
  }
  const linkW = (x, y) => (x === y ? 0 : weight.get(key(x, y)) || 0);

  // Louvain communities.
  const graph = new Graph({ type: 'undirected' });
  artists.forEach(a => graph.addNode(a.id));
  weight.forEach((w, k) => {
    const [x, y] = k.split('|');
    graph.addEdge(x, y, { weight: w });
  });
  const communityOf = graph.size > 0
    ? louvain(graph, { getEdgeWeight: 'weight', resolution: LOUVAIN_RESOLUTION, rng: mulberry32(42) })
    : {};

  let clusters = new Map();
  const orphans = [];
  artists.forEach(a => {
    if (graph.degree(a.id) === 0) {
      orphans.push(a.id);
      return;
    }
    const c = communityOf[a.id];
    if (!clusters.has(c)) clusters.set(c, []);
    clusters.get(c).push(a.id);
  });
  clusters = [...clusters.values()];

  // Merge splinters and overflow into their best-linked neighbour. Artists left
  // without any community join the cluster they resemble most, however weakly; only
  // artists with no signal at all end up "Uncharted".
  const minClusterSize = Math.max(4, Math.round(n * 0.01));
  const linkage = (A, B) => {
    let sum = 0;
    A.forEach(x => B.forEach(y => { sum += linkW(x, y); }));
    return sum / (A.length * B.length);
  };
  const rawLinkage = (id, C) => {
    const a = byId.get(id);
    let sum = 0;
    C.forEach(y => { if (y !== id) sum += rawSim(a, byId.get(y)); });
    return sum / C.length;
  };

  let merged = true;
  while (merged && clusters.length > 1) {
    merged = false;
    clusters.sort((A, B) => A.length - B.length);
    for (let i = 0; i < clusters.length; i++) {
      const C = clusters[i];
      if (C.length >= minClusterSize && !(clusters.length > maxClusters && i === 0)) continue;
      let best = -1, bestLink = 0;
      clusters.forEach((D, j) => {
        if (j === i) return;
        const l = linkage(C, D);
        if (l > bestLink) { bestLink = l; best = j; }
      });
      if (best < 0) {
        orphans.push(...C);
      } else {
        clusters[best].push(...C);
      }
      clusters.splice(i, 1);
      merged = true;
      break;
    }
  }

  const uncharted = [];
  orphans.forEach(id => {
    let best = -1, bestLink = 0.02;
    clusters.forEach((C, j) => {
      const l = rawLinkage(id, C);
      if (l > bestLink) { bestLink = l; best = j; }
    });
    if (best >= 0) clusters[best].push(id);
    else uncharted.push(id);
  });

  const described = describeClusters(clusters, uncharted, byId, n);

  // Assignment + bridges.
  const clusterOf = new Map();
  described.forEach(c => c.members.forEach(id => clusterOf.set(id, c.id)));
  const assignment = new Map();
  artists.forEach(a => {
    const own = clusterOf.get(a.id);
    const affinity = (c) => {
      const others = c.members.filter(id => id !== a.id);
      return others.length ? others.reduce((s, id) => s + linkW(a.id, id), 0) / others.length : 0;
    };
    const ownAffinity = affinity(described.find(c => c.id === own));
    let bridge = null;
    described.forEach(c => {
      if (c.id === own || c.family === UNCLASSIFIED_FAMILY.id) return;
      const aff = affinity(c);
      if (aff >= BRIDGE_MIN_AFFINITY && aff >= BRIDGE_RATIO * ownAffinity && (!bridge || aff > bridge.affinity)) {
        bridge = { clusterId: c.id, affinity: aff };
      }
    });
    assignment.set(a.id, {
      clusterId: own,
      bridge: bridge ? { clusterId: bridge.clusterId, weight: Number((bridge.affinity / (ownAffinity + bridge.affinity || 1)).toFixed(2)) } : null
    });
  });

  // Cluster-to-cluster affinity, used by the frontend to put related suns side by side.
  const affinityMatrix = {};
  described.forEach(A => {
    affinityMatrix[A.id] = {};
    described.forEach(B => {
      if (A.id !== B.id) affinityMatrix[A.id][B.id] = Number(linkage(A.members, B.members).toFixed(3));
    });
  });

  // 3D positions where distance means dissimilarity (for the "Similarity" view).
  const clusterIndex = new Map(described.map((c, i) => [c.id, i]));
  const embedding = embed3d(n, simMatrix, artists.map(a => clusterIndex.get(assignment.get(a.id).clusterId)));
  const positions = new Map();
  if (embedding) artists.forEach((a, i) => positions.set(a.id, embedding[i]));

  return { clusters: described, assignment, affinityMatrix, positions };
}
