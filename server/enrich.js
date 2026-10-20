// server/enrich.js
/**
 * Artist metadata lookups shared by /api/universe (a first batch on load) and
 * /api/enrich (the rest, in the background while the page is open).
 *
 * For each artist: Wikidata (genres, country, occupation) and MusicBrainz (country,
 * tags) by exact Spotify id, plus Last.fm tags (via the artist's most-played song,
 * which tells same-name artists apart). The browser stores the results and sends them
 * back as `knownMeta`, so nothing needs a database and no artists are hardcoded.
 */
import { normalizeGenre, OCCUPATION_GENRES } from '../src/config/genreTaxonomy.js';
import { fetchWikidataArtistMeta } from './genreEnrichment.js';
import { fetchMusicBrainzArtistMeta } from './musicbrainz.js';
import { fetchLastfmTags, isLastfmConfigured } from './lastfm.js';
import { tagsContradictCountry, isPurePlaceTag, tagToCountry } from './places.js';

// Bump when the Last.fm lookup method changes, so browsers re-check their cached artists.
export const LASTFM_METHOD_VERSION = 4;
// Same cap for fresh and remembered genres, so a cached load clusters identically.
export const MAX_GENRES_PER_ARTIST = 16;
// Client-cached metadata is trusted this long; "nothing found" is rechecked sooner.
const KNOWN_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KNOWN_EMPTY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the browser's cached entry can be used as-is. */
export function isFreshMeta(m) {
  if (!m || !Array.isArray(m.g)) return false;
  const age = Date.now() - (Number(m.t) || 0);
  const ttl = m.g.length ? KNOWN_META_TTL_MS : KNOWN_EMPTY_TTL_MS;
  if (age >= ttl) return false;
  // If entry already has known genres, it is valid and fresh!
  if (m.g.length > 0) return true;
  // If empty and Last.fm is configured, ensure it was checked with a supported Last.fm version
  if (isLastfmConfigured() && Number(m.l || 0) < 3) return false;
  return true;
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
  // Only query Wikidata and MusicBrainz for real 22-char Spotify artist IDs;
  // Last.fm looks up by artist name + signature track so it works for all artists.
  const spotifyIds = artists.map(a => a.id).filter(id => /^[0-9A-Za-z]{22}$/.test(id));
  const noMeta = { metaById: new Map() };
  const [wd, mb, lf] = artists.length
    ? await Promise.all([
      spotifyIds.length ? fetchWikidataArtistMeta(spotifyIds) : noMeta,
      spotifyIds.length ? fetchMusicBrainzArtistMeta(spotifyIds) : noMeta,
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
    const activeCountries = [...countries];
    const candidateTags = [...w.genres, ...lfTags, ...(w.genres.length || lfTags.length ? [] : m.tags)];
    const musicalTags = [];
    candidateTags.forEach(t => {
      if (isPurePlaceTag(t)) {
        if (!activeCountries.length) {
          const inferred = tagToCountry(t);
          if (inferred && !activeCountries.includes(inferred)) activeCountries.push(inferred);
        }
      } else {
        musicalTags.push(t);
      }
    });
    const implied = w.occupations.map(o => OCCUPATION_GENRES[o.toLowerCase()]).filter(Boolean);
    const genres = [...new Set([...musicalTags, ...implied].map(normalizeGenre))].slice(0, MAX_GENRES_PER_ARTIST);
    meta.set(a.id, { g: genres, c: activeCountries });
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
