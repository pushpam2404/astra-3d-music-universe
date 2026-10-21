// Rebuilds ground truth for the generated listeners: which Last.fm tag chart each
// artist came from (first chart wins). Writes .cache/truth.json.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '../../.env'));
const personas = JSON.parse(fs.readFileSync(path.join(here, 'personas.json')));
delete personas._note;
const truth = {};
for (const [name, tags] of Object.entries(personas)) {
  truth[name] = {};
  for (const tag of tags) {
    const q = new URLSearchParams({ method: 'tag.gettopartists', tag, limit: '35', api_key: process.env.LASTFM_API_KEY, format: 'json' });
    const json = await (await fetch(`https://ws.audioscrobbler.com/2.0/?${q}`)).json();
    (json.topartists?.artist || []).forEach(a => { truth[name][a.name] ??= tag; });
    await new Promise(r => setTimeout(r, 250));
  }
}
fs.writeFileSync(path.join(here, '.cache/truth.json'), JSON.stringify(truth, null, 1));
console.log(Object.fromEntries(Object.entries(truth).map(([k, v]) => [k, Object.keys(v).length])));
