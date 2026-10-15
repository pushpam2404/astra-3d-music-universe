// server/lastfm.js
/**
 * Last.fm community tags (artist.getTopTags): the best genre coverage for independent
 * and regional artists that Wikidata/MusicBrainz don't describe. One request per
 * artist, so lookups run under a time budget, most-listened artists first; the
 * browser keeps what was learned (see artistMetaCache.js) so later loads only ask
 * about the rest.
 *
 * Looks artists up by name with autocorrect (or by MusicBrainz id when given).
 * Requires LASTFM_API_KEY; without it this is a no-op.
 */
import { usefulTags } from './tagFilter.js';

const API = 'https://ws.audioscrobbler.com/2.0/';
const CONCURRENCY = 8;
// ~20 requests/s during one load's burst (≤ ~26 s) averages under Last.fm's
// 5 requests/s over 5 minutes.
const MIN_INTERVAL_PER_WORKER_MS = 400;
const REQUEST_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Last.fm tag counts are relative weights (0–100); below this they're noise.
const MIN_TAG_WEIGHT = 8;

const cache = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function isLastfmConfigured() {
  return Boolean(process.env.LASTFM_API_KEY);
}

async function topTags({ name, mbid }) {
  const params = new URLSearchParams({ method: 'artist.gettoptags', api_key: process.env.LASTFM_API_KEY, format: 'json' });
  if (mbid) params.set('mbid', mbid);
  else {
    params.set('artist', name);
    params.set('autocorrect', '1');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API}?${params}`, { signal: controller.signal, headers: { 'User-Agent': 'ASTRA-music-universe/1.0' } });
    const json = await res.json().catch(() => ({}));
    // Error 6: unknown artist/mbid. With an mbid that Last.fm doesn't know, retry by name.
    if (json.error === 6 && mbid) return topTags({ name });
    if (json.error === 29) throw Object.assign(new Error('rate limited'), { rateLimited: true });
    if (json.error) return [];
    const tags = (json.toptags?.tag || []).map(t => ({ name: t.name, count: Number(t.count) }));
    return usefulTags(tags, name, { max: 6, minCount: MIN_TAG_WEIGHT });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Array<{id, name, mbid?}>} artists  in priority order
 * @param {number} budgetMs  stop starting new lookups after this long
 * @returns {{ tagsById: Map<id, string[]>, looked: number, skipped: number, error?: string }}
 */
export async function fetchLastfmTags(artists, budgetMs) {
  const tagsById = new Map();
  if (!isLastfmConfigured() || artists.length === 0) return { tagsById, looked: 0, skipped: 0 };

  const now = Date.now();
  const queue = [];
  artists.forEach(a => {
    const hit = cache.get(a.id);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) tagsById.set(a.id, hit.tags);
    else queue.push(a);
  });

  const deadline = now + budgetMs;
  let looked = 0;
  let rateLimited = false;
  let next = 0;
  const worker = async () => {
    while (next < queue.length && Date.now() < deadline && !rateLimited) {
      const a = queue[next++];
      const started = Date.now();
      try {
        const tags = await topTags(a);
        cache.set(a.id, { tags, fetchedAt: Date.now() });
        tagsById.set(a.id, tags);
        looked++;
      } catch (err) {
        if (err.rateLimited) rateLimited = true;
      }
      const wait = MIN_INTERVAL_PER_WORKER_MS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const skipped = queue.length - looked;
  return { tagsById, looked, skipped, ...(rateLimited ? { error: 'Last.fm rate limit reached' } : {}) };
}
