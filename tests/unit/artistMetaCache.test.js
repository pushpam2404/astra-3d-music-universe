import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
const { loadArtistMeta, saveArtistMeta } = await import('../../src/api/artistMetaCache.js');

const DAY = 24 * 60 * 60 * 1000;
beforeEach(() => store.clear());

test('an artist with genres is remembered for a month', () => {
  saveArtistMeta({ a: { g: ['rock'], c: [], t: Date.now() - 20 * DAY } });
  assert.deepEqual(loadArtistMeta().a.g, ['rock']);
  saveArtistMeta({ b: { g: ['rock'], c: [], t: Date.now() - 31 * DAY } });
  assert.equal(loadArtistMeta().b, undefined);
});

test('"nothing found" is retried after a week instead of staying blank for a month', () => {
  saveArtistMeta({ fresh: { g: [], c: [], t: Date.now() - 2 * DAY }, old: { g: [], c: [], t: Date.now() - 8 * DAY } });
  const meta = loadArtistMeta();
  assert.ok(meta.fresh);
  assert.equal(meta.old, undefined);
});
