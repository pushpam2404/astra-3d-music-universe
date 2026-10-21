// Builds Spotify-format streaming histories for very different listeners from
// Last.fm's public charts (real artists and songs; generated plays and sessions).
// Usage: node tests/tastes/generate.mjs   (needs LASTFM_API_KEY in .env)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '../../.env'));
const KEY = process.env.LASTFM_API_KEY;
const OUT = path.join(here, '.cache');
fs.mkdirSync(OUT, { recursive: true });
const personas = JSON.parse(fs.readFileSync(path.join(here, 'personas.json')));
delete personas._note;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function lastfm(method, params) {
  const q = new URLSearchParams({ method, api_key: KEY, format: 'json', ...params });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${q}`);
    const json = await res.json().catch(() => ({}));
    if (json.error !== 29) { await sleep(220); return json; }
    await sleep(3000);
  }
  return {};
}

let seed = 42;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (arr, weights) => {
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) if ((r -= weights[i]) <= 0) return arr[i];
  return arr[arr.length - 1];
};

const PER_TAG = 35;
const SESSIONS = 420;
for (const [name, tags] of Object.entries(personas)) {
  const file = path.join(OUT, `${name}.json`);
  if (fs.existsSync(file)) { console.log('cached', name); continue; }
  const byTag = {};
  for (const tag of tags) {
    const top = await lastfm('tag.gettopartists', { tag, limit: String(PER_TAG) });
    const artists = (top.topartists?.artist || []).map(a => a.name);
    byTag[tag] = [];
    for (const artist of artists) {
      const tt = await lastfm('artist.gettoptracks', { artist, limit: '6', autocorrect: '1' });
      const tracks = (tt.toptracks?.track || []).map(t => t.name).filter(Boolean);
      if (tracks.length) byTag[tag].push({ artist, tracks });
    }
  }
  // Sessions: mostly one scene at a time, with some drift; favourites (chart rank) play more.
  const events = [];
  let t = Date.parse('2022-01-01T08:00:00Z');
  for (let s = 0; s < SESSIONS; s++) {
    const home = pick(tags, tags.map((_, i) => 1 / (i + 1)));
    const length = 4 + Math.floor(rnd() * 12);
    for (let k = 0; k < length; k++) {
      const tag = rnd() < 0.8 ? home : tags[Math.floor(rnd() * tags.length)];
      const pool = byTag[tag];
      if (!pool?.length) continue;
      const a = pick(pool, pool.map((_, i) => 1 / Math.pow(i + 1, 0.9)));
      const track = pick(a.tracks, a.tracks.map((_, i) => 1 / (i + 1)));
      const ms = rnd() < 0.15 ? Math.floor(rnd() * 25000) : 90000 + Math.floor(rnd() * 150000);
      t += ms + 2000;
      events.push({ ts: new Date(t).toISOString().replace(/\.\d+Z$/, 'Z'), ms_played: ms, master_metadata_track_name: track, master_metadata_album_artist_name: a.artist, spotify_track_uri: null });
    }
    t += (6 + rnd() * 60) * 3600 * 1000;
  }
  fs.writeFileSync(file, JSON.stringify(events));
  console.log(name, events.length, 'plays', Object.values(byTag).reduce((n, l) => n + l.length, 0), 'artists');
}
