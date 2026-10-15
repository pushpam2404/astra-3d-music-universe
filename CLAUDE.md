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
   - `config/presets.js` (`GALAXY_PRESETS.cosmic_synth`): the logged-out demo universe. There is no preset picker in the UI.
   - the backend, via `GET /api/universe` (`src/api/backendClient.js`). It returns one combined universe, not one per time range. The response is `{ dataset, diagnostics }`, and the diagnostics are logged to both consoles.
2. **`etl/graphNormalizer.js` → `buildUniverseGraph(dataset, timeMultiplier)`** turns the dataset into `{ nodes, edges, nodeMap }`. Radii are log10-normalized per tier using `basePlays` and `TIER_BOUNDS`. Edges are artist→genre (via `artist.genres` ids), track→artist (`track.artistId`), and collab (`track.featArtistId`). Node objects are mutated in place downstream: physics adds `position`/`velocity`, and the factory adds `meshGroup`/`sphereMesh`.
3. **`loadDataset()` in main.js** tears down the old meshes, rebuilds the graph, lays it out, builds meshes with `CelestialFactory`, resyncs the HTML labels and the cluster list, and frames the camera. The demo and the live universe both go through it.

### Per-frame loop (main.js `animate`)

`GalaxyLayoutEngine.step` (positions are a pure function of time) → `factory.updateTrackInstances` / `updateEdgeGeometry` / `updatePulses` → solar shader time → `updateNebulae` (fades a cluster's cloud as the camera enters it) → focus dimming (`updateFocus`; halos, nebulae and sun lights also scale with `factory.glow`, the View → Glow slider, which also sets bloom strength) → camera (`CameraFlightController`) → hover raycast every 3rd frame → `LabelProjector` → `EffectComposer` render (bloom). The camera uses `setViewOffset`, so the galaxy centers in the area the side panel leaves visible: beside it on desktop, above the bottom sheet on phones.

### Module layout

- `physics/galaxyLayout.js`: deterministic 3D layout in the style of an embedding cloud, with no force simulation. Each cluster is a 3D cloud of artists around its sun: a seeded random direction per artist, with radius proportional to the cube root of rank, so top artists sit near the center. Cluster centers sit on a Fibonacci sphere, ordered by affinity, and the sphere radius is solved so no two clouds overlap. Bridge artists (`genres.length === 2`) float between both clouds, and tracks orbit as moons. This is the "Clusters" arrangement. The "Similarity" arrangement (the default) places artists at the server's UMAP embedding (`artist.embed`), scaled so the typical nearest-neighbour gap matches the cluster spacing, with each sun at its members' centroid. Both arrangements are precomputed into `node.layoutPos[mode]`, and `setMode` eases between them. View → Arrange by switches between them; the choice is stored in `localStorage` and the option is hidden when there are no embeddings, as in the demo. Artists are static; the camera auto-rotates instead (OrbitControls `autoRotate`, speed set by Motion). The layout writes `clusterRadius`, `labelRank`, `isBridge` and `systemRadius` onto nodes. Tunables are in `config/constants.js` (`LAYOUT_CONFIG`, `TIER_BOUNDS`).
- `config/genreTaxonomy.js`: maps fine genre strings to broad families (with colors) by keyword. It is shared by the server and the browser.
- `renderer/`: scene setup, mesh construction (`celestialFactory.js`), which builds for scale. Suns and planets are individual meshes. All tracks are one `InstancedMesh`; each track's `meshGroup` is a lightweight handle (`position` / `scale` / `visible`), so layout, layer and time-machine code treats it like a Group, and raycast hits resolve through `nodeFromHit`. All links are one `LineSegments`, with per-link opacity encoded in the vertex colors (additive blending), and pulses are one `InstancedMesh`. The factory also handles per-cluster nebula sprites and focus dimming (`fadeTargets`, instance colors, link colors). The rest of `renderer/`: GLSL shaders in `renderer/shaders/` (plain JS string exports), post-processing, and camera flight (overview framed by `setSceneRadius`). `labelProjector.js` places labels by priority with greedy overlap rejection. It creates track labels lazily and writes to the DOM only on change. In dev, `window.__astra.loadDataset(dataset)` loads any dataset from the console, which is handy for stress tests.
- `ui/hud.js`: everything around the galaxy. That covers the top bar (search, the View popover, the Spotify button) and the side panel, which is one slot showing either the cluster list or details, never both. It also handles the caption with its single notice line, and the loading overlay. `ui/detailPanel.js` renders cluster, artist and song details. It only shows real data: why something is in the universe (`ranks` per time range, `liked`, `recentPlays` from the server) and where its genres come from. It never shows invented stats.
- UI principle: no fake numbers. Audio features are estimated server-side, so they aren't displayed. The audio synth, time-lapse, cinema recorder, autopilot, collide mode and GDPR-archive import were removed because they over-promised.
- Styling is in `src/style.css`, with a star-atlas look: Instrument Serif for names, Instrument Sans for UI, and cluster colors as the only accents. Under 760px the side panel becomes a bottom sheet.

### Backend (`server/`)

- `app.js` builds the `/api` Express app. `index.js` adds the Vite middleware (dev) or `dist/` (production) and listens.
- `routes.js` handles `/api/auth/{status,login,callback,logout}` and `/api/universe`.
- `spotify.js` implements the Authorization Code flow with the client secret. It refreshes access tokens automatically and retries on 429.
- `sessions.js` keeps sessions stateless: the tokens are AES-256-GCM encrypted into the HttpOnly `astra_session` cookie, with a key derived from `SESSION_SECRET` (falling back to the client secret). Nothing is stored on the server, which is required for serverless. When a token is refreshed, the cookie is rewritten through `createApi`'s `onTokensRefreshed` callback.
- `universeBuilder.js` merges every listening signal into one dataset. Songs are deduplicated by primary artist plus cleaned title (`cleanTitle`), because Spotify lists one song under several IDs, and each song keeps every source that mentioned it. The signals are: top artists and tracks for all three time ranges (paged), recently played, and Liked Songs (`/me/tracks`, needs `user-library-read`). Scores are weighted per source. Optional sources fail into diagnostics warnings instead of failing the load. `/api/auth/status` reports `missingScopes` for sessions from before a scope was added, and the HUD then offers RECONNECT. The builder works within the 2026 Development Mode API limits: batch `GET /artists?ids=` is removed, and track artists are used as-is (simplified objects); artist genres come back empty; followers and popularity are removed; audio features are unavailable, so features are derived deterministically from the id. It guarantees every track's primary artist exists as a node. In the output, the "genres" (suns) are clusters, and each artist's `genres` holds `[clusterId]` or `[clusterId, bridgeClusterId]`.
- `genreEnrichment.js` (Wikidata) and `musicbrainz.js` look up artist metadata by exact Spotify artist ID, at a fixed few requests per chunk of artists. Wikidata provides genres, country and occupation; MusicBrainz provides country, tags and the MusicBrainz ID. `lastfm.js` runs in parallel with both, within `METADATA_BUDGET_MS`. For each artist, most-listened first, it asks for the tags of that artist's most-played track in the library (`track.getTopTags`). That disambiguates artists who share a name, since Last.fm merges them into one page. It falls back to `artist.getTopTags` when the track has no tags, and discards those fallback artist-page tags when they name a country that contradicts the one MusicBrainz or Wikidata knows (`places.js` → `tagsContradictCountry`). It runs at about 20 requests a second. Bump `LASTFM_METHOD_VERSION` in `universeBuilder.js` whenever the lookup method changes, so browsers re-check their cached artists. it needs `LASTFM_API_KEY` and does nothing without it. `tagFilter.js` strips junk community tags. All of these cache in memory, back off on rate limits, and never throw. Failures become diagnostics warnings.
- There is no database. The browser is the persistent cache: `src/api/artistMetaCache.js` stores per-artist `{ g, c, t }` in `localStorage`, `POST /api/universe` sends it back as `knownMeta`, and the server only looks up artists it doesn't already know. Artists still waiting on Last.fm are left out of the returned `artistMeta`, so the next load retries them. Remembered genres are capped the same way as fresh ones, so a cached load clusters identically.
- `clustering.js` builds an artist similarity graph (TF-IDF cosine over genre and `@country` tags, plus genre-family cosine, plus a collaboration bonus) and runs Louvain (`graphology-communities-louvain`, seeded). It absorbs splinter clusters (under about 1% of artists), places orphans with the cluster they resemble most (or in "Uncharted"), and marks bridge artists. `embed3d` runs UMAP (`umap-js`, seeded, about 0.75 s for 500 artists) on k-nearest-neighbours taken directly from the similarity matrix (distance = 1 − similarity), blended with cluster labels (`EMBED_CLUSTER_WEIGHT`), to produce 3D positions where distance means dissimilarity. `clusterNaming.js` names clusters by distinctive genres (support × lift, with broad genres discounted), adds a demonym when the home country is concentrated, and falls back to "<Demonym> Scene" or "<Top artist> & Co.". Genre synonyms are merged in `normalizeGenre` (`genreTaxonomy.js`).
- `server/` imports `src/config/genreTaxonomy.js`, so that file must stay importable in Node (no browser APIs).

## Notes

- `docs/` holds detailed design blueprints (numbered 00–09) that the README links to, but `docs/` is in `.gitignore`, so it exists only locally.
- The DOM structure and element ids live in `index.html`. Styling is in `src/style.css`.
