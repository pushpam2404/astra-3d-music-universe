// server/places.js
/**
 * Place knowledge for Last.fm disambiguation, from the runtime's own Intl country names
 * (no lists of our own): a tag that is a country name is a home country, not a genre,
 * and an artist page tagged with a different country describes a same-name artist.
 */
import { countryNames, squashTag } from '../src/etl/genreSignals.js';

/** "India" → "India"; "united states" → "United States"; anything else → null. */
export function tagToCountry(tag) {
  return countryNames().get(squashTag(tag)) || null;
}

export const isPurePlaceTag = (tag) => tagToCountry(tag) !== null;

/**
 * True when the tags name countries and none of them is a country we know for the
 * artist, i.e. the tags most likely describe a different artist with the same name.
 */
export function tagsContradictCountry(tags, knownCountries) {
  const known = new Set((knownCountries || []).map(c => tagToCountry(c)).filter(Boolean));
  if (!known.size) return false;
  const tagged = (tags || []).map(tagToCountry).filter(Boolean);
  return tagged.length > 0 && tagged.every(c => !known.has(c));
}
