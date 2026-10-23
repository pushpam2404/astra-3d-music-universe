// src/config/lenses.js
// Lens ids, labels and banner text. Memory lenses are fixed; era lenses come from
// the years actually present in the listening history.
import { nodeMatchesLens } from '../renderer/celestialFactory.js';

export const MEMORY_LENSES = [
  { id: 'past_fav', label: 'Past favorites', short: 'Past favs', desc: 'Past Favorites — songs & artists you played heavily in past eras but rarely recently.' },
  { id: 'dormant', label: 'Haven’t heard in a while', short: 'Dormant', desc: 'Dormant Gems — loved songs & artists you haven’t played in 4+ months.' },
  { id: 'current_rotation', label: 'Current rotation', short: 'Current', desc: 'Current Rotation — played in the last 60 days of your history, or in your current top charts.' },
  { id: 'all_time_staple', label: 'All-time staples', short: 'Staples', desc: 'All-Time Staples — played consistently across 3+ years.' }
];

const ERA_TAG = /^(era|early)_(\d{4})/;

function eraLens(id) {
  if (id === 'era_2020_2022') return { id, label: '2020–22', short: '2020–22', desc: '2020–2022 — your earliest recorded Spotify years.' };
  const [, kind, year] = id.match(ERA_TAG);
  return kind === 'early'
    ? { id, label: `Early ${year}`, short: `Early ${year}`, desc: `Early ${year} — songs and artists that peaked in Jan–Apr ${year}.` }
    : { id, label: year, short: year, desc: `${year} — songs and artists heavily played in ${year}.` };
}

// Newest first; a year's lens before its "Early" lens.
const eraOrder = (id) => Number(id.match(ERA_TAG)[2]) * 2 + (id.startsWith('era_') ? 1 : 0);

/** Lenses that match at least one of `nodes`: memory lenses first, then eras newest first. */
export function availableLenses(nodes) {
  const eraIds = new Set();
  for (const n of nodes) for (const t of n.history?.tags || []) if (ERA_TAG.test(t)) eraIds.add(t);
  return [
    ...MEMORY_LENSES.filter(l => nodes.some(n => nodeMatchesLens(n, l.id))),
    ...[...eraIds].sort((a, b) => eraOrder(b) - eraOrder(a)).map(eraLens)
  ];
}

export function lensDescription(id) {
  if (!id || id === 'all') return null;
  const memory = MEMORY_LENSES.find(l => l.id === id);
  if (memory) return memory.desc;
  if (id.startsWith('year_')) return `${id.slice(5)} — everything you played that year.`;
  return ERA_TAG.test(id) ? eraLens(id).desc : null;
}
