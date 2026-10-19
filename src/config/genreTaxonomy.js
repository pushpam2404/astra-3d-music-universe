// src/config/genreTaxonomy.js
/**
 * Maps fine-grained genre strings ("contemporary R&B", "Punjabi music", "neo-psychedelia")
 * onto broad genre families, and provides the OKLab/OKLCH maximally-separable
 * cluster color palette (greedy farthest-point order + 137.5° OKLCH golden-angle overflow).
 *
 * Imported by both the backend and browser, so it must stay free of browser APIs.
 */

export const CLUSTER_COLORS = [
  "#E1627F","#E1A6A2","#FE8169","#DA7306","#FFC48C","#C8A83A",
  "#E3D543","#999562","#6CA52E","#B9DDB1","#7CD06A","#00AB89",
  "#0AF2CD","#78BAAC","#47C7F8","#0D9AEC","#ADD6FD","#9EA4E9",
  "#8184F1","#B870D3","#F69EFE","#EFC0E3","#B082A0","#EF7EC3",
];

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

export function hexToOklab(hex) {
  const clean = String(hex).replace('#', '');
  const v = parseInt(clean, 16);
  const r = srgbToLinear(((v >> 16) & 255) / 255);
  const g = srgbToLinear(((v >> 8) & 255) / 255);
  const b = srgbToLinear((v & 255) / 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  };
}

function oklabDist(c1, c2) {
  return Math.hypot(c1.L - c2.L, c1.a - c2.a, c1.b - c2.b);
}

/**
 * Converts OKLCH (L in 0..1, C >= 0, H in degrees) to a gamut-clamped #RRGGBB hex string.
 */
export function oklchToHex(L, C, H) {
  const rad = ((H % 360) * Math.PI) / 180;
  // Binary-search chroma reduction if outside sRGB gamut so hue and lightness stay true
  let lo = 0;
  let hi = C;
  let bestR = 0, bestG = 0, bestB = 0;

  const toRgb = (chroma) => {
    const a = chroma * Math.cos(rad);
    const b = chroma * Math.sin(rad);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    return [
      +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
  };

  for (let iter = 0; iter < 10; iter++) {
    const mid = iter === 0 ? hi : (lo + hi) / 2;
    const [r, g, b] = toRgb(mid);
    const inGamut = r >= -1e-4 && r <= 1.0001 && g >= -1e-4 && g <= 1.0001 && b >= -1e-4 && b <= 1.0001;
    if (inGamut) {
      bestR = r; bestG = g; bestB = b;
      if (iter === 0) break;
      lo = mid;
    } else {
      hi = mid;
      bestR = r; bestG = g; bestB = b;
    }
  }

  const toByte = (v) => Math.round(linearToSrgb(v) * 255).toString(16).padStart(2, '0');
  return `#${toByte(bestR)}${toByte(bestG)}${toByte(bestB)}`.toUpperCase();
}

/**
 * Precomputes the greedy farthest-point ordering of `CLUSTER_COLORS` in OKLab space
 * so the largest clusters receive maximally distant colors first and hue-sorted
 * neighbours in `CLUSTER_COLORS` are never handed out consecutively.
 */
function buildFarthestPointPalette(hexList) {
  const pool = hexList.map(hex => ({ hex, lab: hexToOklab(hex) }));
  const ordered = [pool.shift()];
  while (pool.length > 0) {
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let i = 0; i < pool.length; i++) {
      let minDist = Infinity;
      for (let j = 0; j < ordered.length; j++) {
        const d = oklabDist(pool[i].lab, ordered[j].lab);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = i;
      }
    }
    ordered.push(pool.splice(bestIdx, 1)[0]);
  }
  return ordered.map(item => item.hex);
}

export const ORDERED_CLUSTER_COLORS = buildFarthestPointPalette(CLUSTER_COLORS);

/**
 * Returns a unique color for cluster `index` (ordered by cluster size).
 *  - For index 0..23: returns the greedy farthest-point ordered color from `CLUSTER_COLORS`.
 *  - For index >= 24: generates additional distinct colors at a 137.5° golden-angle hue step
 *    in OKLCH without wrapping around with `%`.
 */
export function getDistinctClusterColor(index) {
  if (index < ORDERED_CLUSTER_COLORS.length) {
    return ORDERED_CLUSTER_COLORS[index];
  }
  const overflowIdx = index - ORDERED_CLUSTER_COLORS.length;
  const hue = (overflowIdx * 137.5 + 19.0) % 360;
  const lightness = 0.74 + ((overflowIdx % 3) - 1) * 0.065;
  const chroma = 0.145 - (overflowIdx % 2) * 0.022;
  return oklchToHex(lightness, chroma, hue);
}

export const GENRE_FAMILIES = {
  hiphop:     { label: 'Hip-Hop & Rap',      color: ORDERED_CLUSTER_COLORS[0],  keywords: ['hip hop', 'rap', 'trap', 'drill', 'grime', 'boom bap', 'gangsta', 'horrorcore', 'crunk', 'phonk', 'emo rap'] },
  southasian: { label: 'South Asian',        color: ORDERED_CLUSTER_COLORS[1],  keywords: ['bollywood', 'filmi', 'punjabi', 'bhangra', 'qawwali', 'sufi', 'indian', 'hindi', 'ghazal', 'hindustani', 'carnatic', 'desi', 'urdu', 'pakistani', 'tamil', 'telugu', 'kannada', 'malayalam', 'marathi', 'bengali', 'haryanvi', 'tollywood', 'kollywood'] },
  pop:        { label: 'Pop',                color: ORDERED_CLUSTER_COLORS[2],  keywords: ['pop', 'boy band', 'girl group', 'teen', 'adult contemporary'] },
  rock:       { label: 'Rock & Indie',       color: ORDERED_CLUSTER_COLORS[3],  keywords: ['rock', 'indie', 'alternative', 'punk', 'grunge', 'shoegaze', 'psychedel', 'neo psychedel', 'britpop', 'emo', 'new wave', 'post punk', 'garage', 'dream pop'] },
  electronic: { label: 'Electronic & Dance', color: ORDERED_CLUSTER_COLORS[4],  keywords: ['electro', 'edm', 'house', 'techno', 'trance', 'dubstep', 'drum and bass', 'dnb', 'bass music', 'synthwave', 'future bass', 'ambient', 'downtempo', 'idm', 'big room', 'moombahton', 'dance', 'trip hop', 'chillwave', 'lo fi', 'lofi', 'french touch', 'synth'] },
  rnb:        { label: 'R&B & Soul',         color: ORDERED_CLUSTER_COLORS[5],  keywords: ['r&b', 'rnb', 'rhythm and blues', 'soul', 'funk', 'motown', 'disco', 'gospel', 'quiet storm'] },
  metal:      { label: 'Metal & Heavy',      color: ORDERED_CLUSTER_COLORS[6],  keywords: ['metal', 'metalcore', 'hardcore', 'djent', 'screamo', 'deathcore'] },
  folk:       { label: 'Folk & Acoustic',    color: ORDERED_CLUSTER_COLORS[7],  keywords: ['folk', 'singer songwriter', 'acoustic', 'country', 'americana', 'bluegrass'] },
  jazz:       { label: 'Jazz & Blues',       color: ORDERED_CLUSTER_COLORS[8],  keywords: ['jazz', 'blues', 'swing', 'bossa nova', 'lounge', 'bebop', 'fusion'] },
  classical:  { label: 'Classical & Score',  color: ORDERED_CLUSTER_COLORS[9],  keywords: ['classical', 'orchestra', 'soundtrack', 'film score', 'score', 'opera', 'baroque', 'piano', 'instrumental', 'new age', 'cinematic', 'composer'] },
  latin:      { label: 'Latin',              color: ORDERED_CLUSTER_COLORS[10], keywords: ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'urbano', 'regional mexican', 'flamenco', 'samba', 'brazilian', 'sertanejo', 'dembow'] },
  asianpop:   { label: 'K-Pop & J-Pop',      color: ORDERED_CLUSTER_COLORS[11], keywords: ['k pop', 'j pop', 'c pop', 'mandopop', 'cantopop', 'j rock', 'anime', 'city pop', 'korean', 'japanese'] }
};

// Wikidata occupations that strongly imply a genre (lowercase occupation label → genre).
export const OCCUPATION_GENRES = {
  'rapper': 'hip hop',
  'playback singer': 'filmi',
  'music director': 'filmi',
  'film score composer': 'film score',
  'film composer': 'film score',
  'qawwal': 'qawwali',
  'disc jockey': 'electronic dance',
  'country singer': 'country',
  'jazz musician': 'jazz',
  'opera singer': 'opera'
};

export const OTHER_FAMILY = { id: 'other', label: 'Eclectic', color: ORDERED_CLUSTER_COLORS[12] };
export const UNCLASSIFIED_FAMILY = { id: 'unclassified', label: 'Uncharted', color: '#6E768C' };

const FAMILY_MATCHERS = Object.entries(GENRE_FAMILIES).map(([id, fam]) => ({
  id,
  // Keywords match at a word start: "electro" hits "electropop", "rap" does not hit "trap".
  regex: new RegExp(`(?:^|[\\s/&,(])(?:${fam.keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`)
}));

// Different sources say the same thing differently (Wikidata vs MusicBrainz tags).
const GENRE_ALIASES = {
  'indian film': 'filmi',
  'bollywood': 'filmi',
  'hindi film': 'filmi',
  'film': 'filmi',
  'rhythm and blues': 'r&b',
  'rnb': 'r&b',
  'electronic dance': 'edm',
  'hiphop': 'hip hop',
  'rap music': 'rap',
  'singer/songwriter': 'singer songwriter',
  'alt rock': 'alternative rock',
  'alternative': 'alternative rock',
  'indie': 'indie pop'
};

/** "Hip-hop music" → "hip hop"; "Indian film music" → "filmi" */
export function normalizeGenre(raw) {
  const g = String(raw)
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+music$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return GENRE_ALIASES[g] || g;
}

/** Returns the family ids a single normalized genre belongs to. */
export function familiesForGenre(genre) {
  const hits = FAMILY_MATCHERS.filter(m => m.regex.test(genre)).map(m => m.id);
  // "k pop" also matches plain "pop"; the more specific family wins.
  if (hits.includes('asianpop')) return hits.filter(h => h !== 'pop');
  return hits;
}

/** Sums family membership over a list of genres into a normalized { familyId: weight } vector. */
export function familyVector(genres) {
  const vec = {};
  genres.forEach(g => {
    const fams = familiesForGenre(g);
    fams.forEach(f => { vec[f] = (vec[f] || 0) + 1 / fams.length; });
  });
  const total = Object.values(vec).reduce((s, v) => s + v, 0);
  if (total > 0) Object.keys(vec).forEach(k => { vec[k] /= total; });
  return vec;
}

export function familyInfo(id) {
  if (GENRE_FAMILIES[id]) return { id, ...GENRE_FAMILIES[id] };
  if (id === UNCLASSIFIED_FAMILY.id) return UNCLASSIFIED_FAMILY;
  return OTHER_FAMILY;
}
