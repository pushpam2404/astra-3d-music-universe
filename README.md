# ASTRA // 3D Interactive Music Universe 🌌

An interactive 3D WebGL observatory and sonic telemetry application that transforms a user's flat Spotify listening history into a living, revolving celestial universe of **Genre Suns**, **Artist Planets**, and **Track Satellites**.

Powered by **Three.js**, custom **GLSL shaders**, and a zero-dependency **Web Audio API** polyphonic synthesizer.

---

## 🌟 Key Features

### 1. Tri-Tiered Celestial Graph Architecture
- **Galactic Suns (Genres):** Massive glowing stars orbiting at the core, rendered with turbulent **3D Simplex noise GLSL plasma vertex displacement** and double Saturn rings.
- **Planetary Bodies (Artists):** Medium spheres with **Fresnel atmospheric rim lighting**, gravitationally tethered via Hooke's law springs to one or more genre suns (multi-genre artists naturally form suspension bridges).
- **Lunar Satellites (Tracks):** Crisp emerald satellites revolving around their parent artist planet with harmonic vertical oscillations and collaboration blending.

### 2. Base-10 Logarithmic Normalization
Music streaming data strictly follows Zipf's power law ($P(k) \propto k^{-\alpha}$). ASTRA applies per-tier Base-10 logarithmic scaling to physical radii, preventing top artists from visually swallowing the 3D viewport while keeping niche discoveries distinct:
$$s_v = \frac{\log_{10}(c_v + 1) - \log_{10}(c_{\min, T} + 1)}{\log_{10}(c_{\max, T} + 1) - \log_{10}(c_{\min, T} + 1) + \epsilon}$$

### 3. Hybrid Force-Directed + Keplerian Orbital Physics
- **Hooke's Law Spring Attraction:** Dynamically draws artists toward their associated genre clusters.
- **Pairwise Coulomb Repulsion:** Prevents planetary bodies from colliding.
- **Keplerian Tangential Swirl:** Keeps the galaxy in perpetual, graceful orbital motion.
- **Concentric Astronomical Rings Mode:** Toggleable layout aligning bodies into ordered orbital planes.

### 4. Procedural Web Audio API Sonic DNA Synthesizer
Zero external audio files required. Translates Spotify Audio Features into real-time polyphonic arpeggios:
- **`valence` (Mood):** Modulates modal scales — **Lydian** ($\ge 0.60$, cosmic euphoria), **Dorian** ($0.45 - 0.60$, contemplative), or **Aeolian** ($< 0.45$, nocturnal).
- **`energy`:** Modulates oscillator waveform and Biquad Lowpass filter cutoff ($f_{\text{cutoff}} = 450 + 2600 \cdot \text{energy}\text{ Hz}$).
- **`tempo`:** Sets the arpeggiation clock interval.
- **Live FFT Spectrum Visualizer:** Real-time frequency response rendered directly onto the glassmorphic HUD.

### 5. Multiplayer Galaxy Collision & Compatibility Engine
- Simulates a **Binary Star Merger** between two music profiles (Cyan Galaxy Alpha vs Magenta Galaxy Beta).
- Shared artists and genres naturally get pulled by dual-gravity into the **$L_1$ Lagrange Wormhole Bridge** at $(0, 0, 0)$, igniting with a Golden Supernova aura.
- Computes an astrophysical **Cosmic Resonance Score** using Weighted Jaccard Similarity and 5D Audio DNA Cosine Similarity.

### 6. 4D Chronological Time-Machine Scrubber
- Evaluates multi-year Spotify streaming archives across continuous time using a causal exponential half-life decay kernel ($\tau_{1/2} = 90\text{ days}$):
  $$W_v(t) = \sum_{t_k \le t} \exp\left( -\lambda(t - t_k) \right)$$
- Watch newly discovered stars ignite while dormant artists gradually cool in emissive intensity and drift to outer orbits.

### 7. Automated 60 FPS Cinema Director & Video Exporter
- Computes smooth **Catmull-Rom cubic spline camera trajectories** passing through orbital vantage points.
- Records live 60 FPS WebGL canvas frames alongside the synthesized audio stream, muxing and downloading a `.webm` cinematic video directly in the browser.

### 8. Stateless OAuth 2.0 PKCE & GDPR Archive Ingestion
- Zero backend server required. Uses SHA-256 PKCE authorization with Spotify.
- Automatically resolves the missing track-to-genre link via parallel transitive batch lookups (`/v1/artists?ids=...`).
- Fully supports drag-and-drop offline ingestion of GDPR `StreamingHistory_music_*.json` and `endsong_*.json` archives.

---

## 🚀 Quick Start

### Prerequisites
- Node.js (v18+) & npm

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/pushpam2404/astra-3d-music-universe.git
cd astra-3d-music-universe

# Install dependencies (three, vite)
npm install

# Start local development server
npm run dev
```

Open **`http://localhost:5173/`** in your browser.

---

## 🔑 Connecting Your Live Spotify Account

ASTRA works out of the box with rich curated galaxies (**Cosmic Synth**, **Neo-Psychedelia**, and **Drum & Bass**). To visualize your personal Spotify listening history:

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and click **Create App**.
2. Fill in:
   - **App Name:** `ASTRA 3D Universe`
   - **Redirect URI:** `http://localhost:5173/` (and optionally `http://127.0.0.1:5173/`)
   - **APIs used:** Select **Web API**
3. Save and copy your **Client ID**.
4. Open the app at `http://localhost:5173/`, click **CONNECT SPOTIFY** in the top navigation bar, paste your Client ID, and click **Authorize & Connect**.

---

## 📁 Repository Blueprint Index

Detailed architectural specifications and mathematical proofs can be found in the [`docs/`](docs/) directory:

- [**00 — Master Project Roadmap & Index**](docs/00_master_project_roadmap_architecture_index.md)
- [**01 — System Architecture & 5-Layer Blueprint**](docs/01_system_architecture_engineering_blueprint.md)
- [**02 — Spotify OAuth 2.0 PKCE & ETL Data Pipeline**](docs/02_spotify_auth_etl_data_pipeline.md)
- [**03 — Graph Topology & Mathematical Logarithmic Scaling**](docs/03_graph_topology_mathematical_scaling.md)
- [**04 — 3D Force-Directed Physics & Three.js Engine**](docs/04_3d_force_physics_three_js_engine.md)
- [**05 — Procedural Web Audio API Sonic DNA Synthesizer**](docs/05_web_audio_api_sonic_dna_synthesizer.md)
- [**06 — Scaling to 10,000+ Nodes & Production Deployment**](docs/06_scaling_to_10_000_nodes_deployment_guide.md)
- [**07 — Custom GLSL Shaders & Hyperspace Post-Processing**](docs/07_custom_glsl_shaders_hyperspace_post_processing.md)
- [**08 — Multiplayer Galaxy Collision & Compatibility Engine**](docs/08_multiplayer_galaxy_collision_compatibility_engine.md)
- [**09 — 4D Time-Machine Scrubber & Cinema Director Export**](docs/09_4d_time_machine_scrubber_cinema_director_export.md)

---

## 🛠️ Tech Stack

- **Graphics & Rendering:** [Three.js](https://threejs.org/) (WebGL), Custom GLSL (Simplex Noise, Fresnel Rim Glow, ACESFilmic Tone Mapping, UnrealBloomPass)
- **Audio Synthesis:** Web Audio API (`AudioContext`, `BiquadFilterNode`, `AnalyserNode`, `GainNode`)
- **UI & Styling:** Vanilla CSS3 Glassmorphism (`backdrop-filter`), Responsive CSS Grid / Flexbox
- **Tooling & Build:** [Vite](https://vitejs.dev/)

---

## 📄 License

MIT License. Designed and engineered for exploring musical universes in 3D space.
