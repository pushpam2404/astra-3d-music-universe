// server/clusterNaming.js
/**
 * Names clusters from what makes them *distinctive*, not from what is most common:
 * a genre's weight is its support inside the cluster times its lift over the whole
 * library, so "pop" (everywhere) loses to "neo psychedelia" (concentrated here).
 *
 *   two distinctive genres      → "Psychedelic & Indie Rock", "Filmi & Sufi"
 *   one genre + distinctive home → "Pakistani Pop", "Indian Folk Pop"
 *   no genre data, shared home   → "Pakistani Scene"
 *   nothing to go on             → "Atif Aslam & Co." (named after its biggest artist)
 */
import {
  familyInfo,
  OTHER_FAMILY,
  UNCLASSIFIED_FAMILY,
  CLUSTER_COLORS,
  getDistinctClusterColor
} from '../src/config/genreTaxonomy.js';
import { DEMONYMS, PLACE_TAGS } from './places.js';

export { CLUSTER_COLORS };

// Genres so broad that they only name a cluster when nothing more specific exists.
const BROAD_GENRES = new Set(['pop', 'rock', 'world', 'music', 'singer songwriter', 'soundtrack', 'electronic', 'dance', 'instrumental', 'vocal']);
// Words that already say where the music is from; no demonym needed next to them.
const PLACE_WORDS = /\b(indian|punjabi|pakistani|hindi|urdu|filmi|bollywood|desi|bhangra|qawwali|k pop|j pop|korean|japanese|latin|brazilian|uk|british|french|german|african|arab|turkish|tamil|telugu)\b/;

// Longer names crowd the 3D labels; shorter candidates win when available.
const MAX_NAME_LENGTH = 28;
const UNCHARTED_COLOR = '#6E768C';

const CASE_FIXES = [[/\bR&b\b/g, 'R&B'], [/\bEdm\b/g, 'EDM'], [/\bUk\b/g, 'UK'], [/\bUs\b/g, 'US'], [/\bLo Fi\b/g, 'Lo-Fi'], [/\bK Pop\b/g, 'K-Pop'], [/\bJ Pop\b/g, 'J-Pop'], [/\bDnb\b/g, 'DnB'], [/\bIdm\b/g, 'IDM']];
export const titleCase = (s) => CASE_FIXES.reduce((t, [re, rep]) => t.replace(re, rep), s.replace(/\b([a-z])/g, (m) => m.toUpperCase()));

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
 * @param {Map} byId             id → { name, genres, countries, fam, score }
 * @param {number} n             total artist count
 */
export function describeClusters(clusters, uncharted, byId, n) {
  const scoreOf = (id) => byId.get(id).score || 1;

  // Library-wide frequencies for lift (measured over artists that actually have genres/countries).
  const genreDf = new Map();
  const countryDf = new Map();
  let genreKnownN = 0;
  let countryKnownN = 0;
  byId.forEach(a => {
    if (a.genres?.length) {
      genreKnownN++;
      new Set(a.genres).forEach(g => genreDf.set(g, (genreDf.get(g) || 0) + 1));
    }
    if (a.countries?.length) {
      countryKnownN++;
      new Set(a.countries).forEach(c => countryDf.set(c, (countryDf.get(c) || 0) + 1));
    }
  });
  genreKnownN = Math.max(1, genreKnownN || n);
  countryKnownN = Math.max(1, countryKnownN || n);

  const usedNames = new Set();
  const described = [];

  const sortedClusters = clusters
    .slice()
    .sort((A, B) => B.reduce((s, id) => s + scoreOf(id), 0) - A.reduce((s, id) => s + scoreOf(id), 0));

  sortedClusters.forEach((members, clusterIdx) => {
    const genreRichSize = Math.max(1, members.filter(id => byId.get(id).genres?.length).length);
    const countryRichSize = Math.max(1, members.filter(id => byId.get(id).countries?.length).length);
    const famScore = {};
    const genreCount = new Map();
    const countryCount = new Map();
    members.forEach(id => {
      const a = byId.get(id);
      Object.entries(a.families).forEach(([f, w]) => { famScore[f] = (famScore[f] || 0) + w * scoreOf(id); });
      new Set(a.genres).forEach(g => genreCount.set(g, (genreCount.get(g) || 0) + 1));
      new Set(a.countries).forEach(c => countryCount.set(c, (countryCount.get(c) || 0) + 1));
    });

    // Distinctive genres: support × log-lift over genre-known members in the cluster.
    const minSupport = Math.max(2, Math.ceil(genreRichSize * 0.14));
    const ranked = [...genreCount.entries()]
      .filter(([g, c]) => c >= Math.min(minSupport, genreRichSize) && !PLACE_TAGS.has(g))
      .map(([g, c]) => {
        const support = c / genreRichSize;
        const lift = support / ((genreDf.get(g) || 1) / genreKnownN);
        return { g, support, score: support * Math.log(1 + lift) * (BROAD_GENRES.has(g) ? 0.45 : 1) };
      })
      .sort((x, y) => y.score - x.score || x.g.localeCompare(y.g));

    const primary = ranked[0]?.g;
    const secondary = ranked.slice(1).find(r => r.support >= 0.16 && !overlaps(r.g, primary))?.g;

    // A home country names the cluster only where it is concentrated.
    const [topCountry, topCountryCount] = [...countryCount.entries()].sort((x, y) => y[1] - x[1])[0] || [];
    const share = topCountry ? topCountryCount / countryRichSize : 0;
    const globalShare = topCountry ? (countryDf.get(topCountry) || 1) / countryKnownN : 1;
    const demonym = topCountry && share >= 0.55 && share >= 1.35 * globalShare ? (DEMONYMS[topCountry] || null) : null;

    const topArtists = members.slice().sort((x, y) => scoreOf(y) - scoreOf(x)).slice(0, 3).map(id => byId.get(id).name);

    const candidates = [];
    if (primary) {
      const p = titleCase(primary);
      const withHome = demonym && !PLACE_WORDS.test(primary) ? `${demonym} ${p}` : null;
      if (secondary) candidates.push(withHome && withHome.length <= 22 ? joinGenres(withHome, titleCase(secondary)) : joinGenres(p, titleCase(secondary)));
      if (withHome) candidates.push(withHome);
      candidates.push(p);
      if (secondary) candidates.push(joinGenres(titleCase(secondary), p));
    }
    if (demonym) candidates.push(`${demonym} Scene`);
    candidates.push(`${topArtists[0]} & Co.`);
    const name = candidates.find(c => c.length <= MAX_NAME_LENGTH && !usedNames.has(c.toLowerCase()))
      || candidates.find(c => !usedNames.has(c.toLowerCase()))
      || `${topArtists[0]} & Co. ${described.length + 1}`;
    usedNames.add(name.toLowerCase());

    // Family stays as a metadata/text label; each cluster gets a unique maximally-distant color in size order
    const familyId = Object.entries(famScore).sort((x, y) => y[1] - x[1])[0]?.[0];
    const family = familyId ? familyInfo(familyId) : OTHER_FAMILY;
    const color = getDistinctClusterColor(clusterIdx);

    described.push({
      id: `cluster_${described.length}_${family.id}`,
      name,
      family: family.id,
      familyLabel: family.label,
      color,
      subgenres: ranked.slice(0, 6).map(r => titleCase(r.g)),
      topArtists,
      members
    });
  });

  if (uncharted.length) {
    described.push({
      id: `cluster_${described.length}_${UNCLASSIFIED_FAMILY.id}`,
      name: 'Uncharted',
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
