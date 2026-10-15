// src/ui/hud.js
/**
 * Everything around the galaxy: top bar (search, view settings, Spotify), the side
 * panel (cluster list ⇄ details; one slot, never both), the caption and loading state.
 */
import { SPOTIFY_LOGIN_URL, logout } from '../api/backendClient.js';

const KIND_LABEL = { genre: 'Cluster', artist: 'Artist', track: 'Song' };
const KIND_ORDER = { genre: 0, artist: 1, track: 2 };
const MAX_RESULTS = 12;

const $ = (id) => document.getElementById(id);

export class Hud {
  /**
   * @param {object} state  AppState (layers, nodes)
   * @param {object} cb     { onSelectNode, onBack, onResetCamera, onLayersChange, onOrbitSpeed, onNodeScale, onDisconnected }
   */
  constructor(state, cb) {
    this.state = state;
    this.cb = cb;
    this.authStatus = null;
    this.initSearch();
    this.initViewPanel();
    this.initSidePanel();
    this.initSpotifyButton();
    $('reset-camera-btn').addEventListener('click', () => this.cb.onResetCamera());
  }

  /* ---------- Search ---------- */

  initSearch() {
    const input = $('search-input');
    const list = $('search-results');
    let results = [];
    let active = -1;

    const close = () => {
      list.hidden = true;
      active = -1;
    };
    const choose = (node) => {
      input.value = '';
      close();
      input.blur();
      this.cb.onSelectNode(node);
    };
    const highlight = () => {
      [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    };

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) return close();
      results = this.state.nodes
        .filter(n => n.name?.toLowerCase().includes(q))
        .sort((a, b) =>
          (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1)
          || KIND_ORDER[a.type] - KIND_ORDER[b.type]
          || (b.plays || 0) - (a.plays || 0))
        .slice(0, MAX_RESULTS);
      list.replaceChildren(...(results.length ? results.map(n => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        const dot = document.createElement('span');
        dot.className = 'chip-dot';
        dot.style.background = n.color;
        const name = document.createElement('span');
        name.textContent = n.name;
        const kind = document.createElement('span');
        kind.className = 'result-kind';
        kind.textContent = KIND_LABEL[n.type];
        li.append(dot, name, kind);
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(n);
        });
        return li;
      }) : [Object.assign(document.createElement('li'), { textContent: 'Nothing by that name in your universe' })]));
      list.hidden = false;
      active = results.length ? 0 : -1;
      highlight();
    });

    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!results.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        highlight();
      } else if (e.key === 'Enter' && results[active]) {
        choose(results[active]);
      } else if (e.key === 'Escape') {
        close();
      }
    });
    input.addEventListener('blur', close);
  }

  /* ---------- View settings ---------- */

  initViewPanel() {
    const btn = $('view-toggle-btn');
    const panel = $('view-panel');
    const setOpen = (open) => {
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', () => setOpen(panel.hidden));
    document.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });

    ['genres', 'artists', 'tracks', 'edges', 'labels'].forEach(layer => {
      $(`toggle-${layer}`).addEventListener('change', (e) => {
        this.state.layers[layer] = e.target.checked;
        this.cb.onLayersChange();
      });
    });

    $('orbit-speed-slider').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $('orbit-speed-val').textContent = v === 0 ? 'paused' : `${v}×`;
      this.cb.onOrbitSpeed(v);
    });
    $('node-scale-slider').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $('node-scale-val').textContent = `${v}×`;
      this.cb.onNodeScale(v);
    });
  }

  /* ---------- Side panel ---------- */

  initSidePanel() {
    $('detail-back-btn').addEventListener('click', () => this.cb.onBack());
  }

  showClusters() {
    $('detail-view').hidden = true;
    $('cluster-view').hidden = false;
  }

  showDetails() {
    $('cluster-view').hidden = true;
    $('detail-view').hidden = false;
  }

  /** Clusters, largest first; clicking one flies to it and opens its details. */
  renderClusters(suns) {
    const list = $('cluster-list');
    list.replaceChildren(...suns
      .slice()
      .sort((a, b) => (b.neighbors?.size || 0) - (a.neighbors?.size || 0))
      .map(sun => {
        const li = document.createElement('li');
        li.className = 'cluster-item';
        li.tabIndex = 0;
        const swatch = document.createElement('span');
        swatch.className = 'cluster-swatch';
        swatch.style.background = sun.color;
        swatch.style.boxShadow = `0 0 10px ${sun.color}`;
        const text = document.createElement('span');
        const name = document.createElement('span');
        name.className = 'cluster-name';
        name.textContent = sun.name;
        const sub = document.createElement('span');
        sub.className = 'cluster-sub';
        // Top artists say more about a cluster than repeating its genre names.
        sub.textContent = (sun.topArtists || sun.subgenres || []).slice(0, 3).join(', ');
        text.append(name, sub);
        const count = document.createElement('span');
        count.className = 'cluster-count';
        count.textContent = sun.neighbors?.size || 0;
        count.title = 'Artists';
        li.append(swatch, text, count);
        const select = () => this.cb.onSelectNode(sun);
        li.addEventListener('click', select);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(); });
        return li;
      }));
  }

  /* ---------- Caption, notice, loading ---------- */

  setCaption(title, stats) {
    $('universe-title').textContent = title;
    $('universe-stats').textContent = stats || '';
  }

  /** One short line under the caption; `action` = { label, run } adds a link-style button. */
  setNotice(text, action) {
    const notice = $('universe-notice');
    if (!text) {
      notice.hidden = true;
      return;
    }
    notice.replaceChildren(document.createTextNode(`${text} `));
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', action.run);
      notice.append(btn);
    }
    notice.hidden = false;
  }

  setLoading(loading) {
    $('loading-overlay').hidden = !loading;
  }

  /* ---------- Spotify ---------- */

  initSpotifyButton() {
    $('spotify-btn').addEventListener('click', async () => {
      const status = this.authStatus || {};
      if (!status.configured) {
        $('setup-redirect-uri').textContent = status.redirectUri || `${location.origin}/api/auth/callback`;
        $('setup-dialog').showModal();
        return;
      }
      if (!status.loggedIn || this.needsReconnect()) {
        window.location.href = SPOTIFY_LOGIN_URL;
        return;
      }
      if (confirm('Disconnect Spotify from Astra on this browser?')) {
        await logout().catch(() => {});
        this.setAuthStatus({ ...status, loggedIn: false, missingScopes: [] });
        this.cb.onDisconnected();
      }
    });
  }

  needsReconnect() {
    return Boolean(this.authStatus?.loggedIn && this.authStatus?.missingScopes?.length);
  }

  setAuthStatus(status) {
    this.authStatus = status;
    const btn = $('spotify-btn');
    btn.classList.toggle('is-connected', Boolean(status.loggedIn) && !this.needsReconnect());
    btn.classList.toggle('needs-reconnect', this.needsReconnect());
    btn.textContent = !status.loggedIn ? 'Connect Spotify' : (this.needsReconnect() ? 'Reconnect Spotify' : 'Spotify');
    btn.title = status.loggedIn && !this.needsReconnect() ? 'Connected. Click to disconnect.' : '';
  }
}
