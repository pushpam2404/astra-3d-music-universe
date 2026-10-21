// server/clustering.js
/**
 * Data-driven artist clustering.
 *
 * 1. Similarity graph: artists are linked by tag overlap (TF-IDF cosine over fine genres
 *    and country, so a shared "qawwali" or "India" counts more than a shared "pop")
 *    expanded with learned tag relatedness (PPMI), plus a bonus for collaborating on a top track.
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
import { UNCLASSIFIED_FAMILY } from '../src/config/genreTaxonomy.js';
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
// Share of a group's listening that must come from artists with real genre data.
const MIN_GENRE_SHARE = 0.25;
// Context check (doubtGenresAgainstContext): at least this many co-listened partners with
// genres and this much link weight; the partners' mean similarity to each other is at
// least CONTEXT_AGREEMENT; and the artist's best similarity to any of them is below
// CONTEXT_MAX_OVERLAP.
const CONTEXT_MIN_PARTNERS = 3;
const CONTEXT_MIN_WEIGHT = 4;
const CONTEXT_AGREEMENT = 0.3;
const CONTEXT_MAX_OVERLAP = 0.08;
// Learned tag relatedness: how many related tags each tag spreads to, and how strongly.
const RELATED_TAGS = 8;
const RELATED_WEIGHT = 0.25;
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
/**
 * Last.fm merges artists who share a name into one page, so a small artist can inherit
 * a famous namesake's tags (Indian rapper King tagged "metal"). Catch that from the
 * listening itself: if the artists you play with it (sessions, collaborations) sound
 * alike and its tags resemble none of them, its tags describe someone else. Those
 * genres are dropped, so it's placed by what you play it with instead.
 * @returns {Set<string>} ids whose genres were dropped
 */
function doubtGenresAgainstContext(artists, byId, collabs, together, cosine) {
  const partners = new Map(); // id → Map(partnerId → weight)
  const link = (key, w) => {
    const [x, y] = key.split('|');
    if (!byId.has(x) || !byId.has(y)) return;
    [[x, y], [y, x]].forEach(([p, q]) => {
      if (!partners.has(p)) partners.set(p, new Map());
      partners.get(p).set(q, (partners.get(p).get(q) || 0) + w);
    });
  };
  together.forEach((w, k) => link(k, w));
  collabs.forEach((w, k) => link(k, 2 * w));

  const doubted = new Set();
  artists.forEach(a => {
    // Only tags that rest on Last.fm's shared artist page alone are open to doubt;
    // confirmed tags stand even when you play the artist among very different music.
    if (!a.genres?.length || !a.unverifiedTags || !a.vecIdx.length) return;
    const ctx = [...(partners.get(a.id) || new Map())]
      .map(([q, w]) => [byId.get(q), w])
      .filter(([p]) => p.genres?.length && p.vecIdx.length);
    const total = ctx.reduce((sum, [, w]) => sum + w, 0);
    if (ctx.length < CONTEXT_MIN_PARTNERS || total < CONTEXT_MIN_WEIGHT) return;
    // Do the partners agree with each other, and does this artist fit none of them?
    let agree = 0, pairs = 0, fit = 0;
    for (let i = 0; i < ctx.length; i++) {
      fit = Math.max(fit, cosine(a, ctx[i][0]));
      for (let j = i + 1; j < ctx.length; j++) { agree += cosine(ctx[i][0], ctx[j][0]); pairs++; }
    }
    if (pairs && agree / pairs >= CONTEXT_AGREEMENT && fit < CONTEXT_MAX_OVERLAP) doubted.add(a.id);
  });
  return doubted;
}

/**
 * Artist vectors: TF-IDF over genre tags and "@country", then expanded with learned
 * tag relatedness, so "indie rock" and "alternative rock" count as close without any
 * hand-made genre families. Relatedness is positive pointwise mutual information
 * (PPMI) of tags appearing on the same artists in this library, the classic
 * distributional-semantics measure.
 */
function buildTagVectors(artists) {
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
  // Co-occurrence of genre tags (countries excluded: they'd relate everything Indian).
  const co = new Map();
  artists.forEach(a => {
    const ids = a.genres.map(t => tagId.get(t));
    for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const k = ids[i] * 1e6 + ids[j];
      co.set(k, (co.get(k) || 0) + 1);
    }
  });
  const related = new Map(); // tag → [[tag, weight]] (row-normalised, top RELATED_TAGS)
  co.forEach((c, k) => {
    if (c < 2) return;
    const i = Math.floor(k / 1e6), j = k % 1e6;
    const pmi = Math.log((c * n) / (df[i] * df[j]));
    if (pmi <= 0) return;
    if (!related.has(i)) related.set(i, []);
    related.get(i).push([j, pmi]);
  });
  related.forEach((list, i) => {
    list.sort((x, y) => y[1] - x[1]);
    const top = list.slice(0, RELATED_TAGS);
    const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
    related.set(i, top.map(([j, w]) => [j, w / sum]));
  });
  artists.forEach((a, i) => {
    a.index = i;
    const v = new Map();
    a.tags.forEach(t => {
      const id = tagId.get(t);
      v.set(id, (v.get(id) || 0) + Math.log(1 + n / df[id]) * (t.startsWith('@') ? COUNTRY_TAG_WEIGHT : 1));
    });
    const base = [...v];
    base.forEach(([id, w]) => (related.get(id) || []).forEach(([j, r]) => v.set(j, (v.get(j) || 0) + RELATED_WEIGHT * w * r)));
    const entries = [...v].sort((x, y) => x[0] - y[0]);
    const norm = Math.hypot(...entries.map(e => e[1])) || 1;
    a.vecIdx = Int32Array.from(entries, e => e[0]);
    a.vecW = Float32Array.from(entries, e => e[1] / norm);
  });
}

function sparseCosine(a, b) {
  let i = 0, j = 0, s = 0;
  while (i < a.vecIdx.length && j < b.vecIdx.length) {
    if (a.vecIdx[i] === b.vecIdx[j]) s += a.vecW[i++] * b.vecW[j++];
    else if (a.vecIdx[i] < b.vecIdx[j]) i++;
    else j++;
  }
  return s;
}

export function clusterArtists(artists, collabs, together = new Map(), { nameable = null } = {}) {
  const byId = new Map(artists.map(a => [a.id, a]));
  // Dynamic cluster ceiling scaled to artist count:
  // ~100 artists -> 8, ~500 -> 12, ~1,500 -> 16, ~3,300+ -> 20, hard cap at 22
  const maxClusters = Math.max(8, Math.min(22, Math.round(8 + Math.sqrt(Math.max(0, artists.length - 100)) * 0.21)));

  const n = artists.length;
  buildTagVectors(artists);
  const doubtedGenres = doubtGenresAgainstContext(artists, byId, collabs, together, sparseCosine);
  if (doubtedGenres.size) {
    doubtedGenres.forEach(id => { byId.get(id).genres = []; });
    buildTagVectors(artists);
  }
  const sparseDot = sparseCosine;
  const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

  const musicalSim = (a, b) => {
    let w = 0;
    if (a.vecIdx.length && b.vecIdx.length) w = sparseDot(a, b);
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
    const tagsByRarity = Array.from(a.vecIdx).sort((x, y) => postings.get(x).length - postings.get(y).length);
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
  // Dynamic Louvain resolution: scales from 1.3 for small libraries up to 2.25 for large libraries
  // so mega-genres (1,000+ artists) naturally resolve into authentic sub-communities (Synthpop, R&B, Filmi, Desi Hip Hop, Punjabi)
  // rather than collapsing into 2 giant monolithic blobs.
  const resolution = Math.max(1.3, Math.min(2.25, 1.3 + Math.log10(Math.max(1, artists.length / 300)) * 0.90));
  const communityOf = graph.size > 0
    ? louvain(graph, { getEdgeWeight: 'weight', resolution, rng: mulberry32(42) })
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
  // Scales smoothly: small libraries require at least 6 artists; large libraries scale up
  // to 20 artists so genuine sub-scenes (25-50 artists) are protected rather than merged.
  const placedCount = label.filter(c => c >= 0).length;
  const minClusterSize = Math.max(6, Math.min(20, Math.round(placedCount * 0.009)));
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

  // 3. Orphans with tags join the cluster whose tag centroid they're closest to.
  const centroids = new Map();
  finalLabel.forEach((c, i) => {
    if (c < 0) return;
    if (!centroids.has(c)) centroids.set(c, new Map());
    const m = centroids.get(c);
    const a = artists[i];
    for (let k = 0; k < a.vecIdx.length; k++) m.set(a.vecIdx[k], (m.get(a.vecIdx[k]) || 0) + a.vecW[k]);
  });
  centroids.forEach(m => {
    const norm = Math.hypot(...m.values()) || 1;
    m.forEach((w, k) => m.set(k, w / norm));
  });
  finalLabel.forEach((c, i) => {
    if (c >= 0) return;
    const a = artists[i];
    if (!a.vecIdx.length) return;
    let bestCluster = -1, bestSim = 0.12;
    centroids.forEach((m, clId) => {
      let dot = 0;
      for (let k = 0; k < a.vecIdx.length; k++) dot += a.vecW[k] * (m.get(a.vecIdx[k]) || 0);
      if (dot > bestSim) { bestSim = dot; bestCluster = clId; }
    });
    if (bestCluster >= 0) finalLabel[i] = bestCluster;
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
  // Groups are genre groups: one needs real genre data among its members to exist.
  // Members of a group without it join the genre group they're most similar to
  // (sessions, collaborations, shared tags), or wait under Genre Unknown.
  const genreKnown = (id) => byId.get(id).genres?.length > 0;
  // Share is weighted by listening: genres are looked up most-played first, so early
  // on a group's big artists have genres while its long tail is still pending.
  const isGenreGroup = (ids) => {
    const known = ids.filter(genreKnown);
    const weight = (list) => list.reduce((sum, id) => sum + (byId.get(id).score || 1), 0);
    return known.length >= Math.min(2, ids.length) && weight(known) >= weight(ids) * MIN_GENRE_SHARE;
  };
  const groupOf = new Map();
  groups.forEach((ids, c) => { if (isGenreGroup(ids)) ids.forEach(id => groupOf.set(id, c)); });
  for (let pass = 0; pass < 3; pass++) {
    groups.forEach((ids, c) => ids.forEach(id => {
      if (groupOf.has(id)) return;
      const score = new Map();
      neighbors[byId.get(id).index].forEach(({ j, w }) => {
        const g = groupOf.get(artists[j].id);
        if (g !== undefined) score.set(g, (score.get(g) || 0) + w);
      });
      const best = [...score].sort((x, y) => y[1] - x[1])[0];
      if (best && best[1] >= 0.05) groupOf.set(id, best[0]);
    }));
  }
  const genreGroups = new Map();
  groups.forEach(ids => ids.forEach(id => {
    const g = groupOf.get(id);
    if (g === undefined) { uncharted.push(id); return; }
    if (!genreGroups.has(g)) genreGroups.set(g, []);
    genreGroups.get(g).push(id);
  }));

  // Two groups that can only be told apart by an invented name are one genre group.
  let groupList = [...genreGroups.values()];
  let described = describeClusters(groupList, uncharted, byId, n, nameable);
  for (let round = 0; round < 20 && described.some(c => c.duplicateOf); round++) {
    const byClusterId = new Map(described.map(c => [c.id, c]));
    const dup = described.find(c => c.duplicateOf);
    const target = byClusterId.get(dup.duplicateOf) || described.find(c => c !== dup && c.family !== UNCLASSIFIED_FAMILY.id);
    if (!target) break;
    target.members.push(...dup.members);
    groupList = described.filter(c => c !== dup && c.family !== UNCLASSIFIED_FAMILY.id).map(c => c.members);
    described = describeClusters(groupList, uncharted, byId, n, nameable);
  }

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

  return { clusters: described, assignment, affinityMatrix, positions, doubtedGenres };
}
