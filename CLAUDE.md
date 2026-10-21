# CLAUDE.md

This file provides comprehensive architectural and operational context to Claude Code and any AI coding agent working in this repository. Read this file and [`ASTRA_CONTEXT.md`](./ASTRA_CONTEXT.md) before modifying code.

---

## 1. Project Overview

**Astra** is a Vite + Three.js interactive 3D music observatory that maps a user's Spotify listening history and live Spotify library into a 3D celestial universe:

* **Cluster Center Planet (`type: 'genre'`)**: A macro-genre or listening community discovered via Louvain community detection, rendered at the center of each cluster as a solid, non-glowing 3D planet (`SphereGeometry(node.baseRadius, 48, 48)` with `solarPlasmaShader.js`).
* **Artist Planet (`type: 'artist'`)**: An individual artist positioned via 3D UMAP similarity + spherical cloud layout + 3D collision clearance, rendered via `InstancedMesh` (`SphereGeometry(1, 32, 32)` with `planetShader.js`).
* **Song Moon (`type: 'track'`)**: An individual track orbiting its primary artist planet on an inclined orbit, rendered via `InstancedMesh` as a flat-faceted crystal (`IcosahedronGeometry(1, 0)` with `createMoonCrystalMaterial()` in `planetShader.js`).
* **Connection Lines & Focus Tubes**: `LineSegments` for overview connections (`artist_genre`, `artist_bridge`, `track_artist`, `track_collab`) plus weighted 3D `CylinderGeometry` tubes and orbital rings when focusing on a specific artist or song.

The frontend uses plain ES modules and vanilla JS/CSS (zero UI framework). A lightweight Express backend in `server/` (and `api/index.js` on Vercel) handles stateless Spotify OAuth, live signal fetching, and multi-source metadata enrichment (Wikidata, MusicBrainz, Last.fm).

---

## 2. Commands & Environment

```bash
npm install
npm run dev         # Express + Vite middleware (restarts on server/ changes)
npm run dev:client  # Frontend-only Vite server
npm run build       # Production Vite bundle -> dist/
npm start           # NODE_ENV=production: Express serves dist/ + /api
```

* **Running Server Preservation**: If a local server is already running (e.g., on port `5180` or `5173`) and serving `dist/` or Vite middleware, **do not kill or restart the server** unless explicitly asked—run `npx vite build` (`./node_modules/.bin/vite build`) so the user can simply refresh without losing background enrichment progress.
* **Environment Variables (`.env`)**:
  * `SPOTIFY_CLIENT_ID` & `SPOTIFY_CLIENT_SECRET`: Spotify Developer App credentials.
  * `SESSION_SECRET`: Secret used to derive the AES-256-GCM key for the stateless `astra_session` cookie (falls back to `SPOTIFY_CLIENT_SECRET`).
  * `LASTFM_API_KEY`: Optional but recommended; enables Last.fm track/artist tag enrichment (`server/lastfm.js`).
  * `PORT`: Local server port (defaults to `5173`, often run on `5180`).
* **Spotify Loopback Rule**: Spotify rejects `http://localhost`; always use `http://127.0.0.1:<PORT>/api/auth/callback`.

---

## 3. Non-Negotiable Architectural & Visual Invariants

Any AI agent modifying Astra **must** preserve these invariants:

### 3.1 Browser-Side History Assembly (Vercel 4.5 MB Limit Defense)
* **Never** `POST` raw streaming history files or large `historySummary` payloads to `/api/universe`. Vercel serverless functions reject payloads over 4.5 MB with `HTTP 413 Payload Too Large`.
* When browser-imported history (`historySummary`) or cached Spotify signals are used, `src/api/backendClient.js` (`buildBrowserHistoryUniverse`) runs `mergeSignalsAndRank` and `assembleUniverseFromSignals` (`src/etl/universeAssembler.js`) **entirely in the browser**.
* When logged into Spotify, `/api/universe` is called with `{ signalsOnly: true, useLocalHistory: false }` so the server returns only lightweight Spotify OAuth signals.

### 3.2 Spotify Rate-Limit Defense (HTTP 429 Prevention)
* **Never** call the Spotify Web API inside background enrichment loops.
* Live Spotify OAuth signals (`topArtistsByRange`, `topTracksByRange`, `recent`, `saved`) are cached in `localStorage` under `astra_spotify_signals_v1` for **6 hours** (`SPOTIFY_CACHE_TTL_MS` in `src/api/backendClient.js`).
* All artist genre/country enrichment goes exclusively through `POST /api/enrich` (`server/enrich.js` → Wikidata SPARQL, MusicBrainz, Last.fm) and is cached per artist in `localStorage` (`src/api/artistMetaCache.js`).
* **Zero Hardcoding**: Never add hardcoded artist-to-genre or artist-to-country lookup tables.

### 3.3 100% Opaque 3D Celestial Bodies & Non-Glowing Central Cluster Planets
* **No Translucent Soap Bubbles**: `createPlanetMaterial()`, `createMoonCrystalMaterial()` (`src/renderer/shaders/planetShader.js`), and `createSolarShaderMaterial()` (`src/renderer/shaders/solarPlasmaShader.js`) must all use `transparent: false`, `depthWrite: true`, and `depthTest: true`. Never toggle `depthWrite = false` on `artistMesh`, `trackMesh`, or `sphereMesh` during focus or lens modes.
* **Solid, Non-Glowing Central Cluster Planet**: Every cluster has a solid 3D planet at its center (`buildGenreSun` in `src/renderer/celestialFactory.js`). Do **not** attach additive glow sprites (`corona`), nebula clouds (`NEBULA_OPACITY = 0.0`), vertex-wobble plasma halos, or post-processing bloom (`BLOOM_STRENGTH = 0.0` in `src/renderer/postProcessing.js`).

### 3.4 Crisp Black Border on Light-Colored Clusters
* Light-colored clusters (e.g., pastel pink, lime green, mint, sky blue, yellow, peach, lavender) blend together when nodes overlap unless separated by a dark outline.
* `solarPlasmaShader.js` and `planetShader.js` compute a screen-space silhouette outline using `radial = sqrt(max(0.0, 1.0 - ndotv * ndotv))` and `fwidth(radial)`, mixing the outer silhouette edge toward near-black (`vec3(0.012, 0.015, 0.025)`) with extra width/strength on higher-luminance cluster colors (`isLight`).
* UI indicators (`.cluster-swatch`, `.label-dot`, `.chip-dot` in `src/style.css`) also carry a `1.5px solid rgba(0, 0, 0, 0.88)` border with no blurry colored box-shadow on swatches.

### 3.5 Perceptually Distinct Cluster Palette (OKLab Farthest-Point + OKLCH Golden-Angle)
* `src/config/genreTaxonomy.js` defines the 32-color `CLUSTER_COLORS` palette and precomputes `ORDERED_CLUSTER_COLORS` via greedy farthest-point sampling in **OKLab** perceptual space (`buildFarthestPointPalette`).
* Clusters are sorted by size/plays descending in `server/clusterNaming.js` and `src/etl/graphNormalizer.js`, and assigned colors via `getDistinctClusterColor(index)` so the largest clusters always receive maximally distant colors and never collide.
* If a universe has more than 32 clusters, `getDistinctClusterColor(index)` generates additional gamut-clamped colors in **OKLCH** using a `137.5°` golden-angle hue step (`oklchToHex`) rather than wrapping around with `%`.

### 3.6 Strict Lens & Focus Culling (Zero Orphan Lines or Floating Labels)
* **In `CelestialFactory.updateFocus` (`src/renderer/celestialFactory.js`)**:
  * When a Time/Memory Lens (`activeLens !== 'all'`) is active (either in Galaxy Overview or inside a selected Cluster), **only** nodes that match the active lens (`lensMatch.has(n.id)`) or are the primary parent artist of a lens-matched track (`lensArtistHasMatchTrack.has(n.id)`) remain visible (`focusTarget >= 1.1`). All non-matching artists and tracks are strictly culled (`focusTarget = 0.0, lensScale = 0.0`).
  * **Never** use a fallback like `!clusterHasLensMatch` that lights up all nodes in a cluster when 0 nodes match the active lens—if 0 artists in a cluster match `Current rotation`, 0 artists should appear in 3D, matching `"No artists in this cluster match that memory filter."` in the side panel.
  * When an Artist or Song is selected (`activeNode.type === 'artist' | 'track'`), unrelated song moons are culled (`focusTarget = 0.0, lensScale = 0.0`), while unrelated background artist planets and cluster centers dim into quiet matte spheres (`focusTarget = DIM_PLANET_FOCUS`) and are discarded in the fragment shader if they pass directly in front of the camera lens (`camDist < 28.0 && centerDist < 0.38`).
  * **Hard Edge Invariant**: An edge is never drawn if either endpoint has `focusTarget < 0.65` or `lensScale <= 0.01`.
* **In `LabelProjector` (`src/renderer/labelProjector.js`)**:
  * Never show an HTML label for any artist or track with `focusTarget < 0.65` or `lensScale <= 0.01`.
  * When `hasLens` is true (including inside Cluster Focus Mode), never label a node unless `nodeMatchesLens(node, activeLens)` is `true`.
* **Synchronized Cluster Explorer (`src/ui/detailPanel.js`)**:
  * Clicking an inline memory/era filter pill inside the Cluster detail panel invokes `onSetLens(f.id)` so the 3D canvas, top lens bar, and side-panel list always stay in sync.

### 3.7 3D Planet Collision Clearance
* `src/physics/galaxyLayout.js` runs `resolveClusterArtistOverlaps` per cluster and `resolveArtistCollisions(artists, 18)` globally so no two artist planets overlap and no artist clips into its central cluster planet (`coreRadius`).

### 3.8 Dynamic Cluster Scaling & Consensus Cluster Naming
* **Dynamic Resolution & Cluster Scaling (`server/clustering.js`)**:
  * Louvain resolution dynamically scales with library volume ($1.3$ to $2.25$) so large libraries naturally resolve into authentic sub-communities (Hindie, Filmi, Punjabi & Bhangra, Desi Hip-Hop, Synthpop, Ambient) rather than collapsing into monolithic blobs.
  * Cluster count dynamically scales from 8 to 22 ($\approx 8 + \sqrt{\max(0, \text{artists} - 100)} \times 0.21$).
* **Consensus-Driven Naming (`server/clusterNaming.js`)**:
  * Outlier tags ($< 3$ artists or $< 15\%$ support among genre-known members) cannot name a cluster.
  * Lift is clamped to $\le 14$ and consensus support is exponentially weighted ($\text{Support}^{1.35}$) to eliminate 1-off niche tag hijacking.
  * Names come **only** from genre tags members really have (Wikidata/MusicBrainz/Last.fm) or their genre families, optionally prefixed by a concentrated home country ("Indian Hindie"). **Never** `Artist & Co.` titles, moods derived from `estimatedFeatures` (hash-based, not real audio), or invented themes ("Celestial Beats"). `estimatedFeatures` must never feed naming or UI.
  * Clusters are genre groups (`clusterArtists` in `server/clustering.js`): a Louvain group exists only if at least `MIN_GENRE_SHARE` (25%) of its listening comes from artists with real genres; members of other groups join the most similar genre group (co-listening, collaborations, tags) or go to **Genre Unknown**. When `describeClusters` can't give a group an unused real-genre name it returns `duplicateOf`, and the two groups merge.
  * `assembleUniverseFromSignals` re-filters cached tags (`isJunkTag` from `server/tagFilter.js`, `PLACE_TAGS` incl. bare nationalities) so old browser caches can't name clusters with junk.
* **Country vs Genre Separation (`server/enrich.js`, `server/places.js`)**:
  * Pure place tags (`India`, `Pakistan`, `UK`, `USA`) are extracted to `countries` and omitted from `genres`, preventing country names from surfacing as musical subgenres in the UI.
* **Metadata Caching & POST Ceiling (`src/api/backendClient.js`, `server/enrich.js`, `src/api/artistMetaCache.js`)**:
  * `MAX_POST_KNOWN_META` is set to 8,000 so large libraries transmit full metadata to `/api/universe` without truncation loops.
  * `isFreshMeta` treats all cached entries with valid genres as permanently fresh.
  * `saveArtistMeta` automatically recovers from `localStorage` quota errors via oldest-entry pruning.

---

## 4. End-to-End Data & Rendering Flow

1. **Ingestion & Storage**:
   * **Spotify OAuth**: `/api/auth/login` → `/api/auth/callback` sets the encrypted `astra_session` cookie. `src/api/backendClient.js` fetches live signals (`signalsOnly: true`) and caches them in `localStorage` for 6 hours.
   * **Extended Streaming History**: Users import `Streaming_History_Audio_*.json` / `StreamingHistory_music_*.json` or `.json` snapshots via the **History** modal (`src/ui/hud.js`). `src/api/historyStorage.js` parses events via `parseStreamingEvents` (`src/etl/historyParser.js`) and persists `historySummary` in IndexedDB (`astra_history_db`).
   * **Local Folder Auto-Detection**: `server/historyLoader.js` also detects a local `Spotify Extended Streaming History/` directory when running locally.
2. **Universe Assembly & Clustering (`src/etl/universeAssembler.js` + `server/clustering.js`)**:
   * `mergeSignalsAndRank` merges Spotify top charts, recent plays, Liked Songs, and `historySummary`, deduplicating tracks by normalized primary artist + cleaned track title and extracting featured collaborators.
   * `assembleUniverseFromSignals` combines cached/enriched genre & country metadata, builds session co-listening pairs (`listenedTogether`), runs `clusterArtists` (TF-IDF + collaboration + co-listening similarity graph → seeded Louvain communities → seeded 3D UMAP embedding), and names clusters via `describeClusters` (`server/clusterNaming.js`).
3. **Graph Normalization & Layout (`src/etl/graphNormalizer.js` + `src/physics/galaxyLayout.js`)**:
   * `buildUniverseGraph` log-normalizes node radii (`TIER_BOUNDS`), assigns `ORDERED_CLUSTER_COLORS` by cluster size, and builds edges (`artist_genre`, `artist_bridge`, `track_artist`, `track_collab`).
   * `GalaxyLayoutEngine.initializeNodePositions` seriates clusters by affinity on a Fibonacci sphere (`computeBalancedClusterAnchors`), blends artist UMAP offsets with spherical shells, runs 3D collision resolution, and assigns inclined lunar orbits to tracks.
4. **Frame Loop (`src/main.js` → `animate`)**:
   * `easeViewOffset()` centers the 3D viewport beside the desktop side panel or above the mobile bottom sheet.
   * `layout.step()` updates orbiting song moon positions.
   * `factory.updateArtistInstances()`, `updateTrackInstances()`, `updateEdgeGeometry()`, `updatePulses()`, `updateSolarShaders()`, and `updateFocus()` update GPU buffers and focus highlights.
   * `pickNode()` raycasts every 3rd frame for hover states and handles multi-touch-safe tap/double-tap selection (`pointerdown`/`pointerup` ignores pinch-to-zoom gestures).
   * `labelProjector.update()` projects and overlap-culls DOM labels, and `composer.render()` renders the frame.
