# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ASTRA is a Vite + Three.js app that renders Spotify listening data as a 3D "universe": genres → suns, artists → planets, tracks → satellites. The frontend is plain ES modules and vanilla JS/CSS with no framework. A small Express backend in `server/` handles Spotify OAuth and builds the live dataset.

## Commands

```bash
npm install
npm run dev         # Express + Vite middleware at http://127.0.0.1:5173/ (restarts on server/ changes)
npm run dev:client  # frontend only (plain vite; /api calls fail, presets still work)
npm run build       # production build to dist/
npm start           # NODE_ENV=production: Express serves dist/ plus /api
```

On Vercel, the Vite build output (`dist/`) is served statically. `vercel.json` rewrites `/api/*` to `api/index.js`, which exports the same Express app (`server/app.js`) on the original URL. `server/index.js` is only used for local runs.

There is no test suite, linter, or formatter configured. Verify changes by running the dev server in a browser. You can exercise `server/universeBuilder.js` in Node with a mock `api` object (`{ get(endpoint) }`).

The backend reads `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` from `.env` locally, or from Vercel environment variables (see `.env.example`). The redirect URI defaults to `<request origin>/api/auth/callback`, built from the `x-forwarded-*` headers. It must exactly match a Redirect URI registered in the Spotify dashboard. Spotify allows plain `http` only for an explicit loopback IP (`127.0.0.1`), never for `localhost`.

## Architecture

`src/main.js` is the orchestrator. It owns a single mutable `AppState` object, constructs every engine/controller, wires the HUD callbacks, and runs the `requestAnimationFrame` loop. Most cross-module behavior is defined here, so read it first.

### Data flow

1. **Source dataset** — a raw `{ name, description, genres[], artists[], tracks[] }` object. It comes from one of:
   - `config/presets.js` (`GALAXY_PRESETS`, the default with no login)
   - the backend, via `GET /api/universe?time_range=` (`src/api/backendClient.js`). The response is `{ dataset, diagnostics }`, and the diagnostics are logged to both consoles.
   - `etl/streamingHistoryParser.js` (GDPR `StreamingHistory_music_*.json` / `endsong_*.json` drag-and-drop, routed through `HudController`)
   - `etl/galaxyCollider.js` (merges two built graphs; nodes get a `galaxyCenter` of x=-140 / +140, or the origin for shared "bridge" nodes)
2. **`etl/graphNormalizer.js` → `buildUniverseGraph(dataset, timeMultiplier)`** turns the dataset into `{ nodes, edges, nodeMap }`. Radii are log10-normalized per tier using `basePlays` and `TIER_BOUNDS`. Edges are artist→genre (via `artist.genres` ids), track→artist (`track.artistId`), and collab (`track.featArtistId`). Node objects are mutated in place downstream: physics adds `position`/`velocity`, and the factory adds `meshGroup`/`sphereMesh`.
3. **`loadDataset()` in main.js** tears down the old meshes, rebuilds the graph, calls `physics.initializeNodePositions`, builds meshes with `CelestialFactory`, and resyncs the HTML labels. Every dataset switch (preset, time range, upload, collision) goes through this function.

### Per-frame loop (main.js `animate`)

`ForceDirectedPhysicsEngine.step` (Hooke springs, Coulomb repulsion, Keplerian swirl, or a `'rings'` layout mode) → edge line and pulse updates → solar shader time uniforms → camera (`CameraFlightController`, or `CosmicCinemaDirector` while recording) → hover raycast → `LabelProjector` (2D HTML labels projected from 3D) → inspector FFT spectrum → `EffectComposer` render (bloom plus a warp pass driven by camera flight).

### Module layout

- `physics/forceSolver3D.js`: all node motion. Tunables live in `config/constants.js` (`PHYSICS_CONFIG`, `TIER_BOUNDS`, `GENRE_PALETTES`).
- `renderer/`: scene setup, mesh construction (`celestialFactory.js`), GLSL shaders in `renderer/shaders/` (plain JS string exports), post-processing, camera flight and autopilot.
- `audio/sonicSynthesizer.js`: a Web Audio synth driven by node audio features (`valence` → modal scale, `energy` → waveform and filter cutoff, `bpm` → arpeggio rate). It uses no audio files.
- `ui/hudController.js`: binds every DOM control in `index.html` by element id and calls back into main.js. `ui/inspectorDrawer.js` is the node detail panel. `ui/cinemaExporter.js` records the canvas and synth audio to `.webm` along a Catmull-Rom camera path.
- `etl/timeMachine4D.js`: `TemporalUniverseScrubber` applies a 90-day half-life decay to timestamped events. Without real events it falls back to a synthetic timeline.

### Backend (`server/`)

- `app.js` builds the `/api` Express app. `index.js` adds the Vite middleware (dev) or `dist/` (production) and listens.
- `routes.js` handles `/api/auth/{status,login,callback,logout}` and `/api/universe`.
- `spotify.js` implements the Authorization Code flow with the client secret. It refreshes access tokens automatically and retries on 429.
- `sessions.js` keeps sessions stateless: the tokens are AES-256-GCM encrypted into the HttpOnly `astra_session` cookie, with a key derived from `SESSION_SECRET` (falling back to the client secret). Nothing is stored on the server, which is required for serverless. When a token is refreshed, the cookie is rewritten through `createApi`'s `onTokensRefreshed` callback.
- `universeBuilder.js` turns top artists/tracks into the raw dataset. It works within the 2026 Development Mode API limits: batch `GET /artists?ids=` is removed, so missing artists are fetched individually and cached; followers and popularity are removed; audio features are unavailable, so features are derived deterministically from the id. It guarantees every track's primary artist exists as a node. Artists whose genres aren't in the top 8 go to an `OTHER GENRES` sun, and artists with no genres go to `UNCLASSIFIED`.
- `universeBuilder.js` imports `src/config/constants.js`, so that file must stay importable in Node (no browser APIs).

## Notes

- `docs/` holds detailed design blueprints (numbered 00–09) that the README links to, but `docs/` is in `.gitignore`, so it exists only locally.
- The DOM structure, element ids, and most of the HUD markup live in `index.html`. Styling is in `src/style.css`.
