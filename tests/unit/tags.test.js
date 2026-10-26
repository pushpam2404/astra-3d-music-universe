import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usefulTags } from '../../server/tagFilter.js';
import { tagsContradictCountry, tagToCountry } from '../../server/places.js';
import { squashTag } from '../../src/etl/genreSignals.js';

test('usefulTags drops tags that are the artist name, orders by weight and caps the list', () => {
  const tags = [
    { name: 'french house', count: 80 },
    { name: 'Justice', count: 100 },
    { name: 'electro', count: 95 },
    { name: 'dance', count: 1 }
  ];
  assert.deepEqual(usefulTags(tags, 'Justice', { max: 2 }), ['electro', 'french house']);
  assert.deepEqual(usefulTags(tags, 'Justice', { minCount: 50 }), ['electro', 'french house']);
});

test('squashTag treats spelling variants of one genre as the same key', () => {
  assert.equal(squashTag('Synth-Pop'), squashTag('synthpop'));
  assert.equal(squashTag('R&B'), squashTag('rnb'));
  assert.equal(squashTag('Indie Rock music'), squashTag('indie rock'));
});

test('tagToCountry reads country names from Intl', () => {
  assert.equal(tagToCountry('india'), 'India');
  assert.equal(tagToCountry('shoegaze'), null);
});

test('tagsContradictCountry flags tags that describe a namesake from elsewhere', () => {
  assert.equal(tagsContradictCountry(['japan', 'rock'], ['India']), true);
  assert.equal(tagsContradictCountry(['india', 'rock'], ['India']), false);
  assert.equal(tagsContradictCountry(['rock'], ['India']), false);
  assert.equal(tagsContradictCountry(['japan'], []), false);
});
