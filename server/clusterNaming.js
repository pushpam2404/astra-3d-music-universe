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

    // 1. Compute cluster audio features for sonic mood profiling
    let avgEnergy = 0, avgValence = 0, avgDance = 0, avgAcoustic = 0, countWithAudio = 0;
    members.forEach(id => {
      const a = byId.get(id);
      if (a && a.energy !== undefined && a.energy !== null) {
        avgEnergy += a.energy;
        avgValence += a.valence;
        avgDance += a.dance;
        avgAcoustic += a.acoustic;
        countWithAudio++;
      }
    });
    if (countWithAudio > 0) {
      avgEnergy /= countWithAudio;
      avgValence /= countWithAudio;
      avgDance /= countWithAudio;
      avgAcoustic /= countWithAudio;
    }

    // 2. Identify top genre families
    const sortedFams = Object.entries(famScore).sort((x, y) => y[1] - x[1]);
    const primaryFamId = sortedFams[0]?.[0];
    const secondaryFamId = sortedFams[1]?.[0];
    const primaryFam = primaryFamId ? familyInfo(primaryFamId) : OTHER_FAMILY;
    const secondaryFam = secondaryFamId ? familyInfo(secondaryFamId) : null;

    // Distinctive genres: consensus support × log-lift over genre-known members in the cluster.
    // In small clusters (<= 5 artists), 1 artist is acceptable if no consensus exists;
    // in medium/large clusters (> 5 artists), require at least 2 artists and >= 10% support
    // so an outlier tag (like 1 Bhojpuri play in a 200-artist Hindi cluster) never hijacks the name.
    const minSupport = genreRichSize <= 5 ? 1 : Math.max(2, Math.ceil(genreRichSize * 0.10));
    const ranked = [...genreCount.entries()]
      .filter(([g, c]) => c >= minSupport && !PLACE_TAGS.has(g))
      .map(([g, c]) => {
        const support = c / genreRichSize;
        const lift = support / ((genreDf.get(g) || 1) / genreKnownN);
        const clampedLift = Math.min(14, lift);
        return { g, c, support, score: Math.pow(support, 1.35) * Math.log(1 + clampedLift) * (BROAD_GENRES.has(g) ? 0.55 : 1) };
      })
      .sort((x, y) => y.score - x.score || x.g.localeCompare(y.g));

    // A home country names the cluster only where it is concentrated.
    const [topCountry, topCountryCount] = [...countryCount.entries()].sort((x, y) => y[1] - x[1])[0] || [];
    const share = topCountry ? topCountryCount / countryRichSize : 0;
    const globalShare = topCountry ? (countryDf.get(topCountry) || 1) / countryKnownN : 1;
    const demonym = topCountry && share >= 0.50 && share >= 1.25 * globalShare ? (DEMONYMS[topCountry] || null) : null;

    const topArtists = members.slice().sort((x, y) => scoreOf(y) - scoreOf(x)).slice(0, 3).map(id => byId.get(id).name);

    // Dynamic candidates — strictly authentic musical genres, regions, or sonic descriptors.
    // NEVER artist names ("Artist & Co.")!
    const candidates = [];

    // Level A: Fine-grained distinctive genres and dual-genre pairs
    // Only use fine-grained tags for primary title if the top tag has meaningful support:
    // at least 3 artists (for clusters with >= 10 members) and >= 15% support among genre-known artists.
    const isGenreRepresentative = ranked.length > 0 && (
      (members.length < 10 && ranked[0].support >= 0.25) ||
      (ranked[0].c >= 3 && ranked[0].support >= 0.15)
    );
    if (isGenreRepresentative) {
      for (let i = 0; i < Math.min(5, ranked.length); i++) {
        const g1 = titleCase(ranked[i].g);
        const withHome = demonym && !PLACE_WORDS.test(ranked[i].g) ? `${demonym} ${g1}` : null;
        for (let j = i + 1; j < Math.min(5, ranked.length); j++) {
          if (!overlaps(ranked[i].g, ranked[j].g)) {
            const g2 = titleCase(ranked[j].g);
            const joined = joinGenres(g1, g2);
            if (withHome && withHome.length <= 18) {
              const joinedHome = joinGenres(withHome, g2);
              if (joinedHome.length <= MAX_NAME_LENGTH) candidates.push(joinedHome);
            }
            if (joined.length <= MAX_NAME_LENGTH) candidates.push(joined);
          }
        }
        if (withHome && withHome.length <= MAX_NAME_LENGTH) candidates.push(withHome);
        if (g1.length <= MAX_NAME_LENGTH) candidates.push(g1);
      }
    }

    // Level B: Family crossovers (e.g. "Desi Hip-Hop", "Electropop", "Indie Pop & Rock")
    const famPairs = [];
    if (primaryFamId === 'southasian' && secondaryFamId === 'hiphop') famPairs.push('Desi Hip-Hop', 'South Asian Rap');
    else if (primaryFamId === 'hiphop' && secondaryFamId === 'southasian') famPairs.push('Desi Hip-Hop', 'Desi Rap');
    else if (primaryFamId === 'southasian' && secondaryFamId === 'pop') famPairs.push('Filmi & Pop', 'Desi Pop', 'Indian Pop');
    else if (primaryFamId === 'pop' && secondaryFamId === 'southasian') famPairs.push('Indian Pop', 'Desi Pop');
    else if (primaryFamId === 'electronic' && secondaryFamId === 'pop') famPairs.push('Electropop', 'Dance Pop');
    else if (primaryFamId === 'pop' && secondaryFamId === 'electronic') famPairs.push('Electropop', 'Dance Pop');
    else if (primaryFamId === 'rock' && secondaryFamId === 'pop') famPairs.push('Indie Pop & Rock', 'Pop Rock');
    else if (primaryFamId === 'rnb' && secondaryFamId === 'hiphop') famPairs.push('R&B & Hip-Hop', 'Melodic Rap');
    else if (primaryFamId === 'electronic' && secondaryFamId === 'hiphop') famPairs.push('Trap & Bass', 'Electronic Beats');
    else if (primaryFamId === 'folk' && secondaryFamId === 'rock') famPairs.push('Folk Rock', 'Acoustic Indie');
    else if (primaryFamId === 'rock' && secondaryFamId === 'metal') famPairs.push('Alternative Metal', 'Heavy Rock');
    candidates.push(...famPairs);

    // Level C: Demonym + Family label
    if (demonym) {
      const isRedundant = (primaryFam.id === 'southasian' && (demonym === 'Indian' || demonym === 'Pakistani')) ||
                          (primaryFam.id === 'asianpop' && (demonym === 'Korean' || demonym === 'Japanese'));
      const homeFam = isRedundant ? `${demonym} Pop` : `${demonym} ${primaryFam.label}`;
      if (homeFam.length <= MAX_NAME_LENGTH) candidates.push(homeFam);
      candidates.push(`${demonym} Sounds`, `${demonym} Scene`);
    }

    // Level D: Mood / Sonic Texture + Genre Family
    const moodDescriptors = [];
    if (avgAcoustic > 0.45) moodDescriptors.push('Acoustic', 'Unplugged');
    if (avgEnergy > 0.72) moodDescriptors.push('Energetic', 'Driving', 'Electric');
    else if (avgEnergy < 0.44) moodDescriptors.push('Atmospheric', 'Chill', 'Ambient', 'Downtempo');
    if (avgValence < 0.38) moodDescriptors.push('Moody', 'Late Night', 'Melancholy');
    else if (avgValence > 0.65) moodDescriptors.push('Uplifting', 'Feel-Good', 'Vibrant');
    if (avgDance > 0.68) moodDescriptors.push('Rhythmic', 'Club', 'Groove');
    moodDescriptors.push('Melodic', 'Modern', 'Underground', 'Alternative', 'Deep');

    const baseGenreName = ranked[0]?.g ? titleCase(ranked[0].g) : primaryFam.label;
    for (const mood of moodDescriptors) {
      const moodCandidate = `${mood} ${baseGenreName}`;
      if (moodCandidate.length <= MAX_NAME_LENGTH) candidates.push(moodCandidate);
      if (secondaryFam) {
        const moodFam = `${mood} ${secondaryFam.label}`;
        if (moodFam.length <= MAX_NAME_LENGTH) candidates.push(moodFam);
      }
    }

    // Level E: Primary and Secondary Family combinations
    if (primaryFam.label && primaryFam.label !== 'Eclectic') {
      candidates.push(primaryFam.label);
      if (secondaryFam && secondaryFam.label !== 'Eclectic') {
        const joined = `${primaryFam.label} & ${secondaryFam.label}`;
        if (joined.length <= MAX_NAME_LENGTH) candidates.push(joined);
      }
    }

    // Level F: Sonic Universe Archetypes (last-resort fallbacks that never use artist names)
    candidates.push(
      `${primaryFam.label || 'Sonic'} Odyssey`,
      `${primaryFam.label || 'Melodic'} Realm`,
      `${primaryFam.label || 'Eclectic'} Fusion`,
      `${primaryFam.label || 'Global'} Wave`,
      `Atmospheric Frequencies`,
      `Resonant Soundscape`,
      `Harmonic Echoes`,
      `Celestial Beats`,
      `Midnight Frequency ${clusterIdx + 1}`
    );

    const name = candidates.find(c => c.length <= MAX_NAME_LENGTH && !usedNames.has(c.toLowerCase()))
      || candidates.find(c => !usedNames.has(c.toLowerCase()))
      || `${primaryFam.label || 'Genre'} Cluster ${clusterIdx + 1}`;
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
