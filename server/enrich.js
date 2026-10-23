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
import { normalizeGenre } from '../src/config/genreTaxonomy.js';
import { fetchWikidataArtistMeta } from './genreEnrichment.js';
import { fetchMusicBrainzArtistMeta, searchMusicBrainzByTrack } from './musicbrainz.js';
import { fetchLastfmTags, isLastfmConfigured, lastfmArtistMbid } from './lastfm.js';
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

/**
 * Looks up the given artists (in priority order) within budgetMs.
 * @param {Array<{id, name, track?}>} artists
 * @returns {{ meta: Map<id, {g, c}>, done: Set<id>, warnings: string[], stats: object }}
 *   `done` = artists whose lookup is complete (safe for the browser to remember).
 */
export async function enrichArtists(artists, budgetMs) {
  const started = Date.now();
  const warnings = [];
  // Only query Wikidata and MusicBrainz for real 22-char Spotify artist IDs;
  // Last.fm looks up by artist name + signature track so it works for all artists.
  const spotifyIds = artists.map(a => a.id).filter(id => /^[0-9A-Za-z]{22}$/.test(id));
  const noMeta = { metaById: new Map() };
  const [wd, mb, lf] = artists.length
    ? await Promise.all([
      spotifyIds.length ? fetchWikidataArtistMeta(spotifyIds) : noMeta,
      spotifyIds.length ? fetchMusicBrainzArtistMeta(spotifyIds) : noMeta,
      // Last.fm gets 60% of the budget; the rest is kept for the MusicBrainz song search below.
      fetchLastfmTags(artists, Math.round(budgetMs * 0.6))
    ])
    : [noMeta, noMeta, { tagsById: new Map(), viaById: new Map(), looked: 0, viaTrack: 0, skipped: 0 }];
  if (wd.error) warnings.push(`Wikidata lookup failed (${wd.error}).`);
  if (mb.error) warnings.push(`MusicBrainz lookup failed (${mb.error}).`);
  if (lf.error) warnings.push(`${lf.error}; the rest will be looked up later.`);

  // History-only artists (no Spotify id) whose Last.fm tags are missing or came from the shared artist page (Last.fm merges same-name artists there): find
  // them on MusicBrainz through one of their songs, for their own tags and country.
  const weak = artists.filter(a => !/^[0-9A-Za-z]{22}$/.test(a.id) && a.track &&
    (!(lf.tagsById.get(a.id) || []).length || lf.viaById.get(a.id) === 'artist'));
  const byTrack = weak.length
    ? await searchMusicBrainzByTrack(weak, Math.max(0, budgetMs - (Date.now() - started)))
    : { metaById: new Map(), looked: 0 };
  if (byTrack.error) warnings.push(byTrack.error);

  // Which artist is the Last.fm page actually about? If it links a different MusicBrainz
  // artist than the one found through the song, its tags belong to a namesake.
  const namesakePage = new Set();
  await Promise.all([...byTrack.metaById].map(async ([id, m]) => {
    if (lf.viaById.get(id) !== 'artist' || !(lf.tagsById.get(id) || []).length) return;
    const pageMbid = await lastfmArtistMbid(artists.find(a => a.id === id).name);
    if (pageMbid && pageMbid !== m.mbid) namesakePage.add(id);
  }));

  const lastfmOn = isLastfmConfigured();
  const meta = new Map();
  const done = new Set();
  let rejectedSameName = 0;
  artists.forEach(a => {
    const w = wd.metaById.get(a.id) || { genres: [], countries: [], occupations: [] };
    const m = mb.metaById.get(a.id) || byTrack.metaById.get(a.id) || { country: null, area: null, tags: [] };
    const matchedBySong = byTrack.metaById.has(a.id);
    const countries = m.country ? [m.country] : (w.countries.length ? w.countries : (m.area ? [m.area] : []));
    let lfTags = lf.tagsById.get(a.id) || [];
    // Found through their own song with real tags: the shared artist page isn't needed.
    if (matchedBySong && m.tags.length && lf.viaById.get(a.id) === 'artist') lfTags = [];
    if (namesakePage.has(a.id) && lfTags.length) {
      lfTags = [];
      rejectedSameName++;
    }
    // An artist page tagged with another country belongs to a same-name artist.
    if (lf.viaById.get(a.id) === 'artist' && tagsContradictCountry(lfTags, countries)) {
      lfTags = [];
      rejectedSameName++;
    }
    const activeCountries = [...countries];
    // Tags found through the artist's own song are about this exact artist: always use them.
    const candidateTags = [...w.genres, ...lfTags, ...(matchedBySong || !(w.genres.length || lfTags.length) ? m.tags : [])];
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
    // Occupations ("playback singer") go along as plain tags; the genre selection in
    // src/etl/genreSignals.js decides from data whether they say anything about sound.
    const genres = [...new Set([...musicalTags, ...w.occupations].map(normalizeGenre))].slice(0, MAX_GENRES_PER_ARTIST);
    // u: the genres rest only on Last.fm's shared artist page (no Wikidata genres, no
    // match through the artist's own song), so they may describe a same-name artist.
    const unverified = lf.viaById.get(a.id) === 'artist' && lfTags.length > 0 && !w.genres.length && !matchedBySong;
    meta.set(a.id, { g: genres, c: activeCountries, ...(unverified ? { u: 1 } : {}) });
    // Complete unless Last.fm still owes us a lookup for this artist.
    if (!(lastfmOn && !lf.tagsById.has(a.id))) done.add(a.id);
  });

  return {
    meta,
    done,
    warnings,
    stats: lastfmOn ? { looked: lf.looked, viaTrack: lf.viaTrack, pending: lf.skipped, rejectedSameName, musicBrainzBySong: byTrack.metaById.size } : 'LASTFM_API_KEY not set'
  };
}

/** Browser cache entry for a finished lookup. */
export const toCacheEntry = ({ g, c, u }) => ({ g, c, t: Date.now(), ...(u ? { u } : {}), ...(isLastfmConfigured() ? { l: LASTFM_METHOD_VERSION } : {}) });
