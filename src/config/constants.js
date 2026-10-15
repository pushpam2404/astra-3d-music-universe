// src/config/constants.js
/**
 * ASTRA // 3D Music Universe - Physical, Visual & Telemetry Constants
 */

// Visual radius range per tier (log-scaled by play count in graphNormalizer).
export const TIER_BOUNDS = {
  genre: { minR: 6.0, maxR: 11.0, haloMult: 4.0 },
  artist: { minR: 2.2, maxR: 5.6, haloMult: 2.6 },
  track: { minR: 0.55, maxR: 1.25, haloMult: 2.2 }
};

// Galaxy layout geometry (src/physics/galaxyLayout.js).
export const LAYOUT_CONFIG = {
  sunCoreFactor: 1.9,        // empty space around a sun, in sun radii
  discInnerGap: 6.0,
  discSpacing: 12.5,         // phyllotaxis spacing between artist planets
  discMargin: 10.0,          // room for moons at the disc edge
  discThickness: 9.0,
  discTiltRange: 0.7,        // radians
  discSpinSpeed: 0.035,      // rad/s, rigid rotation so planets never collide
  clusterGap: 26.0,          // empty space between neighbouring cluster discs
  sunHeightJitter: 7.0,
  bridgeSpacing: 9.0,
  moonInnerGap: 2.2,
  moonSpacing: 1.35,
  moonSpeed: 0.55,           // rad/s for the innermost moon
  moonInclinationRange: 1.4
};

export const GENRE_PALETTES = {
  'Synthwave & Cyberpunk': '#FF007F',
  'Ambient & Electronic': '#00F0FF',
  'Neo-Psychedelia': '#9D00FF',
  'Indie Rock & Bedroom Pop': '#FFB800',
  'Lo-Fi Hip Hop & Beats': '#00FFA3',
  'Drum & Bass / Bass Music': '#FF3366',
  'Post-Punk & Darkwave': '#7928CA',
  'Modern Jazz & Fusion': '#38EF7D',
  'Progressive House': '#0070F3',
  'Alt-R&B & Neo-Soul': '#FF8000',
  'Industrial & EBM': '#E02424',
  'default': '#1DB954'
};

export const COLOR_SPOTIFY_GREEN = '#1DB954';
export const COLOR_LAGRANGE_GOLD = '#FFB800';
export const COLOR_USER_A_CYAN = '#00F0FF';
export const COLOR_USER_B_MAGENTA = '#FF007F';
