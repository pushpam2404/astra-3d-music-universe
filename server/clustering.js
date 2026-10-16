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
// Played-together bonus for genre-less artists: up to TOGETHER_MAX, reached at
// TOGETHER_FULL (two adjacent plays/likes).
const TOGETHER_MAX = 0.7;
const TOGETHER_FULL = 2;
// Played-together weight with one cluster that moves a genre-less artist into it.
const TOGETHER_REASSIGN = 1;
// Sparse similarity: tags shared by more artists than this don't generate candidate pairs,
// each artist is compared with at most MAX_CANDIDATES others and keeps MAX_NEIGHBORS.
const MAX_CANDIDATE_DF = 400;
const MAX_CANDIDATES = 600;
const COMMON_TAG_SLICE = 150;
const MAX_NEIGHBORS = 30;
// Up to this size every pair is compared exactly (as fast as the sparse path there).
const EXACT_LIMIT = 2500;
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

const EMBED_NEIGHBORS = 15;
// How strongly cluster membership pulls the embedding together (0 = pure similarity).
const EMBED_CLUSTER_WEIGHT = 0.35;

/**
 * UMAP on the artist similarity matrix → 3D coordinates where nearby means similar.
 * Neighbours are taken straight from the similarity scores (distance = 1 − similarity),
 * and cluster labels are blended in so each cluster stays a coherent region.
 * Output is centered, with the 90th-percentile radius scaled to 1. Deterministic.
 */
// Gap between clusters, in multiples of a cluster's own size, beyond which the map
// reads as scattered islands. Clean clusters come out of UMAP tight and far apart;
// pulling the cluster centres in (members keep their offsets) keeps one sphere.
const MAX_CLUSTER_GAP_RATIO = 5;
const MAX_ISOLATION = 1.5;

function pairHash(i, j) {
  const a = Math.min(i, j), b = Math.max(i, j);
  return Math.imul(a * 73856093 ^ b * 19349663, 2654435761) >>> 0;
}

function compactClusters(points, labels) {
  const groups = new Map();
  points.forEach((p, i) => {
    if (!groups.has(labels[i])) groups.set(labels[i], []);
    groups.get(labels[i]).push(i);
  });
  if (groups.size < 2) return points;
  const centre = new Map();
  let spread = 0;
  groups.forEach((members, c) => {
    const m = [0, 1, 2].map(d => members.reduce((s, i) => s + points[i][d], 0) / members.length);
    centre.set(c, m);
    spread += members.reduce((s, i) => s + Math.hypot(...points[i].map((v, d) => v - m[d])), 0);
  });
  spread /= points.length;
  const cs = [...centre.values()];
  let gap = 0, pairs = 0;
  for (let a = 0; a < cs.length; a++) {
    for (let b = a + 1; b < cs.length; b++) { gap += Math.hypot(...cs[a].map((v, d) => v - cs[b][d])); pairs++; }
  }
  gap /= pairs;
  const ratio = gap / (spread || 1e-6);
  const k = Math.min(1, MAX_CLUSTER_GAP_RATIO / ratio);
  const target = new Map([...centre].map(([c, m]) => [c, m.map(v => v * k)]));
  // A cluster sharing little with the rest (e.g. artists known only by country) would
  // still float far out on its own: keep it within MAX_ISOLATION × the usual distance
  // from its nearest neighbouring cluster.
  const nearest = new Map();
  target.forEach((m, c) => {
    let best = null, bestD = Infinity;
    target.forEach((o, e) => {
      const dd = e === c ? Infinity : Math.hypot(...m.map((v, d) => v - o[d]));
      if (dd < bestD) { bestD = dd; best = o; }
    });
    nearest.set(c, [best, bestD]);
  });
  const dists = [...nearest.values()].map(x => x[1]).sort((a, b) => a - b);
  const limit = dists[Math.floor(dists.length / 2)] * MAX_ISOLATION;
  nearest.forEach(([o, dd], c) => {
    if (dd <= limit) return;
    const m = target.get(c);
    target.set(c, m.map((v, d) => o[d] + (v - o[d]) * (limit / dd)));
  });
  return points.map((p, i) => {
    const m = centre.get(labels[i]), t = target.get(labels[i]);
    return p.map((v, d) => t[d] + (v - m[d]));
  });
}

function embed3d(n, neighbors, labels) {
  if (n < 8) return null;
  const k = Math.min(EMBED_NEIGHBORS, n - 1);
  // Each row: self first, then most similar neighbours.
  const knnIndices = [];
  const knnDistances = [];
  for (let i = 0; i < n; i++) {
    const idx = [i];
    const dist = [0];
    for (const { j, w } of neighbors[i]) {
      if (idx.length >= k) break;
      idx.push(j);
      dist.push(1 - Math.min(1, w));
    }
    // Pad with unrelated artists at full distance, like a dense kNN would. Padding
    // with same-cluster artists instead cuts every link between clusters, and UMAP
    // then flings the clusters apart as separate islands.
    for (let s = 1; idx.length < k; s++) {
      const j = (i + s * 7919) % n;
      if (!idx.includes(j)) { idx.push(j); dist.push(1); }
    }
    knnIndices.push(idx);
    knnDistances.push(dist);
  }

  const umap = new UMAP({ nComponents: 3, nNeighbors: k, minDist: 0.3, spread: 1.0, nEpochs: n > 4000 ? 150 : 300, random: mulberry32(7) });
  umap.setPrecomputedKNN(knnIndices, knnDistances);
  umap.setSupervisedProjection(labels, { targetWeight: EMBED_CLUSTER_WEIGHT });
  const raw = umap.fit(Array.from({ length: n }, (_, i) => [i]));

  const mean = [0, 1, 2].map(d => raw.reduce((s, p) => s + p[d], 0) / n);
  let centered = raw.map(p => p.map((v, d) => v - mean[d]));
  centered = compactClusters(centered, labels);
  const radii = centered.map(p => Math.hypot(...p)).sort((a, b) => a - b);
  const scale = radii[Math.floor(n * 0.9)] || 1;
  return centered.map(p => p.map(v => Number((v / scale).toFixed(4))));
}

/**
 * @param {Array<{id, name, genres: string[], countries: string[], score: number}>} artists  genres normalized
 * @param {Map<string, number>} collabs  key "idA|idB" (sorted) → number of shared top tracks
 * @param {Map<string, number>} together  same key → how often they're played/liked side by side
 */
export function clusterArtists(artists, collabs, together = new Map()) {
  const byId = new Map(artists.map(a => [a.id, a]));
  // Bigger libraries earn more clusters, within what a legend can still show.
  const maxClusters = Math.max(8, Math.min(16, Math.round(Math.sqrt(artists.length) * 0.9)));

  // Tag TF-IDF vectors (genres + "@country") as sorted sparse arrays, and family vectors.
  const n = artists.length;
  artists.forEach(a => {
    a.countries = a.countries || [];
    a.tags = [...new Set([...a.genres, ...a.countries.map(c => `@${c}`)])];
  });
  const tagId = new Map();
  const df = [];
  artists.forEach(a => a.tags.forEach(t => {
    if (!tagId.has(t)) { tagId.set(t, tagId.size); df.push(0); }
    df[tagId.get(t)]++;
  }));
  const familyIds = new Map();
  artists.forEach((a, i) => {
    a.index = i;
    const entries = a.tags
      .map(t => [tagId.get(t), Math.log(1 + n / df[tagId.get(t)]) * (t.startsWith('@') ? COUNTRY_TAG_WEIGHT : 1)])
      .sort((x, y) => x[0] - y[0]);
    const norm = Math.hypot(...entries.map(e => e[1])) || 1;
    a.vecIdx = Int32Array.from(entries, e => e[0]);
    a.vecW = Float32Array.from(entries, e => e[1] / norm);
    const fam = familyVector(a.genres);
    const famEntries = Object.entries(fam).map(([f, w]) => {
      if (!familyIds.has(f)) familyIds.set(f, familyIds.size);
      return [familyIds.get(f), w];
    });
    const famNorm = Math.hypot(...famEntries.map(e => e[1])) || 1;
    a.families = fam;
    a.fam = famEntries.map(([f, w]) => [f, w / famNorm]);
  });

  const sparseDot = (a, b) => {
    let i = 0, j = 0, s = 0;
    while (i < a.vecIdx.length && j < b.vecIdx.length) {
      if (a.vecIdx[i] === b.vecIdx[j]) s += a.vecW[i++] * b.vecW[j++];
      else if (a.vecIdx[i] < b.vecIdx[j]) i++;
      else j++;
    }
    return s;
  };
  const famDot = (a, b) => {
    let s = 0;
    for (const [f, w] of a.fam) for (const [g, v] of b.fam) if (f === g) s += w * v;
    return s;
  };
  const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const rawSim = (a, b) => {
    let w = 0;
    if (a.vecIdx.length && b.vecIdx.length) w = 0.55 * sparseDot(a, b) + 0.45 * famDot(a, b);
    const shared = collabs.get(pairKey(a.id, b.id)) || 0;
    if (shared) w += Math.min(1, 0.45 * shared);
    // Listening context only speaks for artists genres can't place.
    if (!a.genres.length || !b.genres.length) {
      const t = together.get(pairKey(a.id, b.id)) || 0;
      if (t) w += TOGETHER_MAX * Math.min(1, t / TOGETHER_FULL);
    }
    return w;
  };

  // Candidate pairs only (comparing every pair is quadratic: 10k artists would be 50M
  // comparisons). Rare tags contribute all their artists; common tags ("hip hop") a
  // fixed-size slice that starts at a different place for each artist, so neighbours
  // still come from the same scene while the work stays bounded.
  const postings = new Map();
  artists.forEach((a, i) => a.vecIdx.forEach(t => {
    if (!postings.has(t)) postings.set(t, []);
    postings.get(t).push(i);
  }));
  const collabPartners = new Map();
  [...collabs.keys(), ...together.keys()].forEach(k => {
    const [x, y] = k.split('|');
    [[x, y], [y, x]].forEach(([p, q]) => {
      if (!byId.has(p) || !byId.has(q)) return;
      if (!collabPartners.has(p)) collabPartners.set(p, []);
      collabPartners.get(p).push(byId.get(q).index);
    });
  });

  const neighbors = new Array(n);
  const seen = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const a = artists[i];
    const cand = [];
    const add = (j) => { if (j !== i && seen[j] !== i) { seen[j] = i; cand.push(j); } };
    if (n <= EXACT_LIMIT) {
      for (let j = 0; j < n; j++) add(j);
    }
    const tagsByRarity = Array.from(a.vecIdx).sort((x, y) => df[x] - df[y]);
    for (const t of tagsByRarity) {
      const list = postings.get(t);
      if (list.length <= MAX_CANDIDATE_DF) {
        for (let q = 0; q < list.length && cand.length < MAX_CANDIDATES; q++) add(list[q]);
      } else {
        const start = (i * 2654435761) % list.length;
        for (let q = 0; q < COMMON_TAG_SLICE && cand.length < MAX_CANDIDATES; q++) add(list[(start + q) % list.length]);
      }
    }
    (collabPartners.get(a.id) || []).forEach(add);
    neighbors[i] = cand
      .map(j => ({ j, w: rawSim(a, artists[j]) }))
      .filter(e => e.w > 0)
      // Ties (e.g. artists known only by country) break by a pair hash, not list order;
      // list order chains tied artists into a line in the 3D map.
      .sort((x, y) => y.w - x.w || pairHash(i, x.j) - pairHash(i, y.j))
      .slice(0, MAX_NEIGHBORS);
  }

  // Graph edges (symmetric, thresholded) for Louvain and cluster linkage.
  const edgeW = new Map();
  neighbors.forEach((list, i) => list.forEach(({ j, w }) => {
    if (w >= EDGE_THRESHOLD) edgeW.set(i < j ? i * n + j : j * n + i, w);
  }));
  const edges = [...edgeW].map(([k, w]) => [Math.floor(k / n), k % n, w]);

  // Louvain communities.
  const graph = new Graph({ type: 'undirected' });
  artists.forEach(a => graph.addNode(a.id));
  edges.forEach(([i, j, w]) => graph.addEdge(artists[i].id, artists[j].id, { weight: w }));
  const communityOf = graph.size > 0
    ? louvain(graph, { getEdgeWeight: 'weight', resolution: LOUVAIN_RESOLUTION, rng: mulberry32(42) })
    : {};

  // label[i] = cluster index or -1 (orphan, no edges).
  const label = new Int32Array(n).fill(-1);
  const communityIndex = new Map();
  artists.forEach((a, i) => {
    if (graph.degree(a.id) === 0) return;
    const c = communityOf[a.id];
    if (!communityIndex.has(c)) communityIndex.set(c, communityIndex.size);
    label[i] = communityIndex.get(c);
  });

  // Cluster-to-cluster edge weight sums, recomputed after merges (linear in edges).
  const interSums = () => {
    const sums = new Map();
    for (const [i, j, w] of edges) {
      const a = label[i], b = label[j];
      if (a < 0 || b < 0 || a === b) continue;
      const k1 = `${a}|${b}`, k2 = `${b}|${a}`;
      sums.set(k1, (sums.get(k1) || 0) + w);
      sums.set(k2, (sums.get(k2) || 0) + w);
    }
    return sums;
  };
  const sizesOf = () => {
    const sizes = new Map();
    label.forEach(c => { if (c >= 0) sizes.set(c, (sizes.get(c) || 0) + 1); });
    return sizes;
  };
  const bestTarget = (c, sums, sizes) => {
    let best = -1, bestLink = 0;
    sizes.forEach((sz, d) => {
      if (d === c) return;
      const l = (sums.get(`${c}|${d}`) || 0) / (sizes.get(c) * sz);
      if (l > bestLink) { bestLink = l; best = d; }
    });
    return best;
  };

  // Merge splinters (under ~1% of artists) into their best-linked neighbour, then
  // overflow beyond maxClusters, smallest first.
  const minClusterSize = Math.max(4, Math.round(n * 0.01));
  for (let round = 0; round < 50; round++) {
    const sizes = sizesOf();
    const sums = interSums();
    const small = [...sizes].filter(([, sz]) => sz < minClusterSize).sort((x, y) => x[1] - y[1]);
    if (!small.length) break;
    const relabel = new Map();
    small.forEach(([c]) => relabel.set(c, bestTarget(c, sums, sizes)));
    label.forEach((c, i) => { if (relabel.has(c)) label[i] = relabel.get(c); });
  }
  for (let sizes = sizesOf(); sizes.size > maxClusters; sizes = sizesOf()) {
    const [smallest] = [...sizes].sort((x, y) => x[1] - y[1])[0];
    const target = bestTarget(smallest, interSums(), sizes);
    label.forEach((c, i) => { if (c === smallest) label[i] = target; });
  }

  // Orphans join the cluster they resemble most (any similarity, summed), else Uncharted.
  const uncharted = [];
  const finalLabel = Int32Array.from(label);
  label.forEach((c, i) => {
    if (c >= 0) return;
    const score = new Map();
    neighbors[i].forEach(({ j, w }) => { if (label[j] >= 0) score.set(label[j], (score.get(label[j]) || 0) + w); });
    let best = -1, bestScore = 0.02;
    score.forEach((s, d) => { if (s > bestScore) { bestScore = s; best = d; } });
    if (best >= 0) finalLabel[i] = best;
    else uncharted.push(artists[i].id);
  });

  // Genre-less artists you play alongside genre-placed ones join those artists'
  // cluster: concrete listening beats "same country" as evidence of sound.
  const togetherScore = new Map(); // i → Map(cluster → weight)
  together.forEach((t, k) => {
    const [x, y] = k.split('|').map(id => byId.get(id));
    if (!x || !y) return;
    [[x, y], [y, x]].forEach(([p, q]) => {
      if (p.genres.length || !q.genres.length || finalLabel[q.index] < 0) return;
      if (!togetherScore.has(p.index)) togetherScore.set(p.index, new Map());
      const m = togetherScore.get(p.index);
      m.set(finalLabel[q.index], (m.get(finalLabel[q.index]) || 0) + t);
    });
  });
  togetherScore.forEach((m, i) => {
    const [best, t] = [...m].sort((x, y) => y[1] - x[1])[0];
    if (t >= TOGETHER_REASSIGN) finalLabel[i] = best;
  });
  const stillUncharted = uncharted.filter(id => finalLabel[byId.get(id).index] < 0);
  uncharted.length = 0;
  uncharted.push(...stillUncharted);

  const groups = new Map();
  finalLabel.forEach((c, i) => {
    if (c < 0) return;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(artists[i].id);
  });
  const described = describeClusters([...groups.values()], uncharted, byId, n);

  // Assignment + bridges (mean similarity to each cluster's members, from neighbour lists).
  const clusterOf = new Map();
  const memberCount = new Map();
  described.forEach(c => {
    memberCount.set(c.id, c.members.length);
    c.members.forEach(id => clusterOf.set(id, c.id));
  });
  const assignment = new Map();
  artists.forEach((a, i) => {
    const own = clusterOf.get(a.id);
    const sum = new Map();
    neighbors[i].forEach(({ j, w }) => {
      const c = clusterOf.get(artists[j].id);
      sum.set(c, (sum.get(c) || 0) + w);
    });
    const affinity = (c) => {
      const others = memberCount.get(c) - (c === own ? 1 : 0);
      return others > 0 ? (sum.get(c) || 0) / others : 0;
    };
    const ownAffinity = affinity(own);
    let bridge = null;
    described.forEach(c => {
      if (c.id === own || c.family === UNCLASSIFIED_FAMILY.id) return;
      const aff = affinity(c.id);
      if (aff >= BRIDGE_MIN_AFFINITY && aff >= BRIDGE_RATIO * ownAffinity && (!bridge || aff > bridge.affinity)) {
        bridge = { clusterId: c.id, affinity: aff };
      }
    });
    assignment.set(a.id, {
      clusterId: own,
      bridge: bridge ? { clusterId: bridge.clusterId, weight: Number((bridge.affinity / (ownAffinity + bridge.affinity || 1)).toFixed(2)) } : null
    });
  });

  // Cluster-to-cluster affinity (mean edge weight between members).
  const affinityMatrix = {};
  const pairSum = new Map();
  edges.forEach(([i, j, w]) => {
    const a = clusterOf.get(artists[i].id), b = clusterOf.get(artists[j].id);
    if (a === b) return;
    pairSum.set(`${a}|${b}`, (pairSum.get(`${a}|${b}`) || 0) + w);
    pairSum.set(`${b}|${a}`, (pairSum.get(`${b}|${a}`) || 0) + w);
  });
  described.forEach(A => {
    affinityMatrix[A.id] = {};
    described.forEach(B => {
      if (A.id !== B.id) {
        const l = (pairSum.get(`${A.id}|${B.id}`) || 0) / (A.members.length * B.members.length);
        affinityMatrix[A.id][B.id] = Number(l.toFixed(4));
      }
    });
  });

  // 3D positions where distance means dissimilarity.
  const clusterIndex = new Map(described.map((c, i) => [c.id, i]));
  const embedding = embed3d(n, neighbors, artists.map(a => clusterIndex.get(clusterOf.get(a.id))));
  const positions = new Map();
  if (embedding) artists.forEach((a, i) => positions.set(a.id, embedding[i]));

  return { clusters: described, assignment, affinityMatrix, positions };
}
