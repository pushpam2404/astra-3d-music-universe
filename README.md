# Astra

Your Spotify listening, mapped as a living 3D celestial universe. Genres form solar nebulae, artists orbit as planets, and individual tracks circle them as moons. Artists that share acoustic similarities, collaborations, or listening sessions gravitate into the same cluster regardless of language.

Live: https://astra-3d-music-universe.vercel.app

---

## Highlights

* **Dual Ingestion (Spotify Web API & Extended Streaming History):** Connect your Spotify account to map your top artists/tracks, recent plays, and Liked Songs. Import standard `StreamingHistory_music_*.json` or Spotify Extended Streaming History (`Streaming_History_Audio_*.json` / `endsong_*.json`) directly from your browser to visualize years of listening data without hitting file-size limits.
* **Sound-Based & Acoustic Community Clustering:** Because Spotify no longer exposes genre tags directly for all endpoints, Astra enriches artist data via Wikidata, MusicBrainz, and Last.fm. Communities are grouped via Louvain modularity and embedded in 3D using UMAP dimensionality reduction with collaboration graph weighting.
* **Temporal & Memory Lenses:** Filter the 3D cosmos through time capsules and listening habits: *All time*, *Past favorites*, *Haven’t heard in a while*, *Current rotation*, *All-time staples*, or specific years (`2020` through `2026`).
* **Focused Artist Isolation Mode:** Selecting an artist illuminates that artist, their tracks, and their direct collaborators while fading or culling unrelated clusters, suns, and moons to preserve visual clarity.
* **Collision-Free Celestial Layout:** Clusters maintain balanced breathing room using pairwise spherical clearance, and planet-to-planet overlapping is resolved using a 3D spatial hash collision pass.
* **Export & Snapshot Portability:** Export your fully computed galaxy layout as an Astra Universe Snapshot (`.json`) for instant re-import without re-clustering, or export an aggregated listening summary as a `.csv`.

---

## System Architecture

```text
┌────────────────────────────────────────────────────────┐
│                        Browser                         │
│  Three.js Scene + Camera + Instanced Meshes + Labels   │
│  UI (HUD, History Modal, Time Capsule & Memory Lenses) │
│  Universe Assembler (Isomorphic UMAP & Louvain Engine) │
│  Client-Side Storage (IndexedDB + localStorage Cache)  │
└───────────────▲────────────────────────▲───────────────┘
                │                        │
       Cached API Signals         Batched /api/enrich (50 artists)
                │                        │
┌───────────────▼────────────────────────▼───────────────┐
│                    Express Backend                     │
│               Vercel Serverless Function               │
│                                                        │
│  /api/auth/*     Spotify OAuth PKCE Login              │
│  /api/universe   Signals-Only / Live Top & Liked Data  │
│  /api/enrich     Wikidata, MusicBrainz, Last.fm lookup │
└────────────────────────────────────────────────────────┘
```

---

## Getting Started

### Prerequisites

* Node.js (v18 or higher)
* A [Spotify Developer Application](https://developer.spotify.com/dashboard)
* (Optional) A Last.fm API Key for accelerated genre enrichment

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
   *(Note: Spotify rejects `localhost`; use `127.0.0.1`)*

4. **Run the local development server:**
   ```bash
   npm run dev
   ```
   Open `http://127.0.0.1:5173` in your browser.

---

## Deploying

The project deploys to Vercel as-is. `vercel.json` routes `/api/*` to the Express backend in `api/index.js`, and the Vite build is served statically. Set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SESSION_SECRET`, and optionally `LASTFM_API_KEY` as environment variables in your Vercel Project Settings.
