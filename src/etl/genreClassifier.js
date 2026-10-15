// src/etl/genreClassifier.js
/**
 * Heuristic genre classifier for artists encountered in offline GDPR streaming histories
 */

const GENRE_KEYWORD_RULES = [
  { genre: 'Synthwave & Cyberpunk', keywords: ['midnight', 'gunship', 'kavinsky', 'carpenter', 'synth', 'retro', 'wave', 'perturbator', 'fm-84'] },
  { genre: 'Ambient & Electronic', keywords: ['tycho', 'bonobo', 'four tet', 'brian eno', 'board of canada', 'aphex', 'jon hopkins', 'ambient', 'electronic'] },
  { genre: 'Indie Rock & Bedroom Pop', keywords: ['clairo', 'mac demarco', 'boy pablo', 'rex orange', 'beabadoobee', 'men i trust', 'alvvays', 'indie', 'pop', 'rock'] },
  { genre: 'Neo-Psychedelia', keywords: ['tame impala', 'khruangbin', 'king gizzard', 'unknown mortal', 'pond', 'crumb', 'psych'] },
  { genre: 'Lo-Fi Hip Hop & Beats', keywords: ['jinsang', 'potsu', 'kupla', 'idealism', 'saib', 'chilledcow', 'lofi', 'lo-fi', 'beats', 'chillhop'] },
  { genre: 'Drum & Bass / Bass Music', keywords: ['sub focus', 'noisia', 'chase & status', 'pendulum', 'netsky', 'camon & krooked', 'dnb', 'bass'] },
  { genre: 'Industrial & EBM', keywords: ['rezz', 'gesaffelstein', 'nine inch nails', 'boy harsher', 'marilyn', 'industrial'] },
  { genre: 'Progressive House', keywords: ['prydz', 'deadmau5', 'lane 8', 'kaskade', 'armin', 'house', 'prog'] }
];

export function assignGenreForArtist(artistName) {
  const lower = artistName.toLowerCase();
  for (const rule of GENRE_KEYWORD_RULES) {
    if (rule.keywords.some(k => lower.includes(k))) {
      return rule.genre;
    }
  }

  // Consistent hash bucket fallback
  let hash = 0;
  for (let i = 0; i < artistName.length; i++) {
    hash = (hash << 5) - hash + artistName.charCodeAt(i);
    hash |= 0;
  }
  const fallbackGenres = [
    'Indie Rock & Bedroom Pop',
    'Ambient & Electronic',
    'Neo-Psychedelia',
    'Synthwave & Cyberpunk',
    'Lo-Fi Hip Hop & Beats'
  ];
  return fallbackGenres[Math.abs(hash) % fallbackGenres.length];
}
