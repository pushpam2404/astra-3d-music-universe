# Astra

Your Spotify listening, mapped as a living 3D celestial universe. Genre clusters form planetary systems with a solid central cluster planet, artists orbit as planets, and individual tracks circle them as faceted crystal moons. Artists that share genres, home countries, collaborations, or listening sessions gravitate into the same cluster regardless of language.

Live: https://astra-3d-music-universe.vercel.app

---

## Highlights

* **Dual Ingestion (Spotify Web API & Extended Streaming History):** Connect your Spotify account to map your top artists/tracks (`short_term`, `medium_term`, `long_term`), recent plays, and Liked Songs. Import standard `StreamingHistory_music_*.json` or multi-year Spotify Extended Streaming History (`Streaming_History_Audio_*.json` / `endsong_*.json`) directly in the browser to visualize 50,000+ plays across years without hitting serverless payload limits.
* **Isomorphic Browser-Side Graph Assembly:** Raw streaming history files are parsed, merged with live/cached Spotify signals, and clustered via Louvain community detection + 3D UMAP directly in the browser (`src/etl/universeAssembler.js`), keeping `/api/*` requests lightweight and avoiding Vercel's 4.5 MB serverless body limit (`HTTP 413`).
* **Multi-Source Dynamic Genre & Origin Enrichment:** Because Spotify's Development Mode API no longer returns artist genres, Astra resolves artist genres, occupations, and origin countries via **Wikidata SPARQL**, **MusicBrainz**, and **Last.fm** (`track.getTopTags` + `artist.getTopTags`) in background batches (`POST /api/enrich`), caching results in `localStorage` so repeat loads require zero duplicate lookups.
* **Perceptually Distinct OKLab/OKLCH Cluster Palette & Crisp Silhouette Borders:** Clusters receive unique colors in size order using a greedy farthest-point ordering in OKLab space (`ORDERED_CLUSTER_COLORS` in `src/config/genreTaxonomy.js`), with 137.5° golden-angle OKLCH overflow past 24 clusters. All central cluster planets, artist planets, and crystal song moons are 100% opaque (`transparent: false, depthWrite: true`) with zero bloom/glow blowout and a screen-space `fwidth` black border on light-colored clusters so overlapping nodes remain individually recognizable.
* **Temporal & Memory Lenses:** Filter the 3D cosmos and side-panel explorers simultaneously through time capsules and listening habits: *All time*, *Past favorites*, *Haven’t heard in a while (Dormant)*, *Current rotation*, *All-time staples*, or specific eras (`2026`, `Early 2025`, `2025`, `Early 2024`, `2024`, `2023`, `2020–22`).
* **Collision-Free 3D Layout:** Cluster centers sit on an affinity-seriated Fibonacci sphere with pairwise clearance relaxation, and artist planets run through a 3D overlap solver (`resolveClusterArtistOverlaps` and `resolveArtistCollisions`) that reserves clearance for each planet's moon orbit shell.
* **Export & Snapshot Portability:** Export your computed universe as an Astra Universe Snapshot (`.json`) for instant re-import without re-clustering, or export an aggregated listening history table as `.csv`. Toggle freely between **Spotify + History Songs** and **Spotify API Only** modes.

---

## System Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                               Browser                                │
│  • Three.js WebGL Scene (src/renderer/universeScene.js)              │
│  • CelestialFactory: Opaque Cluster Planets, Instanced Artist        │
│    Spheres, Faceted Icosahedron Song Moons, 3D Focus Tubes           │
│  • Custom GLSL Shaders (planetShader.js, solarPlasmaShader.js)       │
│  • Greedy Overlap-Culling HTML LabelProjector (labelProjector.js)    │
│  • Isomorphic ETL & Clustering (historyParser.js,                    │
│    universeAssembler.js, server/clustering.js, server/clusterNaming) │
│  • Client Cache: IndexedDB (history/snapshots) + localStorage        │
│    (6-hour Spotify signal cache + 30-day artist genre metadata)      │
└──────────────────▲──────────────────────────────────▲────────────────┘
                   │                                  │
     Lightweight Spotify Signals        Batched /api/enrich (40–50 artists)
     (signalsOnly=true, 6h TTL)         Wikidata + MusicBrainz + Last.fm
                   │                                  │
┌──────────────────▼──────────────────────────────────▼────────────────┐
│                      Express / Vercel Backend                        │
│  • /api/auth/*      Stateless AES-256-GCM cookie OAuth flow          │
│  • /api/universe    Signals-only fetch or server-side fallback       │
│  • /api/enrich      Wikidata SPARQL + MusicBrainz + Last.fm resolver │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Repository & Module Map

| File / Directory | Target | Responsibilities |
| :--- | :--- | :--- |
| `src/main.js` | Browser | Application entry point, `AppState` owner, multi-touch-safe pointer/pinch raycasting, background `/api/enrich` batch loop, and `requestAnimationFrame` loop. |
| `src/config/genreTaxonomy.js` | Isomorphic | Maps fine-grained genres to broad families and provides the OKLab/OKLCH maximally-distant cluster color palette (`CLUSTER_COLORS`, `ORDERED_CLUSTER_COLORS`, `getDistinctClusterColor`). Must remain free of browser APIs. |
| `src/config/constants.js` | Browser | Tier radius bounds (`TIER_BOUNDS`) and 3D layout constants (`LAYOUT_CONFIG`). |
| `src/etl/historyParser.js` | Isomorphic | Parses Spotify Account Data & Extended Streaming History JSON dumps, deduplicates plays, extracts featured artists, computes session co-listening pairs, and classifies temporal memory profiles (`past_fav`, `dormant`, `current_rotation`, `all_time_staple`, era tags). |
| `src/etl/universeAssembler.js` | Isomorphic | Merges Spotify API signals with `historySummary`, ranks artists/tracks, invokes `clusterArtists`, and builds the unified `{ genres, artists, tracks, historyMeta }` dataset. |
| `src/etl/graphNormalizer.js` | Browser | Normalizes raw entities into 3D graph nodes & edges (`artist_genre`, `artist_bridge`, `track_artist`, `track_collab`) and assigns size-ordered `ORDERED_CLUSTER_COLORS`. |
| `src/physics/galaxyLayout.js` | Browser | Places cluster centers on an affinity-ordered Fibonacci sphere, blends 3D UMAP coordinates with spherical shells, resolves intra-cluster and global planet-to-planet collisions, and orbits song moons. |
| `src/renderer/celestialFactory.js` | Browser | Builds and updates all Three.js meshes: solid non-glowing central cluster planets (`buildGenreSun`), instanced artist planets (`buildArtistPlanets`), instanced crystal song moons (`buildTrackSatellites`), connection tubes, and strict lens/focus culling (`updateFocus`). |
| `src/renderer/shaders/planetShader.js` | Browser | Opaque GLSL shaders for artist spheres (`createPlanetMaterial`) and flat-faceted crystal song moons (`createMoonCrystalMaterial`), including screen-space `fwidth` black borders on light-colored clusters. |
| `src/renderer/shaders/solarPlasmaShader.js` | Browser | Opaque, non-glowing GLSL shader for central cluster planets (`createSolarShaderMaterial`) with subtle atmospheric bands and a crisp black silhouette border on light-colored clusters. |
| `src/renderer/labelProjector.js` | Browser | Greedy screen-space HTML label projector with overlap rejection. Never labels dimmed or culled nodes (`focusTarget < 0.65` or `lensScale <= 0.01`) and strictly enforces active lens filters. |
| `src/ui/hud.js` & `src/ui/detailPanel.js` | Browser | Top bar, Time & Memory Lens bar, History import/export modal, View popover, and synchronized right-hand side panel / mobile bottom sheet. |
| `src/api/backendClient.js` | Browser | Client API wrapper with 6-hour `localStorage` caching for Spotify OAuth signals (`astra_spotify_signals_v1`) and browser-side universe assembly. |
| `src/api/historyStorage.js` | Browser | IndexedDB persistence (`astra_history_db`) for imported `historySummary` and `universeSnapshot`, plus `.json` snapshot and `.csv` export generators. |
| `server/clustering.js` & `server/clusterNaming.js` | Isomorphic | Sparse TF-IDF genre/country/collaboration/co-listening similarity graph, seeded Louvain community detection, seeded 3D UMAP embedding, and support×lift cluster naming. |
| `server/enrich.js`, `genreEnrichment.js`, `musicbrainz.js`, `lastfm.js` | Node.js | Multi-source artist genre & country lookup pipeline (Wikidata SPARQL, MusicBrainz API, Last.fm track/artist top tags). |

---

## Key Architectural & Visual Invariants

1. **Browser-Side Assembly (Vercel 4.5 MB Limit Defense):** Extended history dumps are 20–100+ MB. Always parse and assemble history universes client-side via `src/etl/historyParser.js` and `src/etl/universeAssembler.js` (fetching live Spotify signals with `signalsOnly: true`) so requests never hit Vercel `HTTP 413` payload limits.
2. **Spotify Rate-Limit Defense (`HTTP 429` Prevention):** Never query Spotify endpoints inside background enrichment loops. Cache user OAuth signals in `localStorage` for 6 hours (`SPOTIFY_CACHE_TTL_MS`) and route all metadata enrichment through `/api/enrich` (Wikidata, MusicBrainz, Last.fm). Never hardcode static artist lookup tables.
3. **100% Opaque Celestial Bodies & Non-Glowing Central Planets:** Central cluster planets (`solarPlasmaShader.js`), artist planets, and faceted crystal song moons (`planetShader.js`) render as solid 3D bodies (`transparent: false, depthWrite: true`) with `BLOOM_STRENGTH = 0.0`, `NEBULA_OPACITY = 0.0`, and no additive glow sprites washing out labels.
4. **Black Silhouette Borders on Light-Colored Clusters:** Light-colored clusters render with a crisp screen-space black outline (`fwidth(radial)` in `planetShader.js` and `solarPlasmaShader.js`, plus dark borders on `.cluster-swatch`, `.label-dot`, and `.chip-dot`) so overlapping spheres and crystals stay distinct.
5. **Strict Lens & Focus Culling (Zero Orphan Lines or Labels):** When a Time/Memory Lens is active, non-matching artists and tracks are culled (`focusTarget = 0, lensScale = 0`), edges only render when both endpoints are lit (`focusTarget >= 0.65`), and `LabelProjector` never shows labels for unlit or non-matching nodes.
6. **3D Collision Clearance:** Always run `resolveClusterArtistOverlaps` and `resolveArtistCollisions` after UMAP placement, accounting for each planet's radius plus its moon orbital shell (`r_planet + r_moons + padding`).

---

## Getting Started

### Prerequisites

* Node.js (v18 or higher)
* A [Spotify Developer Application](https://developer.spotify.com/dashboard) (optional if only exploring imported Extended Streaming History JSON files)
* (Optional) A Last.fm API Key (`LASTFM_API_KEY`) for expanded community genre tags

### Local Setup

1. **Clone the repository and install dependencies:**
   ```bash
   git clone https://github.com/your-username/spotify.git
   cd spotify
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and fill in your credentials:
   ```env
   SPOTIFY_CLIENT_ID=your_spotify_client_id
   SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
   SESSION_SECRET=a_random_long_session_string
   LASTFM_API_KEY=your_optional_lastfm_key
   PORT=5173
   ```

3. **Configure Spotify Dashboard Redirect URIs:**
   Inside your [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) app settings:
   * Local development: `http://127.0.0.1:5173/api/auth/callback`
   * Production: `https://<your-vercel-domain>.vercel.app/api/auth/callback`
   *(Note: Spotify rejects `localhost` over HTTP; always use `127.0.0.1`.)*

4. **Run the local development server:**
   ```bash
   npm run dev
   ```
   Open `http://127.0.0.1:5173` in your browser.

---

## Deploying

The project deploys to Vercel as-is. `vercel.json` routes `/api/*` to the Express backend in `api/index.js`, and the Vite build output (`dist/`) is served statically. Set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SESSION_SECRET`, and optionally `LASTFM_API_KEY` as environment variables in your Vercel Project Settings.
