// src/ui/hudController.js
import { SPOTIFY_LOGIN_URL, logout } from '../api/backendClient.js';
import { parseStreamingHistoryJson } from '../etl/streamingHistoryParser.js';

export class HudController {
  constructor(appState, callbacks) {
    this.state = appState;
    this.cb = callbacks;

    this.initSearch();
    this.initLayerToggles();
    this.initPhysicsControls();
    this.initAutoPilot();
    this.initCinemaRecorder();
    this.initTimeMachine();
    this.initModals();
  }

  initSearch() {
    const input = document.getElementById('galaxy-search-input');
    const resultsContainer = document.getElementById('search-results-dropdown');

    if (!input || !resultsContainer) return;

    input.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      if (!query) {
        resultsContainer.innerHTML = '';
        resultsContainer.classList.remove('active');
        return;
      }

      const matches = this.state.nodes.filter(n =>
        n.name.toLowerCase().includes(query)
      ).slice(0, 8);

      resultsContainer.innerHTML = '';
      if (matches.length === 0) {
        resultsContainer.innerHTML = '<div class="search-item empty">No celestial bodies found</div>';
      } else {
        matches.forEach(node => {
          const item = document.createElement('div');
          item.className = 'search-item';
          item.innerHTML = `
            <span class="search-item-dot" style="background:${node.color}"></span>
            <span class="search-item-name">${node.name}</span>
            <span class="search-item-type">${node.type.toUpperCase()}</span>
          `;
          item.addEventListener('click', () => {
            input.value = '';
            resultsContainer.innerHTML = '';
            resultsContainer.classList.remove('active');
            this.cb.onSelectNode(node);
          });
          resultsContainer.appendChild(item);
        });
      }
      resultsContainer.classList.add('active');
    });

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !resultsContainer.contains(e.target)) {
        resultsContainer.classList.remove('active');
      }
    });
  }

  initLayerToggles() {
    const toggles = [
      { id: 'toggle-genres', layer: 'genres' },
      { id: 'toggle-artists', layer: 'artists' },
      { id: 'toggle-tracks', layer: 'tracks' },
      { id: 'toggle-edges', layer: 'edges' },
      { id: 'toggle-labels', layer: 'labels' }
    ];

    toggles.forEach(({ id, layer }) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', (e) => {
          this.state.layers[layer] = e.target.checked;
          this.cb.onLayerVisibilityChange(layer, e.target.checked);
        });
      }
    });
  }

  initPhysicsControls() {
    // Layout Mode (Force vs Rings)
    const layoutToggle = document.getElementById('layout-mode-toggle');
    if (layoutToggle) {
      layoutToggle.addEventListener('click', () => {
        const nextMode = this.state.layoutMode === 'force' ? 'rings' : 'force';
        this.state.layoutMode = nextMode;
        layoutToggle.textContent = nextMode === 'force' ? 'GALAXY CLUSTERS' : 'ASTRONOMICAL RINGS';
        layoutToggle.classList.toggle('active', nextMode === 'rings');
        this.cb.onLayoutModeChange(nextMode);
      });
    }

    // Orbit Speed Slider
    const orbitSlider = document.getElementById('orbit-speed-slider');
    const orbitVal = document.getElementById('orbit-speed-val');
    if (orbitSlider) {
      orbitSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.state.orbitSpeedMultiplier = val;
        if (orbitVal) orbitVal.textContent = `${val.toFixed(1)}x`;
        this.cb.onOrbitSpeedChange(val);
      });
    }

    // Node Scale Slider
    const scaleSlider = document.getElementById('node-scale-slider');
    const scaleVal = document.getElementById('node-scale-val');
    if (scaleSlider) {
      scaleSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.state.nodeScaleMultiplier = val;
        if (scaleVal) scaleVal.textContent = `${val.toFixed(1)}x`;
        this.cb.onNodeScaleChange(val);
      });
    }

    // Reset Overview
    const resetBtn = document.getElementById('reset-camera-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.cb.onResetCamera());
    }
  }

  initAutoPilot() {
    const btn = document.getElementById('auto-pilot-btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const active = !this.state.autoPilotActive;
      this.state.autoPilotActive = active;
      btn.classList.toggle('active', active);
      btn.querySelector('.btn-text').textContent = active ? 'Tour Active' : 'Auto-Pilot Tour';
      this.cb.onAutoPilotToggle(active);
    });
  }

  initCinemaRecorder() {
    const btn = document.getElementById('cinema-record-btn');
    const progressEl = document.getElementById('cinema-recording-progress');
    const progressBar = document.getElementById('cinema-progress-bar');

    if (!btn) return;

    btn.addEventListener('click', () => {
      btn.disabled = true;
      if (progressEl) progressEl.style.display = 'block';

      this.cb.onStartCinemaRecording(
        (pct) => {
          if (progressBar) progressBar.style.width = `${pct}%`;
        },
        () => {
          btn.disabled = false;
          if (progressEl) progressEl.style.display = 'none';
          if (progressBar) progressBar.style.width = '0%';
        }
      );
    });
  }

  initTimeMachine() {
    const slider = document.getElementById('time-machine-slider');
    const dateLabel = document.getElementById('time-machine-date-label');
    const playBtn = document.getElementById('time-machine-play-btn');

    let isPlayingTimeline = false;
    let timer = null;

    if (slider) {
      slider.addEventListener('input', (e) => {
        const u = parseFloat(e.target.value);
        const dateStr = this.cb.onTimeScrub(u);
        if (dateLabel && dateStr) dateLabel.textContent = dateStr;
      });
    }

    if (playBtn) {
      playBtn.addEventListener('click', () => {
        isPlayingTimeline = !isPlayingTimeline;
        playBtn.classList.toggle('active', isPlayingTimeline);
        playBtn.textContent = isPlayingTimeline ? 'Pause' : 'Play Time-Lapse';

        if (isPlayingTimeline) {
          timer = setInterval(() => {
            let u = parseFloat(slider.value) + 0.01;
            if (u > 1.0) u = 0.0;
            slider.value = u;
            const dateStr = this.cb.onTimeScrub(u);
            if (dateLabel && dateStr) dateLabel.textContent = dateStr;
          }, 60);
        } else {
          if (timer) clearInterval(timer);
        }
      });
    }
  }

  initModals() {
    // Spotify Connect Modal
    const spotifyModal = document.getElementById('spotify-modal');
    const openSpotifyModalBtn = document.getElementById('open-spotify-modal-btn');
    const closeSpotifyModalBtn = document.getElementById('close-spotify-modal-btn');
    const spotifyLoginBtn = document.getElementById('spotify-login-btn');
    const copyRedirectBtn = document.getElementById('copy-redirect-uri-btn');
    const redirectUriDisplay = document.getElementById('spotify-redirect-uri-display');

    if (copyRedirectBtn && redirectUriDisplay) {
      copyRedirectBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(redirectUriDisplay.value);
        } catch {
          redirectUriDisplay.select();
          document.execCommand('copy');
        }
        copyRedirectBtn.textContent = 'Copied!';
        setTimeout(() => { copyRedirectBtn.textContent = 'Copy URI'; }, 2000);
      });
    }

    if (openSpotifyModalBtn && spotifyModal) {
      openSpotifyModalBtn.addEventListener('click', async () => {
        if (this.needsReconnect()) {
          // Logging in again grants the newly required scopes.
          window.location.href = SPOTIFY_LOGIN_URL;
          return;
        }
        if (this.state.spotifyConnected) {
          if (confirm('You are currently connected to Spotify. Disconnect?')) {
            await logout().catch(err => console.warn('Logout failed:', err));
            this.setSpotifyConnected(false);
            this.cb.onLoadPreset('cosmic_synth');
          }
          return;
        }
        spotifyModal.classList.add('active');
      });
    }

    if (closeSpotifyModalBtn && spotifyModal) {
      closeSpotifyModalBtn.addEventListener('click', () => spotifyModal.classList.remove('active'));
    }

    if (spotifyLoginBtn) {
      spotifyLoginBtn.addEventListener('click', () => {
        if (!this.authStatus?.configured) {
          alert(this.authStatus?.backendUnavailable
            ? 'The ASTRA backend is not running. Start it with `npm run dev`.'
            : 'The backend is missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Add them to .env and restart.');
          return;
        }
        window.location.href = SPOTIFY_LOGIN_URL;
      });
    }

    // Extended JSON Archive Upload Modal
    const uploadModal = document.getElementById('upload-modal');
    const openUploadModalBtn = document.getElementById('open-upload-modal-btn');
    const closeUploadModalBtn = document.getElementById('close-upload-modal-btn');
    const fileInput = document.getElementById('json-file-input');

    if (openUploadModalBtn && uploadModal) {
      openUploadModalBtn.addEventListener('click', () => uploadModal.classList.add('active'));
    }

    if (closeUploadModalBtn && uploadModal) {
      closeUploadModalBtn.addEventListener('click', () => uploadModal.classList.remove('active'));
    }

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const { dataset, rawEvents } = parseStreamingHistoryJson(event.target.result);
            this.cb.onCustomHistoryLoaded(dataset, rawEvents);
            uploadModal.classList.remove('active');
            alert(`Loaded ${dataset.artists.length} artists and ${dataset.tracks.length} tracks from your Spotify archive!`);
          } catch (err) {
            alert(`Error parsing JSON archive: ${err.message}`);
          }
        };
        reader.readAsText(file);
      });
    }

    // Multiplayer Collision Modal
    const collisionModal = document.getElementById('collision-modal');
    const openCollisionBtn = document.getElementById('open-collision-modal-btn');
    const closeCollisionBtn = document.getElementById('close-collision-modal-btn');
    const triggerCollisionBtn = document.getElementById('trigger-collision-btn');
    const selectGalaxyA = document.getElementById('collision-select-a');
    const selectGalaxyB = document.getElementById('collision-select-b');

    if (openCollisionBtn && collisionModal) {
      openCollisionBtn.addEventListener('click', () => collisionModal.classList.add('active'));
    }

    if (closeCollisionBtn && collisionModal) {
      closeCollisionBtn.addEventListener('click', () => collisionModal.classList.remove('active'));
    }

    if (triggerCollisionBtn) {
      triggerCollisionBtn.addEventListener('click', () => {
        const idA = selectGalaxyA?.value || 'cosmic_synth';
        const idB = selectGalaxyB?.value || 'lofi_indie';
        this.cb.onTriggerCollision(idA, idB);
        collisionModal.classList.remove('active');
      });
    }
  }

  /** Lists clusters (suns) largest first; clicking one flies to it. */
  renderClusterLegend(suns) {
    const list = document.getElementById('cluster-legend-list');
    if (!list) return;
    list.innerHTML = '';
    suns
      .slice()
      .sort((a, b) => (b.neighbors?.size || 0) - (a.neighbors?.size || 0))
      .forEach(sun => {
        const li = document.createElement('li');
        li.className = 'cluster-legend-item';
        li.tabIndex = 0;
        li.innerHTML = `
          <span class="legend-swatch" style="background:${sun.color}; box-shadow: 0 0 10px ${sun.color}"></span>
          <span class="legend-text">
            <span class="legend-name"></span>
            <span class="legend-sub"></span>
          </span>
          <span class="legend-count">${sun.neighbors?.size || 0}</span>`;
        li.querySelector('.legend-name').textContent = sun.name;
        // Top artists say more about a cluster than repeating its genre names.
        li.querySelector('.legend-sub').textContent = (sun.topArtists || sun.subgenres || []).slice(0, 3).join(' · ') || sun.familyLabel || '';
        const select = () => this.cb.onSelectNode(sun);
        li.addEventListener('click', select);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(); });
        list.appendChild(li);
      });
  }

  setAuthStatus(status) {
    this.authStatus = status;
    const redirectUriDisplay = document.getElementById('spotify-redirect-uri-display');
    if (redirectUriDisplay && status.redirectUri) redirectUriDisplay.value = status.redirectUri;
    this.setSpotifyConnected(status.loggedIn);
  }

  needsReconnect() {
    return Boolean(this.state.spotifyConnected && this.authStatus?.missingScopes?.length);
  }

  setSpotifyConnected(connected) {
    this.state.spotifyConnected = connected;
    const btn = document.getElementById('open-spotify-modal-btn');
    if (btn) btn.textContent = !connected ? 'CONNECT SPOTIFY' : (this.needsReconnect() ? 'RECONNECT SPOTIFY' : 'SPOTIFY CONNECTED');
  }

  showCollisionBanner(metrics) {
    const banner = document.getElementById('collision-resonance-banner');
    if (!banner) return;

    banner.innerHTML = `
      <div class="resonance-score-badge">
        <span class="score-number">${metrics.resonanceScore}%</span>
        <span class="score-label">COSMIC RESONANCE</span>
      </div>
      <div class="resonance-details">
        <div>Shared Celestial Bodies: <strong>${metrics.sharedCount}</strong> (Lagrange Bridge)</div>
        <div>Artist Jaccard: <strong>${metrics.jaccardArtists}%</strong> | Genre Jaccard: <strong>${metrics.jaccardGenres}%</strong></div>
        <div>5D Audio DNA Cosine Similarity: <strong>${metrics.cosineSim}%</strong></div>
      </div>
      <button id="close-resonance-banner" class="hud-btn-mini">&times;</button>
    `;
    banner.style.display = 'flex';

    banner.querySelector('#close-resonance-banner')?.addEventListener('click', () => {
      banner.style.display = 'none';
    });
  }
}
