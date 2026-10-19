// server/clustering.js
/**
 * Data-driven artist clustering.
 *
 * 1. Similarity graph: artists are linked by tag overlap (TF-IDF cosine over fine genres
 *    and country, so a shared "qawwali" or "India" counts more than a shared "pop")
 *    blended with genre-family overlap, plus a bonus for collaborating on a top track.
 * 2. Louvain community detection on that graph finds the clusters.
 * 3. Splinter clusters (under ~2.5% of placed artists or < 6 artists) merge into their
 *    best-linked neighbour (or dissolve into orphans if isolated); isolated artists join
 *    the cluster they resemble most, or via listening sessions, or "Uncharted" if nothing.
 * 4. clusterNaming.js names each cluster by its most distinctive genres and home, and
 *    artists with strong ties to a second cluster are marked as bridges.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { UMAP } from 'umap-js';
import { familyVector, UNCLASSIFIED_FAMILY } from '../src/config/genreTaxonomy.js';
import { describeClusters } from './clusterNaming.js';

const LOUVAIN_RESOLUTION = 1.3;
const COUNTRY_TAG_WEIGHT = 0.85;
const EDGE_THRESHOLD = 0.12;
const TOGETHER_MAX = 0.65;
const TOGETHER_FULL = 2.5;
const TOGETHER_REASSIGN = 0.4;
const MAX_CANDIDATE_DF = 400;
const MAX_CANDIDATES = 600;
const COMMON_TAG_SLICE = 150;
const MAX_NEIGHBORS = 30;
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
const EMBED_CLUSTER_WEIGHT = 0.45;

const MAX_CLUSTER_GAP_RATIO = 2.0;
const MAX_ISOLATION = 1.25;
const MAX_MEMBER_OUTLIER = 2.1;

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
  let totalSpread = 0;

  groups.forEach((members, c) => {
    const m = [0, 1, 2].map(d => members.reduce((s, i) => s + points[i][d], 0) / members.length);
    centre.set(c, m);
    const dists = members.map(i => Math.hypot(...points[i].map((v, d) => v - m[d]))).sort((a, b) => a - b);
    const med = dists[Math.floor(dists.length * 0.6)] || 0.25;
    const maxMemberDist = med * MAX_MEMBER_OUTLIER;
    members.forEach(i => {
      const off = points[i].map((v, d) => v - m[d]);
      const r = Math.hypot(...off);
      if (r > maxMemberDist && r > 1e-6) {
        const clampedR = maxMemberDist + Math.log1p(r - maxMemberDist) * 0.25;
        points[i] = m.map((mv, d) => mv + off[d] * (clampedR / r));
      }
      totalSpread += Math.min(r, maxMemberDist);
    });
  });

  const spread = (totalSpread / points.length) || 0.3;
  const cs = [...centre.values()];
  let gap = 0, pairs = 0;
  for (let a = 0; a < cs.length; a++) {
    for (let b = a + 1; b < cs.length; b++) {
      gap += Math.hypot(...cs[a].map((v, d) => v - cs[b][d]));
      pairs++;
    }
  }
  gap /= (pairs || 1);
  const ratio = gap / (spread || 1e-6);
  const k = Math.min(1, MAX_CLUSTER_GAP_RATIO / ratio);
  const target = new Map([...centre].map(([c, m]) => [c, m.map(v => v * k)]));

  const centerRadii = [...target.values()].map(m => Math.hypot(...m)).sort((a, b) => a - b);
  const medianCenterR = centerRadii[Math.floor(centerRadii.length * 0.5)] || spread;
  const maxOriginR = Math.max(spread * 1.5, medianCenterR * 1.35);
  target.forEach((m, c) => {
    const r = Math.hypot(...m);
    if (r > maxOriginR && r > 1e-6) {
      target.set(c, m.map(v => v * (maxOriginR / r)));
    }
  });

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
  const limit = (dists[Math.floor(dists.length / 2)] || spread) * MAX_ISOLATION;
  nearest.forEach(([o, dd], c) => {
    if (!o || dd <= limit || dd <= 1e-6) return;
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

  // For large libraries (> 900 artists), embed the top 900 core artists with UMAP
  // (~0.7s) and interpolate the long-tail artists around their cluster peers so
  // 3,000–10,000 artists compute in < 1 second without serverless timeouts.
  const MAX_UMAP_NODES = 900;
  if (n > MAX_UMAP_NODES) {
    const coreCount = MAX_UMAP_NODES;
    const coreNeighbors = neighbors.slice(0, coreCount).map(list =>
      list.filter(e => e.j < coreCount)
    );
    const coreLabels = labels.slice(0, coreCount);
    const corePos = embed3d(coreCount, coreNeighbors, coreLabels);
    if (!corePos) return null;

    const clusterCenters = new Map();
    coreLabels.forEach((c, i) => {
      if (!clusterCenters.has(c)) clusterCenters.set(c, [0, 0, 0, 0]);
      const acc = clusterCenters.get(c);
      acc[0] += corePos[i][0];
      acc[1] += corePos[i][1];
      acc[2] += corePos[i][2];
      acc[3] += 1;
    });

    const rand = mulberry32(99);
    const full = new Array(n);
    for (let i = 0; i < coreCount; i++) full[i] = corePos[i];
    for (let i = coreCount; i < n; i++) {
      const peer = neighbors[i].find(e => e.j < coreCount);
      const c = labels[i];
      const cc = clusterCenters.get(c);
      const base = peer
        ? corePos[peer.j]
        : (cc && cc[3] > 0 ? [cc[0] / cc[3], cc[1] / cc[3], cc[2] / cc[3]] : [0, 0, 0]);
      full[i] = [
        Number((base[0] + (rand() - 0.5) * 0.28).toFixed(4)),
        Number((base[1] + (rand() - 0.5) * 0.28).toFixed(4)),
        Number((base[2] + (rand() - 0.5) * 0.28).toFixed(4))
      ];
    }
    return full;
  }

  const clusterPeers = new Map();
  labels.forEach((c, i) => {
    if (!clusterPeers.has(c)) clusterPeers.set(c, []);
    clusterPeers.get(c).push(i);
  });

  const k = Math.min(EMBED_NEIGHBORS, n - 1);
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
    const peers = clusterPeers.get(labels[i]) || [];
    const peerTarget = Math.min(k - 2, Math.max(4, Math.floor(k * 0.65)));
    for (let p = 0; idx.length < peerTarget && p < peers.length; p++) {
      const peerIdx = peers[(i * 31 + p * 17) % peers.length];
      if (!idx.includes(peerIdx)) {
        idx.push(peerIdx);
        dist.push(0.42);
      }
    }
    for (let s = 1; idx.length < k; s++) {
      const j = (i + s * 7919) % n;
      if (!idx.includes(j)) { idx.push(j); dist.push(1); }
    }
    knnIndices.push(idx);
    knnDistances.push(dist);
  }

  const umap = new UMAP({ nComponents: 3, nNeighbors: k, minDist: 0.35, spread: 1.0, nEpochs: n > 600 ? 180 : 250, random: mulberry32(7) });
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
  const maxClusters = Math.max(8, Math.min(14, Math.round(Math.sqrt(artists.length) * 0.7)));

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

  const musicalSim = (a, b) => {
    let w = 0;
    if (a.vecIdx.length && b.vecIdx.length) w = 0.55 * sparseDot(a, b) + 0.45 * famDot(a, b);
    const shared = collabs.get(pairKey(a.id, b.id)) || 0;
    if (shared) w += Math.min(1, 0.45 * shared);
    return w;
  };

  const rawSim = (a, b) => {
    let w = musicalSim(a, b);
    if (!a.genres.length || !b.genres.length) {
      const t = together.get(pairKey(a.id, b.id)) || 0;
      if (t) w += TOGETHER_MAX * Math.min(1, t / TOGETHER_FULL);
    }
    return w;
  };

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
  const musicalNeighbors = new Array(n);
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

    musicalNeighbors[i] = cand
      .map(j => ({ j, w: musicalSim(a, artists[j]) }))
      .filter(e => e.w > 0)
      .sort((x, y) => y.w - x.w || pairHash(i, x.j) - pairHash(i, y.j))
      .slice(0, MAX_NEIGHBORS);

    neighbors[i] = cand
      .map(j => ({ j, w: rawSim(a, artists[j]) }))
      .filter(e => e.w > 0)
      .sort((x, y) => y.w - x.w || pairHash(i, x.j) - pairHash(i, y.j))
      .slice(0, MAX_NEIGHBORS);
  }

  const edgeW = new Map();
  musicalNeighbors.forEach((list, i) => list.forEach(({ j, w }) => {
    if (w >= EDGE_THRESHOLD) edgeW.set(i < j ? i * n + j : j * n + i, w);
  }));
  const edges = [...edgeW].map(([k, w]) => [Math.floor(k / n), k % n, w]);

  const graph = new Graph({ type: 'undirected' });
  artists.forEach(a => graph.addNode(a.id));
  edges.forEach(([i, j, w]) => graph.addEdge(artists[i].id, artists[j].id, { weight: w }));
  const communityOf = graph.size > 0
    ? louvain(graph, { getEdgeWeight: 'weight', resolution: LOUVAIN_RESOLUTION, rng: mulberry32(42) })
    : {};

  const label = new Int32Array(n).fill(-1);
  const communityIndex = new Map();
  artists.forEach((a, i) => {
    if (graph.degree(a.id) === 0) return;
    const c = communityOf[a.id];
    if (!communityIndex.has(c)) communityIndex.set(c, communityIndex.size);
    label[i] = communityIndex.get(c);
  });

  const interSums = (lbl = label) => {
    const sums = new Map();
    for (const [i, j, w] of edges) {
      const a = lbl[i], b = lbl[j];
      if (a < 0 || b < 0 || a === b) continue;
      const k1 = `${a}|${b}`, k2 = `${b}|${a}`;
      sums.set(k1, (sums.get(k1) || 0) + w);
      sums.set(k2, (sums.get(k2) || 0) + w);
    }
    return sums;
  };
  const sizesOf = (lbl = label) => {
    const sizes = new Map();
    lbl.forEach(c => { if (c >= 0) sizes.set(c, (sizes.get(c) || 0) + 1); });
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

  // Dissolve or merge splinter clusters (< minClusterSize). Setting isolated splinters
  // to -1 turns them into orphans so co-listening (`togetherScore`) places them into
  // major clusters instead of leaving 2-artist or 3-artist micro-clusters!
  const placedCount = label.filter(c => c >= 0).length;
  const minClusterSize = Math.max(6, Math.round(placedCount * 0.025));
  for (let round = 0; round < 50; round++) {
    const sizes = sizesOf();
    if (sizes.size <= 1) break;
    const sums = interSums();
    const small = [...sizes].filter(([, sz]) => sz < minClusterSize).sort((x, y) => x[1] - y[1]);
    if (!small.length) break;
    const relabel = new Map();
    small.forEach(([c]) => {
      relabel.set(c, bestTarget(c, sums, sizes));
    });
    label.forEach((c, i) => { if (relabel.has(c)) label[i] = relabel.get(c); });
  }
  for (let sizes = sizesOf(); sizes.size > maxClusters; sizes = sizesOf()) {
    const [smallest] = [...sizes].sort((x, y) => x[1] - y[1])[0];
    const target = bestTarget(smallest, interSums(), sizes);
    label.forEach((c, i) => { if (c === smallest) label[i] = target; });
  }

  // Orphans join the cluster they resemble most (musical similarity), else wait for co-listening.
  // 1. Direct TF-IDF Musical Neighbors (pass 1)
  const uncharted = [];
  const finalLabel = Int32Array.from(label);
  label.forEach((c, i) => {
    if (c >= 0) return;
    const score = new Map();
    musicalNeighbors[i].forEach(({ j, w }) => { if (label[j] >= 0) score.set(label[j], (score.get(label[j]) || 0) + w); });
    let best = -1, bestScore = 0.015;
    score.forEach((s, d) => { if (s > bestScore) { bestScore = s; best = d; } });
    if (best >= 0) finalLabel[i] = best;
  });

  // 2. Track Collaborations: artists who shared a track with a placed artist join that artist's cluster
  collabs.forEach((w, k) => {
    const [x, y] = k.split('|').map(id => byId.get(id));
    if (!x || !y) return;
    [[x, y], [y, x]].forEach(([p, q]) => {
      if (finalLabel[p.index] < 0 && finalLabel[q.index] >= 0) {
        finalLabel[p.index] = finalLabel[q.index];
      }
    });
  });

  // 3. Cluster Genre Family Centroids:
  // Compute normalized genre-family distribution for each formed cluster.
  const clusterFamProfiles = new Map();
  finalLabel.forEach((c, i) => {
    if (c < 0) return;
    if (!clusterFamProfiles.has(c)) clusterFamProfiles.set(c, new Map());
    const prof = clusterFamProfiles.get(c);
    const fams = artists[i].families || {};
    Object.entries(fams).forEach(([f, weight]) => {
      prof.set(f, (prof.get(f) || 0) + weight);
    });
  });

  const clusterFamVecs = new Map();
  clusterFamProfiles.forEach((prof, c) => {
    let normSq = 0;
    prof.forEach(val => { normSq += val * val; });
    const norm = Math.sqrt(normSq) || 1;
    const normMap = new Map();
    prof.forEach((val, f) => normMap.set(f, val / norm));
    clusterFamVecs.set(c, normMap);
  });

  // Match orphan artists with genres or country tags to the best fitting cluster
  finalLabel.forEach((c, i) => {
    if (c >= 0) return;
    const a = artists[i];
    const fams = a.families || {};
    if (Object.keys(fams).length === 0) return;
    let aNormSq = 0;
    Object.values(fams).forEach(v => { aNormSq += v * v; });
    const aNorm = Math.sqrt(aNormSq) || 1;

    let bestCluster = -1;
    let bestSim = 0.12;

    clusterFamVecs.forEach((vec, clId) => {
      let dot = 0;
      Object.entries(fams).forEach(([f, v]) => {
        if (vec.has(f)) dot += (v / aNorm) * vec.get(f);
      });
      if (dot > bestSim) {
        bestSim = dot;
        bestCluster = clId;
      }
    });

    if (bestCluster >= 0) {
      finalLabel[i] = bestCluster;
    }
  });

  // 4. Co-listening sessions: artists played alongside placed ones join their cluster (multi-hop propagation)
  for (let pass = 0; pass < 8; pass++) {
    const togetherScore = new Map();
    together.forEach((t, k) => {
      const [x, y] = k.split('|').map(id => byId.get(id));
      if (!x || !y) return;
      [[x, y], [y, x]].forEach(([p, q]) => {
        if (finalLabel[p.index] >= 0 || finalLabel[q.index] < 0) return;
        if (!togetherScore.has(p.index)) togetherScore.set(p.index, new Map());
        const m = togetherScore.get(p.index);
        m.set(finalLabel[q.index], (m.get(finalLabel[q.index]) || 0) + t);
      });
    });
    const minWeight = pass === 0 ? 0.15 : (pass === 1 ? 0.05 : 0.005);
    let newlyPlaced = 0;
    togetherScore.forEach((m, i) => {
      if (finalLabel[i] >= 0) return;
      const sorted = [...m].sort((x, y) => y[1] - x[1]);
      if (sorted.length && sorted[0][1] >= minWeight) {
        finalLabel[i] = sorted[0][0];
        newlyPlaced++;
      }
    });
    if (newlyPlaced === 0) break;
  }

  // 5. Audio Feature Centroid Proximity:
  // For any remaining orphan with features (energy, valence, dance, acoustic),
  // place them into the cluster with the closest acoustic/energy profile
  const clusterAudioCentroids = new Map();
  finalLabel.forEach((c, i) => {
    if (c < 0) return;
    if (!clusterAudioCentroids.has(c)) clusterAudioCentroids.set(c, { energy: 0, valence: 0, dance: 0, acoustic: 0, count: 0 });
    const cent = clusterAudioCentroids.get(c);
    const a = artists[i];
    cent.energy += a.energy || 0.5;
    cent.valence += a.valence || 0.5;
    cent.dance += a.dance || 0.5;
    cent.acoustic += a.acoustic || 0.2;
    cent.count++;
  });

  clusterAudioCentroids.forEach(cent => {
    if (cent.count > 0) {
      cent.energy /= cent.count;
      cent.valence /= cent.count;
      cent.dance /= cent.count;
      cent.acoustic /= cent.count;
    }
  });

  if (clusterAudioCentroids.size > 0) {
    finalLabel.forEach((c, i) => {
      if (c >= 0) return;
      const a = artists[i];
      let bestCl = -1;
      let minD = Infinity;
      clusterAudioCentroids.forEach((cent, clId) => {
        const dE = (a.energy || 0.5) - cent.energy;
        const dV = (a.valence || 0.5) - cent.valence;
        const dD = (a.dance || 0.5) - cent.dance;
        const dA = (a.acoustic || 0.2) - cent.acoustic;
        const dist = Math.hypot(dE, dV, dD, dA);
        if (dist < minD) {
          minD = dist;
          bestCl = clId;
        }
      });
      if (bestCl >= 0) {
        finalLabel[i] = bestCl;
      }
    });
  }

  // 6. Any artist truly remaining without a cluster stays in uncharted
  finalLabel.forEach((c, i) => {
    if (c < 0) uncharted.push(artists[i].id);
  });

  const groups = new Map();
  finalLabel.forEach((c, i) => {
    if (c < 0) return;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(artists[i].id);
  });
  const described = describeClusters([...groups.values()], uncharted, byId, n);

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
    musicalNeighbors[i].forEach(({ j, w }) => {
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

  const clusterIndex = new Map(described.map((c, i) => [c.id, i]));
  const embedding = embed3d(n, neighbors, artists.map(a => clusterIndex.get(clusterOf.get(a.id))));
  const positions = new Map();
  if (embedding) artists.forEach((a, i) => positions.set(a.id, embedding[i]));

  return { clusters: described, assignment, affinityMatrix, positions };
}
