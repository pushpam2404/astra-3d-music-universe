// src/config/genreTaxonomy.js
/**
 * Maps fine-grained genre strings ("contemporary R&B", "Punjabi music", "neo-psychedelia")
 * onto broad genre families. A genre may belong to several families ("Indian hip hop"
 * → hip-hop + south asian), which is what lets bridge artists sit between clusters.
 *
 * Uses a curated, editorial celestial palette (warm terracotta, champagne gold,
 * velvet rose, slate sapphire, sea-glass verdigris, twilight amethyst).
 */

export const GENRE_FAMILIES = {
  hiphop:     { label: 'Hip-Hop & Rap',      color: '#D98A5B', keywords: ['hip hop', 'rap', 'trap', 'drill', 'grime', 'boom bap', 'gangsta', 'horrorcore', 'crunk', 'phonk', 'emo rap'] },
  southasian: { label: 'South Asian',        color: '#E2B86B', keywords: ['bollywood', 'filmi', 'punjabi', 'bhangra', 'qawwali', 'sufi', 'indian', 'hindi', 'ghazal', 'hindustani', 'carnatic', 'desi', 'urdu', 'pakistani', 'tamil', 'telugu', 'kannada', 'malayalam', 'marathi', 'bengali', 'haryanvi', 'tollywood', 'kollywood'] },
  pop:        { label: 'Pop',                color: '#D87A9E', keywords: ['pop', 'boy band', 'girl group', 'teen', 'adult contemporary'] },
  rock:       { label: 'Rock & Indie',       color: '#6E98C8', keywords: ['rock', 'indie', 'alternative', 'punk', 'grunge', 'shoegaze', 'psychedel', 'neo psychedel', 'britpop', 'emo', 'new wave', 'post punk', 'garage', 'dream pop'] },
  electronic: { label: 'Electronic & Dance', color: '#5DB5B0', keywords: ['electro', 'edm', 'house', 'techno', 'trance', 'dubstep', 'drum and bass', 'dnb', 'bass music', 'synthwave', 'future bass', 'ambient', 'downtempo', 'idm', 'big room', 'moombahton', 'dance', 'trip hop', 'chillwave', 'lo fi', 'lofi', 'french touch', 'synth'] },
  rnb:        { label: 'R&B & Soul',         color: '#A582C8', keywords: ['r&b', 'rnb', 'rhythm and blues', 'soul', 'funk', 'motown', 'disco', 'gospel', 'quiet storm'] },
  metal:      { label: 'Metal & Heavy',      color: '#C96567', keywords: ['metal', 'metalcore', 'hardcore', 'djent', 'screamo', 'deathcore'] },
  folk:       { label: 'Folk & Acoustic',    color: '#88B382', keywords: ['folk', 'singer songwriter', 'acoustic', 'country', 'americana', 'bluegrass'] },
  jazz:       { label: 'Jazz & Blues',       color: '#64A8A0', keywords: ['jazz', 'blues', 'swing', 'bossa nova', 'lounge', 'bebop', 'fusion'] },
  classical:  { label: 'Classical & Score',  color: '#DFD3BA', keywords: ['classical', 'orchestra', 'soundtrack', 'film score', 'score', 'opera', 'baroque', 'piano', 'instrumental', 'new age', 'cinematic', 'composer'] },
  latin:      { label: 'Latin',              color: '#D97762', keywords: ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'urbano', 'regional mexican', 'flamenco', 'samba', 'brazilian', 'sertanejo', 'dembow'] },
  asianpop:   { label: 'K-Pop & J-Pop',      color: '#CFA0C8', keywords: ['k pop', 'j pop', 'c pop', 'mandopop', 'cantopop', 'j rock', 'anime', 'city pop', 'korean', 'japanese'] }
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

export const OTHER_FAMILY = { id: 'other', label: 'Eclectic', color: '#94A0B8' };
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
