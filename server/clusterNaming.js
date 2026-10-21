// server/clusterNaming.js
/**
 * Names each cluster after the genres that distinguish it, using class-based TF-IDF
 * (c-TF-IDF) as in BERTopic: a cluster is treated as one document made of its members'
 * genre tags, and a tag scores
 *
 *     W(t, c) = tf(t, c) · log(1 + A / f(t))
 *
 * where tf is the tag's share of the cluster's tags, f(t) the tag's frequency across all
 * clusters, and A the average number of tags per cluster. Common-everywhere tags ("pop")
 * lose to concentrated ones ("filmi").
 *
 * Only nameable tags can name a cluster (curated catalogue genres and language names, see
 * src/etl/genreSignals.js), and only with consensus: the tag must be on at least
 * MIN_SUPPORT of the cluster's genre-known artists. No moods, invented themes or artist
 * names. When no unused name is left, the cluster is reported as `duplicateOf` the
 * cluster holding its best name, and clustering merges the two.
 */
import { UNCLASSIFIED_FAMILY, getDistinctClusterColor, CLUSTER_COLORS } from '../src/config/genreTaxonomy.js';

export { CLUSTER_COLORS };

// Longer names crowd the 3D labels; shorter candidates win when available.
const MAX_NAME_LENGTH = 28;
const UNCHARTED_COLOR = '#6E768C';
// A naming tag must carry at least this share of the cluster's (genre-known) listening.
const MIN_SUPPORT = 0.15;
// The second genre joins the name when its score is at least this share of the first's.
const SECOND_GENRE_RATIO = 0.55;

// Letter-case conventions only (how genre names are written), not genre knowledge.
const CASE_FIXES = [[/\bR&b\b/g, 'R&B'], [/\bEdm\b/g, 'EDM'], [/\bUk\b/g, 'UK'], [/\bUs\b/g, 'US'], [/\bLo-fi\b/gi, 'Lo-Fi'], [/\bK-pop\b/gi, 'K-Pop'], [/\bJ-pop\b/gi, 'J-Pop'], [/\bJ-rock\b/gi, 'J-Rock'], [/\bDnb\b/g, 'DnB'], [/\bIdm\b/g, 'IDM']];
export const titleCase = (s) => CASE_FIXES.reduce((t, [re, rep]) => t.replace(re, rep), String(s).replace(/(^|[\s(/-])([a-z])/g, (m, p, c) => p + c.toUpperCase()));

/** "Psychedelic Rock" + "Indie Rock" → "Psychedelic & Indie Rock"; otherwise "A & B". */
function joinGenres(a, b) {
  const wa = a.split(' '), wb = b.split(' ');
  if (wa.length > 1 && wb.length > 1 && wa[wa.length - 1] === wb[wb.length - 1]) {
    return `${wa.slice(0, -1).join(' ')} & ${b}`;
  }
  return `${a} & ${b}`;
}

const overlaps = (a, b) => a.includes(b) || b.includes(a);

/**
 * @param {string[][]} clusters  member id lists
 * @param {string[]} uncharted   ids with no usable signal
 * @param {Map} byId             id → { name, genres, countries, score }
 * @param {number} n             total artist count
 * @param {Set<string> | null} nameable  tags allowed in names (null: any genre tag)
 */
export function describeClusters(clusters, uncharted, byId, n, nameable = null) {
  const scoreOf = (id) => byId.get(id).score || 1;
  const canName = (g) => !nameable || nameable.has(g);

  const sorted = clusters
    .slice()
    .sort((A, B) => B.reduce((s, id) => s + scoreOf(id), 0) - A.reduce((s, id) => s + scoreOf(id), 0));

  // Term frequencies per cluster, weighted by listening (√score, so one favourite
  // can't outweigh a whole scene), and corpus-wide tag frequencies.
  const weightOf = (id) => Math.sqrt(scoreOf(id));
  const counts = sorted.map(members => {
    const m = new Map();
    members.forEach(id => new Set(byId.get(id).genres || []).forEach(g => m.set(g, (m.get(g) || 0) + weightOf(id))));
    return m;
  });
  const freq = new Map();
  counts.forEach(m => m.forEach((c, g) => freq.set(g, (freq.get(g) || 0) + c)));
  const totals = counts.map(m => [...m.values()].reduce((s, c) => s + c, 0));
  const avgTags = totals.reduce((s, t) => s + t, 0) / Math.max(1, totals.length);

  const usedNames = new Map(); // lower-case name → cluster id
  const described = [];

  sorted.forEach((members, idx) => {
    const known = members.filter(id => byId.get(id).genres?.length);
    const knownWeight = known.reduce((s, id) => s + weightOf(id), 0) || 1;
    const artistCount = new Map();
    known.forEach(id => new Set(byId.get(id).genres).forEach(g => artistCount.set(g, (artistCount.get(g) || 0) + 1)));
    // Consensus: on at least 2 artists and MIN_SUPPORT of the cluster's listening.
    const ranked = [...counts[idx]]
      .filter(([g, w]) => (artistCount.get(g) || 0) >= Math.min(2, members.length) && w / knownWeight >= MIN_SUPPORT && canName(g))
      .map(([g, w]) => ({ g, score: (w / (totals[idx] || 1)) * Math.log(1 + avgTags / freq.get(g)) }))
      .sort((x, y) => y.score - x.score || x.g.localeCompare(y.g));

    const candidates = [];
    const top = ranked.slice(0, 6);
    for (let i = 0; i < top.length; i++) {
      const g1 = titleCase(top[i].g);
      const partner = top.slice(i + 1).find(r => !overlaps(r.g, top[i].g) && r.score >= top[i].score * SECOND_GENRE_RATIO);
      if (partner) candidates.push(joinGenres(g1, titleCase(partner.g)));
      candidates.push(g1);
    }
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        if (!overlaps(ranked[i].g, ranked[j].g)) candidates.push(joinGenres(titleCase(ranked[i].g), titleCase(ranked[j].g)));
      }
    }

    const id = `cluster_${described.length}_genre`;
    const free = candidates.find(c => c.length <= MAX_NAME_LENGTH && !usedNames.has(c.toLowerCase()))
      || candidates.find(c => !usedNames.has(c.toLowerCase()));
    // No genre name of its own: by genre it is the same group as the one holding its best name.
    const duplicateOf = free ? null : (usedNames.get(candidates[0]?.toLowerCase()) ?? described[0]?.id ?? null);
    const name = free || candidates[0] || null;
    if (free) usedNames.set(free.toLowerCase(), id);

    described.push({
      id,
      name,
      duplicateOf,
      family: 'genre',
      familyLabel: ranked.slice(0, 2).map(r => titleCase(r.g)).join(' · '),
      color: getDistinctClusterColor(idx),
      subgenres: ranked.slice(0, 6).map(r => titleCase(r.g)),
      topArtists: members.slice().sort((x, y) => scoreOf(y) - scoreOf(x)).slice(0, 3).map(m => byId.get(m).name),
      members
    });
  });

  if (uncharted.length) {
    described.push({
      id: `cluster_${described.length}_${UNCLASSIFIED_FAMILY.id}`,
      name: UNCLASSIFIED_FAMILY.label,
      family: UNCLASSIFIED_FAMILY.id,
      familyLabel: 'No genre data found yet',
      color: UNCHARTED_COLOR,
      subgenres: [],
      topArtists: uncharted.slice().sort((x, y) => scoreOf(y) - scoreOf(x)).slice(0, 3).map(id => byId.get(id).name),
      members: uncharted
    });
  }

  return described;
}
