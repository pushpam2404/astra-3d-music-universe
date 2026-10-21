// src/etl/genreSignals.js
/**
 * Which community tags are genres, decided from data rather than hand-made lists.
 * Runs in the browser and in Node.
 *
 *   1. Catalogue: a tag Wikidata or MusicBrainz lists as a music genre (or an alias of
 *      one) is a genre, under its canonical name ("kpop" → "k-pop").
 *   2. Places: a tag that is a country name (from the runtime's own Intl region names)
 *      is a home country, not a genre.
 *   3. Languages: a tag that is a language name (Intl language names: "tamil",
 *      "punjabi", "haryanvi") is a music scene in its own right and can name a cluster.
 *   4. Coherence: any other tag counts only if it behaves like a genre in this library:
 *      the artists carrying it sound alike (their catalogue genres overlap far more than
 *      two random artists' do). "hindi" or "sufi" pass; "female vocalists", "seen live"
 *      or "cover" sit on everything and fail. This is the topic-model idea of dropping
 *      words that carry no topic. Coherent tags help group artists but never name a
 *      cluster: names come only from the catalogue and language names.
 */

/** Comparable key: "Synth-Pop" = "synthpop" = "synth pop music"; "R&B" = "rnb". */
export const squashTag = (t) => String(t || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/\s+music$/, '')
  .replace(/&/g, 'n')
  .replace(/[^a-z0-9]/g, '');

let countryIndex = null;
/** squashed country name → English country name, from Intl (no list of our own). */
export function countryNames() {
  if (countryIndex) return countryIndex;
  countryIndex = new Map();
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const A = 65;
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        const code = String.fromCharCode(A + i, A + j);
        const name = names.of(code);
        if (name && name !== code && !/unknown/i.test(name)) countryIndex.set(squashTag(name), name);
      }
    }
  } catch { /* no Intl region data: no place detection */ }
  return countryIndex;
}

let languageIndex = null;
/** squashed language name → lower-case name, from Intl (ISO 639 two- and three-letter codes). */
export function languageNames() {
  if (languageIndex) return languageIndex;
  languageIndex = new Map();
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const add = (code) => {
      try {
        const name = names.of(code);
        if (name && name !== code) languageIndex.set(squashTag(name), name.toLowerCase());
      } catch { /* not a language code */ }
    };
    for (const a of letters) for (const b of letters) {
      add(a + b);
      for (const c of letters) add(a + b + c);
    }
  } catch { /* no Intl language data */ }
  return languageIndex;
}

// Coherence test parameters (statistics, not taste): a non-catalogue tag needs this many
// artists, and their mutual similarity must clear an absolute floor and be this many
// times the library's background similarity.
const COHERENCE_MIN_ARTISTS = 3;
const COHERENCE_MIN_SIMILARITY = 0.12;
const COHERENCE_LIFT = 2.5;
const SAMPLE_PAIRS = 300;

function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * @param {Map<string, string[]>} rawTagsById  artist id → raw tags (any source)
 * @param {{ aliases: Record<string, string> } | null} vocabulary  from /api/genre-vocabulary
 * @returns {{ genresById: Map<string, string[]>, countriesById: Map<string, string[]>, accepted: Set<string>, nameable: Set<string> }}
 *   nameable: the accepted tags that may name a cluster (catalogue genres and languages)
 *   genres in canonical lower-case form, de-duplicated, in the artist's original order
 */
export function selectGenreTags(rawTagsById, vocabulary) {
  const aliases = vocabulary?.aliases || {};
  const countries = countryNames();
  const languages = languageNames();
  const genresById = new Map();
  const countriesById = new Map();
  const candidates = new Map(); // squashed non-catalogue tag → { name, ids }
  const spellingsOf = new Map(); // canonical genre → Map(spelling used in tags → count)

  rawTagsById.forEach((tags, id) => {
    const genres = [];
    const places = [];
    (tags || []).forEach(raw => {
      const key = squashTag(raw);
      if (!key) return;
      if (countries.has(key)) { places.push(countries.get(key)); return; }
      if (aliases[key]) {
        genres.push(aliases[key]);
        const spellings = spellingsOf.get(aliases[key]) || spellingsOf.set(aliases[key], new Map()).get(aliases[key]);
        const shown = String(raw).toLowerCase().trim();
        spellings.set(shown, (spellings.get(shown) || 0) + 1);
        return;
      }
      if (languages.has(key)) { genres.push(languages.get(key)); return; }
      // Catalogue unreachable: keep every non-place tag rather than lose all genres.
      if (!vocabulary) { genres.push(String(raw).toLowerCase().trim()); return; }
      if (!candidates.has(key)) candidates.set(key, { name: String(raw).toLowerCase().trim(), ids: [] });
      candidates.get(key).ids.push(id);
    });
    genresById.set(id, [...new Set(genres)]);
    countriesById.set(id, [...new Set(places)]);
  });

  // Catalogue-genre vectors (idf-weighted, unit length) for the coherence test.
  const df = new Map();
  genresById.forEach(gs => gs.forEach(g => df.set(g, (df.get(g) || 0) + 1)));
  const n = Math.max(1, genresById.size);
  const vec = new Map();
  genresById.forEach((gs, id) => {
    if (!gs.length) return;
    const v = new Map(gs.map(g => [g, Math.log(1 + n / df.get(g))]));
    const norm = Math.hypot(...v.values()) || 1;
    v.forEach((w, g) => v.set(g, w / norm));
    vec.set(id, v);
  });
  const cos = (a, b) => {
    let s = 0;
    a.forEach((w, g) => { const x = b.get(g); if (x) s += w * x; });
    return s;
  };
  const meanPairSimilarity = (ids, random) => {
    const usable = ids.filter(id => vec.has(id));
    if (usable.length < 2) return null;
    let sum = 0, count = 0;
    const exhaustive = usable.length * (usable.length - 1) / 2 <= SAMPLE_PAIRS;
    if (exhaustive) {
      for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) { sum += cos(vec.get(usable[i]), vec.get(usable[j])); count++; }
    } else {
      for (let k = 0; k < SAMPLE_PAIRS; k++) {
        const a = usable[Math.floor(random() * usable.length)], b = usable[Math.floor(random() * usable.length)];
        if (a === b) continue;
        sum += cos(vec.get(a), vec.get(b));
        count++;
      }
    }
    return count ? sum / count : null;
  };
  const random = seededRandom(12345);
  const background = meanPairSimilarity([...vec.keys()], random) ?? 0;

  const accepted = new Set();
  genresById.forEach(gs => gs.forEach(g => accepted.add(g)));
  const nameable = new Set(accepted);
  candidates.forEach(({ name, ids }) => {
    if (ids.length < COHERENCE_MIN_ARTISTS) return;
    const within = meanPairSimilarity(ids, random);
    if (within === null || within < COHERENCE_MIN_SIMILARITY || within < background * COHERENCE_LIFT) return;
    accepted.add(name);
    ids.forEach(id => {
      const gs = genresById.get(id);
      if (!gs.includes(name)) gs.push(name);
    });
  });
  // Show each catalogue genre the way this listener's tags most often spell it
  // ("rap", not Wikidata's "rapping"; "afropop", not "african popular").
  const display = new Map();
  spellingsOf.forEach((spellings, canonical) => {
    const used = [...spellings].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
    // Same words, different punctuation ("lo fi" / "lo-fi"): keep the catalogue's spelling.
    display.set(canonical, squashTag(used) === squashTag(canonical) ? canonical : used);
  });
  const rename = (g) => display.get(g) || g;
  genresById.forEach((gs, id) => genresById.set(id, [...new Set(gs.map(rename))]));
  return {
    genresById,
    countriesById,
    accepted: new Set([...accepted].map(rename)),
    nameable: new Set([...nameable].map(rename))
  };
}
