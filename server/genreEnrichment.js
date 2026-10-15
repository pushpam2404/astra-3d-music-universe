// server/genreEnrichment.js
/**
 * Spotify stopped returning artist genres for Development Mode apps, so artist metadata
 * comes from Wikidata instead: one SPARQL query matches artists by their exact Spotify
 * artist ID (property P1902) and returns genres (P136), country (P27 citizenship /
 * P495 country of origin) and occupations (P106). No API key needed.
 */

const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'ASTRA-music-universe/1.0 (https://astra-3d-music-universe.vercel.app)';
const TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// spotifyId → { meta: { genres, countries, occupations }, fetchedAt }. Misses are cached too.
const cache = new Map();

// Each property is its own small query: OPTIONAL-joining all three in one query
// multiplies the rows and times out.
const PROPERTIES = {
  genres: 'wdt:P136',
  countries: 'wdt:P27|wdt:P495',
  occupations: 'wdt:P106'
};

function buildQuery(spotifyIds, path) {
  return `SELECT ?sid (GROUP_CONCAT(DISTINCT ?label; separator="|") AS ?values) WHERE {
  VALUES ?sid { ${spotifyIds.map(id => `"${id}"`).join(' ')} }
  ?item wdt:P1902 ?sid .
  ?item ${path} ?value .
  ?value rdfs:label ?label .
  FILTER(LANG(?label) = "en")
} GROUP BY ?sid`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sparql(query, signal, attempt = 0) {
  const res = await fetch(WIKIDATA_SPARQL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ query }),
    signal
  });
  if (res.status === 429 && attempt === 0) {
    await sleep(Math.min(Number(res.headers.get('Retry-After')) || 2, 3) * 1000);
    return sparql(query, signal, attempt + 1);
  }
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return (await res.json()).results.bindings;
}

async function queryWikidata(spotifyIds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const out = new Map();
    // Sequential: Wikidata throttles concurrent queries from one IP.
    for (const [field, path] of Object.entries(PROPERTIES)) {
      const rows = await sparql(buildQuery(spotifyIds, path), controller.signal);
      rows.forEach(row => {
        const sid = row.sid.value;
        if (!out.has(sid)) out.set(sid, { genres: [], countries: [], occupations: [] });
        out.get(sid)[field] = row.values.value.split('|').filter(Boolean);
      });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

const EMPTY_META = { genres: [], countries: [], occupations: [] };

/**
 * Resolves Wikidata metadata for the given Spotify artist ids.
 * Returns { metaById: Map<id, { genres, countries, occupations }>, error?: string }. Never throws.
 */
export async function fetchWikidataArtistMeta(spotifyIds) {
  const metaById = new Map();
  const now = Date.now();
  const missing = [];

  spotifyIds.forEach(id => {
    const hit = cache.get(id);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) metaById.set(id, hit.meta);
    else missing.push(id);
  });

  if (missing.length === 0) return { metaById };

  try {
    const found = await queryWikidata(missing);
    missing.forEach(id => {
      const meta = found.get(id) || EMPTY_META;
      cache.set(id, { meta, fetchedAt: now });
      metaById.set(id, meta);
    });
    return { metaById };
  } catch (err) {
    return { metaById, error: err.name === 'AbortError' ? 'Wikidata timed out' : err.message };
  }
}
