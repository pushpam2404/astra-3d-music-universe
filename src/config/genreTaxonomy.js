// src/config/genreTaxonomy.js
/**
 * Cluster colors (137.5° golden-angle hue steps in OKLCH, gamut-clamped), the
 * "Genre Unknown" bucket, and basic genre-text normalisation. No genre knowledge lives here; see src/etl/genreSignals.js.
 *
 * Imported by both the backend and browser, so it must stay free of browser APIs.
 */

function linearToSrgb(c) {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
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
 * Returns a maximally-distant unique color for cluster `index` (ordered by cluster size)
 * using the golden-angle (137.507764°) sequence in OKLCH color space.
 *
 * Every successive cluster lands in the widest unvisited hue gap on the 360° circle,
 * ensuring adjacent or related genres (e.g. EDM vs Future Bass, Filmi vs Indian Pop)
 * never collide or look similar.
 */
export function getDistinctClusterColor(index) {
  const hue = (index * 137.507764 + 22.0) % 360;
  const lightness = 0.72 + ((index % 3) - 1) * 0.035;
  const chroma = 0.165 - (index % 2) * 0.015;
  return oklchToHex(lightness, chroma, hue);
}

export const UNCLASSIFIED_FAMILY = { id: 'unclassified', label: 'Genre Unknown', color: '#6E768C' };

/** Basic text normalisation: "Hip-Hop music" → "hip hop". Genre knowledge lives in src/etl/genreSignals.js. */
export function normalizeGenre(raw) {
  const g = String(raw)
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+music$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return g;
}
