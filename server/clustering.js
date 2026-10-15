// server/clustering.js
/**
 * Data-driven artist clustering.
 *
 * 1. Similarity graph: artists are linked by tag overlap (TF-IDF cosine over fine genres
 *    and country, so a shared "qawwali" or "India" counts more than a shared "pop")
 *    blended with genre-family overlap, plus a bonus for collaborating on a top track.
 * 2. Louvain community detection on that graph finds the clusters.
 * 3. Tiny clusters are merged into their best-linked neighbour, isolated artists go to
 *    "Eclectic" (has genres) or "Uncharted" (no genre data at all).
 * 4. Each cluster is named after its dominant fine genre or family, and artists with
 *    strong ties to a second cluster are marked as bridges.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { familyVector, familyInfo, familiesForGenre, OTHER_FAMILY, UNCLASSIFIED_FAMILY } from '../src/config/genreTaxonomy.js';

const MAX_CLUSTERS = 9;
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

const COUNTRY_SHORT = { 'United States': 'US', 'United States of America': 'US', 'United Kingdom': 'UK' };
const shortCountry = (c) => COUNTRY_SHORT[c] || c;

const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bR&b\b/, 'R&B');

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Shifts the hue so that two clusters of the same family stay distinguishable. */
function variantColor(hex, variantIndex) {
  if (variantIndex === 0) return hex;
  const [h, s, l] = hexToHsl(hex);
  const step = Math.ceil(variantIndex / 2) * 22 * (variantIndex % 2 ? 1 : -1);
  return hslToHex((h + step + 360) % 360, s, Math.min(0.72, l + 0.04));
}

/**
 * @param {Array<{id, name, genres: string[], countries: string[], score: number}>} artists  genres normalized
 * @param {Map<string, number>} collabs  key "idA|idB" (sorted) → number of shared top tracks
 */
export function clusterArtists(artists, collabs) {
  const byId = new Map(artists.map(a => [a.id, a]));

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
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = artists[i], b = artists[j];
      let w = 0;
      if (a.tags.length && b.tags.length) {
        w = 0.55 * cosine(a.tfidf, b.tfidf) + 0.45 * famCosine(a.fam, b.fam);
      }
      const shared = collabs.get(key(a.id, b.id)) || 0;
      if (shared) w += Math.min(1, 0.45 * shared);
      if (w >= EDGE_THRESHOLD) weight.set(key(a.id, b.id), w);
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
  const uncharted = [];
  const eclectic = [];
  artists.forEach(a => {
    if (graph.degree(a.id) === 0) {
      (a.tags.length ? eclectic : uncharted).push(a.id);
      return;
    }
    const c = communityOf[a.id];
    if (!clusters.has(c)) clusters.set(c, []);
    clusters.get(c).push(a.id);
  });
  clusters = [...clusters.values()];

  // Merge tiny / overflow clusters into their best-linked neighbour.
  const linkage = (A, B) => {
    let sum = 0;
    A.forEach(x => B.forEach(y => { sum += linkW(x, y); }));
    return sum / (A.length * B.length);
  };
  let merged = true;
  while (merged && clusters.length > 1) {
    merged = false;
    clusters.sort((A, B) => A.length - B.length);
    for (let i = 0; i < clusters.length; i++) {
      const C = clusters[i];
      let best = -1, bestLink = 0;
      clusters.forEach((D, j) => {
        if (j === i) return;
        const l = linkage(C, D);
        if (l > bestLink) { bestLink = l; best = j; }
      });
      const overflow = clusters.length > MAX_CLUSTERS && i === 0;
      const tooSmall = (C.length === 1 && bestLink > 0.05) || (C.length === 2 && bestLink > 0.2);
      if (best >= 0 && (overflow || tooSmall)) {
        clusters[best].push(...C);
        clusters.splice(i, 1);
        merged = true;
        break;
      }
      if (overflow) {
        // Nothing links to it at all.
        eclectic.push(...C);
        clusters.splice(i, 1);
        merged = true;
        break;
      }
    }
  }
  // Singletons that never found a home read better grouped together.
  clusters = clusters.filter(C => {
    if (C.length > 1) return true;
    eclectic.push(...C);
    return false;
  });

  // Describe each cluster. A country only names a cluster when it is distinctive there.
  const globalCountry = new Map();
  artists.forEach(a => new Set(a.countries).forEach(c => globalCountry.set(c, (globalCountry.get(c) || 0) + 1)));
  const scoreOf = (id) => byId.get(id).score || 1;
  const familyUse = new Map();
  const usedNames = new Set();
  const described = [];

  const describe = (members, forcedFamily) => {
    const famScore = {};
    const genreScore = new Map();
    const genreCount = new Map();
    const countryCount = new Map();
    members.forEach(id => {
      const a = byId.get(id);
      Object.entries(a.fam).forEach(([f, w]) => { famScore[f] = (famScore[f] || 0) + w * scoreOf(id); });
      new Set(a.countries).forEach(c => countryCount.set(c, (countryCount.get(c) || 0) + 1));
      new Set(a.genres).forEach(g => {
        genreScore.set(g, (genreScore.get(g) || 0) + scoreOf(id));
        genreCount.set(g, (genreCount.get(g) || 0) + 1);
      });
    });
    const family = forcedFamily || familyInfo(Object.entries(famScore).sort((x, y) => y[1] - x[1])[0]?.[0] || OTHER_FAMILY.id);
    const topGenres = [...genreScore.entries()].sort((x, y) => y[1] - x[1]).map(([g]) => g);
    const lead = topGenres[0];
    const [topCountry, topCountryCount] = [...countryCount.entries()].sort((x, y) => y[1] - x[1])[0] || [];
    const share = topCountry ? topCountryCount / members.length : 0;
    const globalShare = topCountry ? globalCountry.get(topCountry) / n : 1;
    const scene = share >= 0.6 && share >= 1.5 * globalShare ? shortCountry(topCountry) : null;

    const candidates = [];
    // A genre names the cluster only if it belongs to the cluster's family (no gold "Pop" cluster of qawwali).
    if (!forcedFamily && lead && genreCount.get(lead) / members.length >= 0.5 && familiesForGenre(lead).includes(family.id)) {
      candidates.push(titleCase(lead));
    }
    if (!forcedFamily && scene) candidates.push(`${family.label} · ${scene}`);
    candidates.push(family.label);
    if (lead) candidates.push(`${family.label} · ${titleCase(lead)}`);
    let name = candidates.find(c => !usedNames.has(c.toUpperCase())) || `${family.label} ${described.length + 1}`;
    usedNames.add(name.toUpperCase());

    const variant = familyUse.get(family.id) || 0;
    familyUse.set(family.id, variant + 1);

    const cluster = {
      id: `cluster_${described.length}_${family.id}`,
      name,
      family: family.id,
      familyLabel: family.label,
      color: variantColor(family.color, variant),
      subgenres: topGenres.slice(0, 6).map(titleCase),
      members
    };
    described.push(cluster);
    return cluster;
  };

  clusters
    .sort((A, B) => B.reduce((s, id) => s + scoreOf(id), 0) - A.reduce((s, id) => s + scoreOf(id), 0))
    .forEach(members => describe(members));
  if (eclectic.length) describe(eclectic, OTHER_FAMILY);
  if (uncharted.length) describe(uncharted, UNCLASSIFIED_FAMILY);

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

  return { clusters: described, assignment, affinityMatrix };
}
