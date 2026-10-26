import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrackTitle, extractFeaturedArtists, parseStreamingEvents } from '../../src/etl/historyParser.js';

const play = (over = {}) => ({
  ts: '2025-03-01T10:00:00Z',
  ms_played: 200000,
  master_metadata_album_artist_name: 'Justice',
  master_metadata_track_name: 'D.A.N.C.E.',
  ...over
});

test('cleanTrackTitle merges remasters, live cuts and punctuation', () => {
  assert.equal(cleanTrackTitle('505 - Remastered 2011'), '505');
  assert.equal(cleanTrackTitle('505 (Live)'), '505');
  assert.equal(cleanTrackTitle('D.A.N.C.E.'), 'd a n c e');
});

test('extractFeaturedArtists reads feat. credits and skips the primary artist', () => {
  assert.deepEqual(extractFeaturedArtists('Song (feat. Bonobo & Four Tet)', 'Justice'), ['Bonobo', 'Four Tet']);
  assert.deepEqual(extractFeaturedArtists('Song [ft. Justice]', 'Justice'), []);
  assert.deepEqual(extractFeaturedArtists('Plain title', 'Justice'), []);
});

test('parseStreamingEvents rejects input that is not an array', () => {
  assert.throws(() => parseStreamingEvents({}), /array/);
});

test('parseStreamingEvents drops duplicates and rows without artist, track or a readable time', () => {
  const summary = parseStreamingEvents([
    play(),
    play(), // exact duplicate
    play({ master_metadata_album_artist_name: '' }),
    play({ ts: 'not a date' }),
    null,
    'garbage'
  ]);
  assert.equal(summary.validPlays, 1);
  assert.equal(summary.artists.length, 1);
});

test('parseStreamingEvents survives a non-string timestamp instead of throwing', () => {
  assert.doesNotThrow(() => parseStreamingEvents([play({ ts: 1740823200000 })]));
  assert.equal(parseStreamingEvents([play({ ts: 1740823200000 })]).validPlays, 0);
});

test('parseStreamingEvents reads the older StreamingHistory_music field names', () => {
  const summary = parseStreamingEvents([
    { endTime: '2024-05-04 21:15', artistName: 'Bonobo', trackName: 'Kerala', msPlayed: 180000 }
  ]);
  assert.equal(summary.validPlays, 1);
  assert.equal(summary.artists[0].name, 'Bonobo');
});

test('parseStreamingEvents keeps brief plays so no artist disappears', () => {
  const summary = parseStreamingEvents([play({ ms_played: 4000, master_metadata_album_artist_name: 'Gunship' })]);
  assert.equal(summary.validPlays, 1);
  assert.equal(summary.artists.length, 1);
});

test('parseStreamingEvents returns an empty summary for no valid plays', () => {
  const summary = parseStreamingEvents([]);
  assert.equal(summary.validPlays, 0);
  assert.deepEqual(summary.artists, []);
});
