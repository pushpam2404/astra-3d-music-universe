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
import { familyInfo, OTHER_FAMILY, UNCLASSIFIED_FAMILY } from '../src/config/genreTaxonomy.js';

const DEMONYMS = {
  India: 'Indian', Pakistan: 'Pakistani', Bangladesh: 'Bangladeshi', Nepal: 'Nepali', 'Sri Lanka': 'Sri Lankan',
  'United States': 'American', 'United States of America': 'American', 'United Kingdom': 'British', England: 'English',
  Canada: 'Canadian', Australia: 'Australian', 'New Zealand': 'Kiwi', Ireland: 'Irish', Scotland: 'Scottish',
  'South Korea': 'Korean', Japan: 'Japanese', China: 'Chinese', Taiwan: 'Taiwanese', Indonesia: 'Indonesian',
  Philippines: 'Filipino', Thailand: 'Thai', Vietnam: 'Vietnamese', France: 'French', Germany: 'German',
  Italy: 'Italian', Spain: 'Spanish', Portugal: 'Portuguese', Netherlands: 'Dutch', Belgium: 'Belgian',
  Sweden: 'Swedish', Norway: 'Norwegian', Denmark: 'Danish', Finland: 'Finnish', Iceland: 'Icelandic',
  Poland: 'Polish', Russia: 'Russian', Ukraine: 'Ukrainian', Turkey: 'Turkish', Greece: 'Greek', Israel: 'Israeli',
  Iran: 'Iranian', Egypt: 'Egyptian', Nigeria: 'Nigerian', Ghana: 'Ghanaian', 'South Africa': 'South African',
  Brazil: 'Brazilian', Mexico: 'Mexican', Argentina: 'Argentine', Colombia: 'Colombian', Chile: 'Chilean',
  'Puerto Rico': 'Puerto Rican', Jamaica: 'Jamaican', Cuba: 'Cuban', Punjab: 'Punjabi', Karachi: 'Karachi',
  Lahore: 'Lahori', Mumbai: 'Mumbai'
};

// Genres so broad that they only name a cluster when nothing more specific exists.
const BROAD_GENRES = new Set(['pop', 'rock', 'world', 'music', 'singer songwriter', 'soundtrack', 'electronic', 'dance', 'instrumental', 'vocal']);
// Words that already say where the music is from; no demonym needed next to them.
const PLACE_WORDS = /\b(indian|punjabi|pakistani|hindi|urdu|filmi|bollywood|desi|bhangra|qawwali|k pop|j pop|korean|japanese|latin|brazilian|uk|british|french|german|african|arab|turkish|tamil|telugu)\b/;

// Longer names crowd the 3D labels; shorter candidates win when available.
const MAX_NAME_LENGTH = 28;
const FALLBACK_PALETTE = ['#7FD1FF', '#FFB3C7', '#C9A2FF', '#9EF0C4', '#FFD59E', '#A3B8FF', '#F7A8FF', '#B8F2E6'];
const UNCHARTED_COLOR = '#6B7290';

const CASE_FIXES = [[/\bR&b\b/g, 'R&B'], [/\bEdm\b/g, 'EDM'], [/\bUk\b/g, 'UK'], [/\bUs\b/g, 'US'], [/\bLo Fi\b/g, 'Lo-Fi'], [/\bK Pop\b/g, 'K-Pop'], [/\bJ Pop\b/g, 'J-Pop'], [/\bDnb\b/g, 'DnB'], [/\bIdm\b/g, 'IDM']];
export const titleCase = (s) => CASE_FIXES.reduce((t, [re, rep]) => t.replace(re, rep), s.replace(/\b([a-z])/g, (m) => m.toUpperCase()));

function hexToHsl(hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const k = (x) => (x + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (x) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(x) - 3, Math.min(9 - k(x), 1)))));
  return `#${[f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Shifts the hue so clusters of the same family stay distinguishable. */
function variantColor(hex, variantIndex) {
  if (variantIndex === 0) return hex;
  const [h, s, l] = hexToHsl(hex);
  const step = Math.ceil(variantIndex / 2) * 22 * (variantIndex % 2 ? 1 : -1);
  return hslToHex((h + step + 360) % 360, s, Math.min(0.72, l + 0.04));
}

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

  // Library-wide frequencies for lift.
  const genreDf = new Map();
  const countryDf = new Map();
  byId.forEach(a => {
    new Set(a.genres).forEach(g => genreDf.set(g, (genreDf.get(g) || 0) + 1));
    new Set(a.countries).forEach(c => countryDf.set(c, (countryDf.get(c) || 0) + 1));
  });

  const usedNames = new Set();
  const familyUse = new Map();
  let fallbackColor = 0;
  const described = [];

  const sortedClusters = clusters
    .slice()
    .sort((A, B) => B.reduce((s, id) => s + scoreOf(id), 0) - A.reduce((s, id) => s + scoreOf(id), 0));

  sortedClusters.forEach(members => {
    const size = members.length;
    const famScore = {};
    const genreCount = new Map();
    const countryCount = new Map();
    members.forEach(id => {
      const a = byId.get(id);
      Object.entries(a.fam).forEach(([f, w]) => { famScore[f] = (famScore[f] || 0) + w * scoreOf(id); });
      new Set(a.genres).forEach(g => genreCount.set(g, (genreCount.get(g) || 0) + 1));
      new Set(a.countries).forEach(c => countryCount.set(c, (countryCount.get(c) || 0) + 1));
    });

    // Distinctive genres: support × log-lift, broad genres discounted.
    const minSupport = Math.max(2, Math.ceil(size * 0.15));
    const ranked = [...genreCount.entries()]
      .filter(([, c]) => c >= Math.min(minSupport, size))
      .map(([g, c]) => {
        const support = c / size;
        const lift = support / (genreDf.get(g) / n);
        return { g, support, score: support * Math.log(1 + lift) * (BROAD_GENRES.has(g) ? 0.45 : 1) };
      })
      .sort((x, y) => y.score - x.score || x.g.localeCompare(y.g));

    const primary = ranked[0]?.g;
    const secondary = ranked.slice(1).find(r => r.support >= 0.18 && !overlaps(r.g, primary))?.g;

    // A home country names the cluster only where it is concentrated.
    const [topCountry, topCountryCount] = [...countryCount.entries()].sort((x, y) => y[1] - x[1])[0] || [];
    const share = topCountry ? topCountryCount / size : 0;
    const globalShare = topCountry ? countryDf.get(topCountry) / n : 1;
    const demonym = topCountry && share >= 0.55 && share >= 1.4 * globalShare ? (DEMONYMS[topCountry] || null) : null;

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

    // Color: family color (hue-shifted per repeat); genre-less clusters get a distinct fallback hue.
    const familyId = Object.entries(famScore).sort((x, y) => y[1] - x[1])[0]?.[0];
    const family = familyId ? familyInfo(familyId) : OTHER_FAMILY;
    let color;
    if (familyId) {
      const variant = familyUse.get(family.id) || 0;
      familyUse.set(family.id, variant + 1);
      color = variantColor(family.color, variant);
    } else {
      color = FALLBACK_PALETTE[fallbackColor++ % FALLBACK_PALETTE.length];
    }

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
