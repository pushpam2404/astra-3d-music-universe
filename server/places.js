// server/places.js
/**
 * Country ↔ demonym knowledge shared by cluster naming (never name a cluster after a
 * place) and Last.fm disambiguation (a page tagged "british" isn't the Indian "King").
 */

export const DEMONYMS = {
  India: 'Indian', Pakistan: 'Pakistani', Bangladesh: 'Bangladeshi', Nepal: 'Nepali', 'Sri Lanka': 'Sri Lankan',
  'United States': 'American', 'United States of America': 'American', 'United Kingdom': 'British', England: 'English',
  Canada: 'Canadian', Australia: 'Australian', 'New Zealand': 'Kiwi', Ireland: 'Irish', Scotland: 'Scottish',
  'South Korea': 'Korean', Japan: 'Japanese', China: 'Chinese', Taiwan: 'Taiwanese', Indonesia: 'Indonesian',
  Philippines: 'Filipino', Thailand: 'Thai', Vietnam: 'Vietnamese', France: 'French', Germany: 'German',
  Italy: 'Italian', Spain: 'Spanish', Portugal: 'Portuguese', Netherlands: 'Dutch', Belgium: 'Belgian',
  Sweden: 'Swedish', Norway: 'Norwegian', Denmark: 'Danish', Finland: 'Finnish', Iceland: 'Icelandic',
  Poland: 'Polish', Russia: 'Russian', Ukraine: 'Ukrainian', Turkey: 'Turkish', Greece: 'Greek', Israel: 'Israeli',
  Iran: 'Iranian', Egypt: 'Egyptian', Nigeria: 'Nigerian', Ghana: 'Ghanaian', 'South Africa': 'South African',
  Brazil: 'Brazilian', Mexico: 'Mexican', Argentina: 'Argentine', Colombia: 'Colombian', Chile: 'Chilean',
  'Puerto Rico': 'Puerto Rican', Jamaica: 'Jamaican', Cuba: 'Cuban', Punjab: 'Punjab', Karachi: 'Karachi',
  Lahore: 'Lahori', Mumbai: 'Mumbai'
};

// Tags that say where, not what.
export const PLACE_TAGS = new Set([
  ...Object.keys(DEMONYMS), ...Object.values(DEMONYMS),
  'uk', 'usa', 'us', 'america', 'desi', 'south asian', 'asian', 'european', 'latino', 'african'
].map(t => t.toLowerCase()));

// Equivalent country spellings across sources (MusicBrainz, Wikidata, tags).
const COUNTRY_GROUPS = [
  ['United Kingdom', 'England', 'Scotland', 'Wales', 'English people', 'uk', 'british', 'english', 'scottish', 'welsh'],
  ['United States', 'United States of America', 'usa', 'us', 'america', 'american'],
  ['India', 'British India', 'indian', 'mumbai', 'punjab'],
  ['Pakistan', 'pakistani', 'karachi', 'lahore', 'lahori']
];
const groupOf = new Map();
COUNTRY_GROUPS.forEach((group, i) => group.forEach(name => groupOf.set(name.toLowerCase(), i)));
Object.entries(DEMONYMS).forEach(([country, demonym]) => {
  const key = groupOf.get(country.toLowerCase()) ?? `c:${country.toLowerCase()}`;
  groupOf.set(country.toLowerCase(), key);
  if (!groupOf.has(demonym.toLowerCase())) groupOf.set(demonym.toLowerCase(), key);
});

/**
 * True when tags name a place that contradicts every country we know for the artist,
 * i.e. the tags most likely describe a different artist with the same name.
 */
export function tagsContradictCountry(tags, knownCountries) {
  if (!knownCountries?.length) return false;
  const known = new Set(knownCountries.map(c => groupOf.get(c.toLowerCase())).filter(k => k !== undefined));
  if (!known.size) return false;
  const tagged = tags.map(t => groupOf.get(t.toLowerCase())).filter(k => k !== undefined);
  return tagged.length > 0 && tagged.every(k => !known.has(k));
}
