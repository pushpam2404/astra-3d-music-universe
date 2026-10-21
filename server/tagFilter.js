// server/tagFilter.js
/**
 * Community tags (MusicBrainz, Last.fm) as fetched: drops only tags that are the
 * artist's own name. Whether a tag is a genre at all is decided later, from data, in
 * src/etl/genreSignals.js (curated catalogue, languages, places, coherence).
 */

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * @param {Array<{name: string, count: number}>} tags  community tags with weights
 * @param {string} artistName
 * @param {{ max?: number, minCount?: number }} opts
 */
export function usefulTags(tags, artistName, { max = 10, minCount = 1 } = {}) {
  const name = squash(artistName || '');
  return (tags || [])
    .filter(t => t && t.name && t.count >= minCount)
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
