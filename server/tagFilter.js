// server/tagFilter.js
/**
 * Community tags (MusicBrainz, Last.fm) mix genres with noise: "seen live",
 * "favorites", decades, the artist's own name. This keeps the musical ones.
 */

const JUNK_TAG = /youtubers?|^youtube$|retard|artist credit|seen live|favou?rites?|spotify|wikidata|discogs|^[a-z]{1,2}$|\d{2,4}s?\b|vocalists?|^love|awesome|beautiful|amazing|best|my |under \d|listeners|albums? i own|check out|^all$|^good$|^cool$|^sexy$|^chill$|christmas|holiday|xmas/i;

/** True for community tags that aren't music genres (also applied to cached tags). */
export const isJunkTag = (tag) => JUNK_TAG.test(String(tag));

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * @param {Array<{name: string, count: number}>} tags  community tags with weights
 * @param {string} artistName
 * @param {{ max?: number, minCount?: number }} opts
 */
export function usefulTags(tags, artistName, { max = 5, minCount = 1 } = {}) {
  const name = squash(artistName || '');
  return (tags || [])
    .filter(t => t && t.name && t.count >= minCount && !JUNK_TAG.test(t.name))
    // Tags that are just the artist's own name (often misspelled).
    .filter(t => {
      const tag = squash(t.name);
      if (!tag || !name) return Boolean(tag);
      return !(tag.length > 3 && (name.includes(tag) || tag.includes(name) || tag.slice(0, 5) === name.slice(0, 5)));
    })
    .sort((x, y) => y.count - x.count)
    .slice(0, max)
    .map(t => t.name);
}
