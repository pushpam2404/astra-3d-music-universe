// src/config/constants.js
/**
 * ASTRA // 3D Music Universe - Physical, Visual & Telemetry Constants
 */

export const TIER_BOUNDS = {
  genre: { minR: 7.5, maxR: 14.0, haloMult: 4.2 },
  artist: { minR: 3.5, maxR: 8.2, haloMult: 3.2 },
  track: { minR: 1.5, maxR: 3.6, haloMult: 2.6 }
};

export const PHYSICS_CONFIG = {
  // Spring Attraction (Hooke's Law)
  springK: 0.0085,
  restLengthSingleGenre: 34.0,
  restLengthBridgeGenre: 38.0,

  // Pairwise Repulsion (Coulomb Electrostatic)
  repulsionK: 1250.0,
  repulsionEpsilon: 16.0,

  // Swirl & Orbital Dynamics
  genreOrbitRadius: 115.0,
  genreOrbitSpeed: 0.00035,
  swirlK: 0.018,
  satelliteOrbitSpeedMin: 0.006,
  satelliteOrbitSpeedMax: 0.016,

  // Damping / Friction
  damping: 0.84,

  // Camera flight
  standoffDistances: {
    genre: 85.0,
    artist: 56.0,
    track: 36.0
  }
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
