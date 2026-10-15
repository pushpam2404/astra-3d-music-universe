// server/enrich.js
/**
 * Artist metadata lookups shared by /api/universe (a first batch on load) and
 * /api/enrich (the rest, in the background while the page is open).
 *
 * For each artist: Wikidata (genres, country, occupation) and MusicBrainz (country,
 * tags) by exact Spotify id, plus Last.fm tags (via the artist's most-played song,
 * which tells same-name artists apart). The browser stores the results and sends them
 * back as `knownMeta`, so nothing needs a database.
 */
import { normalizeGenre, OCCUPATION_GENRES } from '../src/config/genreTaxonomy.js';
import { fetchWikidataArtistMeta } from './genreEnrichment.js';
import { fetchMusicBrainzArtistMeta } from './musicbrainz.js';
import { fetchLastfmTags, isLastfmConfigured } from './lastfm.js';
import { tagsContradictCountry } from './places.js';

// Bump when the Last.fm lookup method changes, so browsers re-check their cached artists.
export const LASTFM_METHOD_VERSION = 3;
// Same cap for fresh and remembered genres, so a cached load clusters identically.
export const MAX_GENRES_PER_ARTIST = 16;
// Client-cached metadata is trusted this long; "nothing found" is rechecked sooner.
const KNOWN_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KNOWN_EMPTY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the browser's cached entry can be used as-is. */
export function isFreshMeta(m) {
  return Boolean(m && Array.isArray(m.g)
    // Entries learned with an older Last.fm method (or before it was configured) are re-checked.
    && !(isLastfmConfigured() && !(Number(m.l) >= LASTFM_METHOD_VERSION))
    && Date.now() - (Number(m.t) || 0) < (m.g.length ? KNOWN_META_TTL_MS : KNOWN_EMPTY_TTL_MS));
}

/** knownMeta comes from the browser: keep only well-formed strings. */
export const cleanList = (list, max) => (Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.length < 60).slice(0, max) : []);

/**
 * Looks up the given artists (in priority order) within budgetMs.
 * @param {Array<{id, name, track?}>} artists
 * @returns {{ meta: Map<id, {g, c}>, done: Set<id>, warnings: string[], stats: object }}
 *   `done` = artists whose lookup is complete (safe for the browser to remember).
 */
export async function enrichArtists(artists, budgetMs) {
  const warnings = [];
  const ids = artists.map(a => a.id);
  const noMeta = { metaById: new Map() };
  const [wd, mb, lf] = ids.length
    ? await Promise.all([
      fetchWikidataArtistMeta(ids),
      fetchMusicBrainzArtistMeta(ids),
      fetchLastfmTags(artists, budgetMs)
    ])
    : [noMeta, noMeta, { tagsById: new Map(), viaById: new Map(), looked: 0, viaTrack: 0, skipped: 0 }];
  if (wd.error) warnings.push(`Wikidata lookup failed (${wd.error}).`);
  if (mb.error) warnings.push(`MusicBrainz lookup failed (${mb.error}).`);
  if (lf.error) warnings.push(`${lf.error}; the rest will be looked up later.`);

  const lastfmOn = isLastfmConfigured();
  const meta = new Map();
  const done = new Set();
  let rejectedSameName = 0;
  artists.forEach(a => {
    const w = wd.metaById.get(a.id) || { genres: [], countries: [], occupations: [] };
    const m = mb.metaById.get(a.id) || { country: null, area: null, tags: [] };
    const countries = m.country ? [m.country] : (w.countries.length ? w.countries : (m.area ? [m.area] : []));
    let lfTags = lf.tagsById.get(a.id) || [];
    // An artist page tagged with another country belongs to a same-name artist.
    if (lf.viaById.get(a.id) === 'artist' && tagsContradictCountry(lfTags, countries)) {
      lfTags = [];
      rejectedSameName++;
    }
    const raw = [...w.genres, ...lfTags, ...(w.genres.length || lfTags.length ? [] : m.tags)];
    const implied = w.occupations.map(o => OCCUPATION_GENRES[o.toLowerCase()]).filter(Boolean);
    const genres = [...new Set([...raw, ...implied].map(normalizeGenre))].slice(0, MAX_GENRES_PER_ARTIST);
    meta.set(a.id, { g: genres, c: countries });
    // Complete unless Last.fm still owes us a lookup for this artist.
    if (!(lastfmOn && !lf.tagsById.has(a.id))) done.add(a.id);
  });

  return {
    meta,
    done,
    warnings,
    stats: lastfmOn ? { looked: lf.looked, viaTrack: lf.viaTrack, pending: lf.skipped, rejectedSameName } : 'LASTFM_API_KEY not set'
  };
}

/** Browser cache entry for a finished lookup. */
export const toCacheEntry = ({ g, c }) => ({ g, c, t: Date.now(), ...(isLastfmConfigured() ? { l: LASTFM_METHOD_VERSION } : {}) });
