// src/api/artistMetaCache.js
/**
 * Remembers artist genres/countries the backend has already looked up, so each load
 * only asks Wikidata/MusicBrainz/Last.fm about artists it hasn't seen. This is the
 * app's only persistent cache; it lives in this browser, so no database is needed.
 * Entry shape: { g: string[] genres, c: string[] countries, t: lookup time (ms) }.
 */

const STORAGE_KEY = 'astra_artist_meta_v1';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function loadArtistMeta() {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const now = Date.now();
    Object.keys(all).forEach(id => {
      if (now - (all[id]?.t || 0) > MAX_AGE_MS) delete all[id];
    });
    return all;
  } catch {
    return {};
  }
}

export function saveArtistMeta(newEntries) {
  if (!newEntries || !Object.keys(newEntries).length) return;
  try {
    const all = { ...loadArtistMeta(), ...newEntries };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked (private mode): lookups just run again next time.
  }
}
