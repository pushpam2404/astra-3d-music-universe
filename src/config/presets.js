// src/config/presets.js
/**
 * Curated Galaxy Presets for ASTRA // 3D Music Universe
 * Provides immediate astrophysical visualization without requiring Spotify login.
 */

export const GALAXY_PRESETS = {
  cosmic_synth: {
    id: 'cosmic_synth',
    name: 'Cosmic Synth & Retrowave',
    description: 'Neon interstellar synth arpeggios, cyberpunk basslines, and French electro dreamscapes.',
    genres: [
      { id: 'g_synthwave', name: 'Synthwave & Cyberpunk', color: '#FF007F', basePlays: 6200, energy: 0.88, bpm: 128 },
      { id: 'g_ambient_elec', name: 'Ambient & Electronic', color: '#00F0FF', basePlays: 4800, energy: 0.62, bpm: 110 },
      { id: 'g_french_touch', name: 'French Touch & Electro', color: '#FFB800', basePlays: 5100, energy: 0.84, bpm: 124 }
    ],
    artists: [
      {
        id: 'a_the_midnight',
        name: 'The Midnight',
        genres: ['g_synthwave'],
        basePlays: 2450,
        energy: 0.78,
        valence: 0.68,
        acoustic: 0.15,
        dance: 0.64,
        bpm: 122,
        followers: '680K'
      },
      {
        id: 'a_gunship',
        name: 'Gunship',
        genres: ['g_synthwave'],
        basePlays: 1980,
        energy: 0.85,
        valence: 0.52,
        acoustic: 0.10,
        dance: 0.59,
        bpm: 126,
        followers: '420K'
      },
      {
        id: 'a_daft_punk',
        name: 'Daft Punk',
        genres: ['g_french_touch', 'g_ambient_elec'], // Bridge artist!
        basePlays: 3200,
        energy: 0.82,
        valence: 0.76,
        acoustic: 0.12,
        dance: 0.79,
        bpm: 123,
        followers: '12.8M'
      },
      {
        id: 'a_kavinsky',
        name: 'Kavinsky',
        genres: ['g_synthwave', 'g_french_touch'], // Bridge artist!
        basePlays: 1650,
        energy: 0.90,
        valence: 0.44,
        acoustic: 0.05,
        dance: 0.68,
        bpm: 118,
        followers: '1.2M'
      },
      {
        id: 'a_tycho',
        name: 'Tycho',
        genres: ['g_ambient_elec'],
        basePlays: 2150,
        energy: 0.58,
        valence: 0.62,
        acoustic: 0.38,
        dance: 0.55,
        bpm: 104,
        followers: '890K'
      },
      {
        id: 'a_carpenter_brut',
        name: 'Carpenter Brut',
        genres: ['g_synthwave'],
        basePlays: 1420,
        energy: 0.96,
        valence: 0.32,
        acoustic: 0.02,
        dance: 0.52,
        bpm: 140,
        followers: '560K'
      },
      {
        id: 'a_justice',
        name: 'Justice',
        genres: ['g_french_touch'],
        basePlays: 1890,
        energy: 0.91,
        valence: 0.70,
        acoustic: 0.08,
        dance: 0.72,
        bpm: 125,
        followers: '1.9M'
      },
      {
        id: 'a_bonobo',
        name: 'Bonobo',
        genres: ['g_ambient_elec'],
        basePlays: 1780,
        energy: 0.66,
        valence: 0.58,
        acoustic: 0.42,
        dance: 0.65,
        bpm: 112,
        followers: '1.6M'
      }
    ],
    tracks: [
      { id: 't_sunset', name: 'Sunset', artistId: 'a_the_midnight', basePlays: 840, bpm: 122, valence: 0.72, energy: 0.81, acoustic: 0.12, dance: 0.65, durationMin: 5.4 },
      { id: 't_days_of_thunder', name: 'Days of Thunder', artistId: 'a_the_midnight', basePlays: 690, bpm: 118, valence: 0.66, energy: 0.74, acoustic: 0.18, dance: 0.62, durationMin: 5.7 },
      { id: 't_tech_noir', name: 'Tech Noir', artistId: 'a_gunship', basePlays: 720, bpm: 126, valence: 0.48, energy: 0.86, acoustic: 0.08, dance: 0.58, durationMin: 4.9 },
      { id: 't_when_you_grow_up', name: 'When You Grow Up, Your Heart Dies', artistId: 'a_gunship', basePlays: 580, bpm: 130, valence: 0.60, energy: 0.89, acoustic: 0.10, dance: 0.56, durationMin: 5.8 },
      { id: 't_veridis_quo', name: 'Veridis Quo', artistId: 'a_daft_punk', basePlays: 1120, bpm: 106, valence: 0.52, energy: 0.64, acoustic: 0.22, dance: 0.71, durationMin: 5.7 },
      { id: 't_voyager', name: 'Voyager', artistId: 'a_daft_punk', basePlays: 980, bpm: 120, valence: 0.88, energy: 0.84, acoustic: 0.05, dance: 0.82, durationMin: 3.8 },
      { id: 't_nightcall', name: 'Nightcall', artistId: 'a_kavinsky', basePlays: 890, bpm: 118, valence: 0.42, energy: 0.85, acoustic: 0.04, dance: 0.66, durationMin: 4.3 },
      { id: 't_awake', name: 'Awake', artistId: 'a_tycho', basePlays: 790, bpm: 102, valence: 0.65, energy: 0.61, acoustic: 0.35, dance: 0.58, durationMin: 4.7 },
      { id: 't_a_walk', name: 'A Walk', artistId: 'a_tycho', basePlays: 640, bpm: 98, valence: 0.59, energy: 0.54, acoustic: 0.41, dance: 0.52, durationMin: 5.3 },
      { id: 't_turbo_killer', name: 'Turbo Killer', artistId: 'a_carpenter_brut', basePlays: 610, bpm: 142, valence: 0.30, energy: 0.98, acoustic: 0.01, dance: 0.49, durationMin: 3.5 },
      { id: 't_genesis', name: 'Genesis', artistId: 'a_justice', basePlays: 760, bpm: 117, valence: 0.62, energy: 0.92, acoustic: 0.06, dance: 0.70, durationMin: 3.9 },
      { id: 't_cirrus', name: 'Cirrus', artistId: 'a_bonobo', basePlays: 730, bpm: 114, valence: 0.61, energy: 0.69, acoustic: 0.36, dance: 0.68, durationMin: 5.9 }
    ]
  },

  lofi_indie: {
    id: 'lofi_indie',
    name: 'Neo-Psychedelia & Lo-Fi Beats',
    description: 'Dreamy chorus guitars, dusty vinyl Rhodes, and nostalgic late-night harmonic tapestries.',
    genres: [
      { id: 'g_neo_psych', name: 'Neo-Psychedelia', color: '#9D00FF', basePlays: 5900, energy: 0.68, bpm: 116 },
      { id: 'g_lofi_beats', name: 'Lo-Fi Hip Hop & Beats', color: '#00FFA3', basePlays: 6400, energy: 0.45, bpm: 84 },
      { id: 'g_bedroom_pop', name: 'Indie Rock & Bedroom Pop', color: '#FFB800', basePlays: 4900, energy: 0.58, bpm: 108 }
    ],
    artists: [
      {
        id: 'a_tame_impala',
        name: 'Tame Impala',
        genres: ['g_neo_psych', 'g_bedroom_pop'], // Multi-genre bridge!
        basePlays: 3600,
        energy: 0.75,
        valence: 0.64,
        acoustic: 0.20,
        dance: 0.62,
        bpm: 118,
        followers: '15.4M'
      },
      {
        id: 'a_khruangbin',
        name: 'Khruangbin',
        genres: ['g_neo_psych'],
        basePlays: 2300,
        energy: 0.52,
        valence: 0.72,
        acoustic: 0.55,
        dance: 0.69,
        bpm: 104,
        followers: '2.4M'
      },
      {
        id: 'a_jinsang',
        name: 'Jinsang',
        genres: ['g_lofi_beats'],
        basePlays: 2800,
        energy: 0.42,
        valence: 0.54,
        acoustic: 0.72,
        dance: 0.74,
        bpm: 82,
        followers: '920K'
      },
      {
        id: 'a_clairo',
        name: 'Clairo',
        genres: ['g_bedroom_pop'],
        basePlays: 2200,
        energy: 0.48,
        valence: 0.58,
        acoustic: 0.65,
        dance: 0.66,
        bpm: 96,
        followers: '7.8M'
      },
      {
        id: 'a_mac_demarco',
        name: 'Mac DeMarco',
        genres: ['g_bedroom_pop', 'g_neo_psych'], // Bridge!
        basePlays: 2100,
        energy: 0.54,
        valence: 0.66,
        acoustic: 0.48,
        dance: 0.60,
        bpm: 112,
        followers: '5.2M'
      },
      {
        id: 'a_potsu',
        name: 'Potsu',
        genres: ['g_lofi_beats'],
        basePlays: 1950,
        energy: 0.38,
        valence: 0.48,
        acoustic: 0.81,
        dance: 0.70,
        bpm: 86,
        followers: '680K'
      }
    ],
    tracks: [
      { id: 't_less_i_know', name: 'The Less I Know The Better', artistId: 'a_tame_impala', basePlays: 1450, bpm: 117, valence: 0.78, energy: 0.74, acoustic: 0.14, dance: 0.64, durationMin: 3.6 },
      { id: 't_borderline', name: 'Borderline', artistId: 'a_tame_impala', basePlays: 1120, bpm: 122, valence: 0.68, energy: 0.78, acoustic: 0.16, dance: 0.68, durationMin: 3.9 },
      { id: 't_texas_sun', name: 'Texas Sun', artistId: 'a_khruangbin', basePlays: 950, bpm: 108, valence: 0.74, energy: 0.56, acoustic: 0.49, dance: 0.66, durationMin: 4.2 },
      { id: 't_time_you_and_i', name: 'Time (You and I)', artistId: 'a_khruangbin', basePlays: 780, bpm: 114, valence: 0.82, energy: 0.68, acoustic: 0.38, dance: 0.77, durationMin: 5.7 },
      { id: 't_affection', name: 'Affection', artistId: 'a_jinsang', basePlays: 1180, bpm: 82, valence: 0.55, energy: 0.40, acoustic: 0.75, dance: 0.76, durationMin: 2.4 },
      { id: 't_summer_madness', name: 'Summer Madness', artistId: 'a_jinsang', basePlays: 890, bpm: 84, valence: 0.51, energy: 0.44, acoustic: 0.69, dance: 0.72, durationMin: 2.6 },
      { id: 't_pretty_girl', name: 'Pretty Girl', artistId: 'a_clairo', basePlays: 920, bpm: 94, valence: 0.62, energy: 0.45, acoustic: 0.62, dance: 0.67, durationMin: 3.0 },
      { id: 't_chamber_of_reflection', name: 'Chamber of Reflection', artistId: 'a_mac_demarco', basePlays: 1040, bpm: 112, valence: 0.64, energy: 0.52, acoustic: 0.42, dance: 0.63, durationMin: 3.8 }
    ]
  },

  hyper_bass: {
    id: 'hyper_bass',
    name: 'Drum & Bass & Cybernetic Bass',
    description: 'High-velocity breakbeats, modular neuro-reese basslines, and hyper-kinetic sound design.',
    genres: [
      { id: 'g_dnb', name: 'Drum & Bass / Bass Music', color: '#FF3366', basePlays: 6800, energy: 0.94, bpm: 174 },
      { id: 'g_midtempo', name: 'Industrial & EBM', color: '#7928CA', basePlays: 4500, energy: 0.89, bpm: 100 },
      { id: 'g_prog_house', name: 'Progressive House', color: '#0070F3', basePlays: 4200, energy: 0.81, bpm: 126 }
    ],
    artists: [
      {
        id: 'a_sub_focus',
        name: 'Sub Focus',
        genres: ['g_dnb'],
        basePlays: 2750,
        energy: 0.92,
        valence: 0.65,
        acoustic: 0.04,
        dance: 0.58,
        bpm: 174,
        followers: '1.4M'
      },
      {
        id: 'a_rezz',
        name: 'REZZ',
        genres: ['g_midtempo'],
        basePlays: 2100,
        energy: 0.89,
        valence: 0.35,
        acoustic: 0.03,
        dance: 0.64,
        bpm: 100,
        followers: '850K'
      },
      {
        id: 'a_noisia',
        name: 'Noisia',
        genres: ['g_dnb', 'g_midtempo'], // Bridge!
        basePlays: 1950,
        energy: 0.96,
        valence: 0.28,
        acoustic: 0.02,
        dance: 0.50,
        bpm: 172,
        followers: '720K'
      },
      {
        id: 'a_eric_prydz',
        name: 'Eric Prydz',
        genres: ['g_prog_house'],
        basePlays: 2350,
        energy: 0.86,
        valence: 0.58,
        acoustic: 0.07,
        dance: 0.68,
        bpm: 126,
        followers: '2.1M'
      },
      {
        id: 'a_deadmau5',
        name: 'deadmau5',
        genres: ['g_prog_house', 'g_midtempo'], // Bridge!
        basePlays: 2900,
        energy: 0.84,
        valence: 0.49,
        acoustic: 0.08,
        dance: 0.72,
        bpm: 128,
        followers: '4.8M'
      }
    ],
    tracks: [
      { id: 't_desire', name: 'Desire', artistId: 'a_sub_focus', basePlays: 1250, bpm: 174, valence: 0.70, energy: 0.94, acoustic: 0.03, dance: 0.60, durationMin: 3.5 },
      { id: 't_solar_system', name: 'Solar System', artistId: 'a_sub_focus', basePlays: 1100, bpm: 174, valence: 0.62, energy: 0.96, acoustic: 0.02, dance: 0.56, durationMin: 4.8 },
      { id: 't_edge', name: 'Edge', artistId: 'a_rezz', basePlays: 940, bpm: 100, valence: 0.32, energy: 0.91, acoustic: 0.02, dance: 0.65, durationMin: 3.4 },
      { id: 't_witching_hour', name: 'Witching Hour', artistId: 'a_rezz', basePlays: 780, bpm: 100, valence: 0.29, energy: 0.88, acoustic: 0.03, dance: 0.62, durationMin: 3.2 },
      { id: 't_machine_gun', name: 'Machine Gun', artistId: 'a_noisia', basePlays: 870, bpm: 172, valence: 0.25, energy: 0.98, acoustic: 0.01, dance: 0.48, durationMin: 4.1 },
      { id: 't_opus', name: 'Opus', artistId: 'a_eric_prydz', basePlays: 1320, bpm: 126, valence: 0.61, energy: 0.88, acoustic: 0.05, dance: 0.66, durationMin: 9.0 },
      { id: 't_strobe', name: 'Strobe', artistId: 'a_deadmau5', basePlays: 1490, bpm: 128, valence: 0.52, energy: 0.82, acoustic: 0.09, dance: 0.70, durationMin: 10.3 }
    ]
  }
};
