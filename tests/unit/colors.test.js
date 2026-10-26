import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDistinctClusterColor, normalizeGenre } from '../../src/config/genreTaxonomy.js';

test('cluster colours are valid hex and none of the first 24 repeat', () => {
  const colors = Array.from({ length: 24 }, (_, i) => getDistinctClusterColor(i));
  for (const c of colors) assert.match(c, /^#[0-9a-f]{6}$/i);
  assert.equal(new Set(colors).size, colors.length);
});

test('neighbouring clusters get clearly different colours', () => {
  const rgb = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  for (let i = 0; i < 12; i++) {
    const a = rgb(getDistinctClusterColor(i));
    const b = rgb(getDistinctClusterColor(i + 1));
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    assert.ok(dist > 60, `clusters ${i} and ${i + 1} are only ${dist.toFixed(0)} apart`);
  }
});

test('normalizeGenre strips case, punctuation and a trailing "music"', () => {
  assert.equal(normalizeGenre('Hip-Hop music'), 'hip hop');
  assert.equal(normalizeGenre('  Synth_Pop '), 'synth pop');
});
