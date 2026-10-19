// src/ui/hud.js
/**
 * Everything around the galaxy: top bar (search, History import/export/source-toggle,
 * view settings, Spotify), the Time & Memory Lens bar, mobile camera controls,
 * the side panel (Clusters | Memories | Songs ⇄ Details), the caption, enrichment
 * status counter, and loading state.
 */
import { SPOTIFY_LOGIN_URL, logout } from '../api/backendClient.js';
import { nodeMatchesLens } from '../renderer/celestialFactory.js';
import { itemMetaLabel } from './detailPanel.js';
import {
  springIn,
  animateDialogIn,
  animateDialogOut,
  transitionViews,
  staggerRevealItems,
  attachPressFeedback
} from './motionFx.js';

const KIND_LABEL = { genre: 'Cluster', artist: 'Artist', track: 'Song' };
const KIND_ORDER = { genre: 0, artist: 1, track: 2 };
const MAX_RESULTS = 14;

const LENS_DESCRIPTIONS = {
  all: null,
  past_fav: 'Showing Past Favorites — songs & artists you played heavily in past eras but rarely recently.',
  dormant: 'Showing Dormant Gems — loved songs & artists you haven’t played in 4+ months.',
  current_rotation: 'Showing Current Rotation — actively played in the last 60 days or top charts.',
  all_time_staple: 'Showing All-Time Staples — played consistently across 3+ years.',
  era_2026: 'Showing 2026 Era — music shaping your 2026 listening.',
  early_2025: 'Showing Early 2025 Era — songs and artists that peaked in Jan–Apr 2025.',
  era_2025: 'Showing 2025 Era — songs and artists heavily played in 2025.',
  early_2024: 'Showing Early 2024 Era — songs and artists that peaked in Jan–Apr 2024.',
  era_2024: 'Showing 2024 Era — songs and artists heavily played in 2024.',
  era_2023: 'Showing 2023 Era — songs and artists heavily played in 2023.',
  era_2020_2022: 'Showing 2020–2022 Era — your earliest recorded Spotify years.'
};

const $ = (id) => document.getElementById(id);

/**
 * Updates the exact "Pending vs. Newly Enriched on Reload" HUD counter banner.
 * Distinguishes between artists still waiting to be checked (`waitingCount`) and
 * artists whose genres were newly resolved in the background (`readyOnReloadCount`).
 */
export function updateEnrichmentStatus({ waitingCount = 0, readyOnReloadCount = 0, onApply = null } = {}) {
  const statusEl = document.getElementById('enrichment-status-banner');
  if (!statusEl) return;

  if (waitingCount === 0 && readyOnReloadCount === 0) {
    statusEl.hidden = true;
    statusEl.innerHTML = '';
    return;
  }

  statusEl.hidden = false;
  if (waitingCount > 0) {
    statusEl.innerHTML = `
      <span class="status-pulse-dot" aria-hidden="true"></span>
      <span><strong>${waitingCount.toLocaleString()}</strong> artists waiting for info · 
      <strong>+${readyOnReloadCount.toLocaleString()}</strong> new artists ready on reload</span>
      ${readyOnReloadCount > 0 ? '<button type="button" class="pill-action" data-enrich-reload>Apply now</button>' : ''}
    `;
  } else {
    statusEl.innerHTML = `
      <span class="status-pulse-dot is-ready" aria-hidden="true"></span>
      <span>All artists checked · <strong>+${readyOnReloadCount.toLocaleString()}</strong> new artists ready</span>
      <button type="button" class="pill-action" data-enrich-reload>Reload to apply</button>
    `;
  }

  const btn = statusEl.querySelector('[data-enrich-reload]');
  if (btn) {
    btn.onclick = typeof onApply === 'function' ? onApply : () => window.location.reload();
  }
}

export class Hud {
  /**
   * @param {object} state  AppState (layers, nodes, activeLens, spotifyApiOnly)
   * @param {object} cb     callbacks
   */
  constructor(state, cb) {
    this.state = state;
    this.cb = cb;
    this.authStatus = null;
    this.activeTab = 'clusters'; // 'clusters' | 'memories' | 'songs'
    this.suns = [];
    this.initSearch();
    this.initViewPanel();
    this.initLensBar();
    this.initMobileCamControls();
    this.initSidePanel();
    this.initHistoryDialog();
    this.initSpotifyButton();
    $('reset-camera-btn').addEventListener('click', () => this.cb.onResetCamera());
    setTimeout(() => {
      attachPressFeedback('.btn, .lens-pill, .panel-tab, .mini-pill, .sub-tab, .cam-ctrl-btn, .pill-action');
    }, 150);
  }

  /* ---------- Mobile Camera Quick Controls ---------- */

  initMobileCamControls() {
    $('cam-zoom-in-btn')?.addEventListener('click', () => this.cb.onZoomStep?.(0.7));
    $('cam-zoom-out-btn')?.addEventListener('click', () => this.cb.onZoomStep?.(1.4));
    $('cam-reset-btn')?.addEventListener('click', () => this.cb.onResetCamera?.());
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
        .filter(n => {
          if (n.meshGroup?.visible === false) return false;
          if (n.name?.toLowerCase().includes(q)) return true;
          if (n.connectedArtists?.[0]?.toLowerCase().includes(q)) return true;
          if (n.history?.peakEra?.toLowerCase().includes(q)) return true;
          if (n.history?.statusLabel?.toLowerCase().includes(q)) return true;
          if (q === 'dormant' && n.history?.tags?.includes('dormant')) return true;
          if ((q === 'past' || q === 'past fav' || q === 'favorite') && n.history?.tags?.includes('past_fav')) return true;
          return false;
        })
        .sort((a, b) =>
          (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1)
          || KIND_ORDER[a.type] - KIND_ORDER[b.type]
          || (b.history?.plays || b.plays || 0) - (a.history?.plays || a.plays || 0))
        .slice(0, MAX_RESULTS);

      list.replaceChildren(...(results.length ? results.map(n => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        const dot = document.createElement('span');
        dot.className = 'chip-dot';
        dot.style.background = n.color;
        const textWrap = document.createElement('span');
        textWrap.className = 'result-main';
        const name = document.createElement('span');
        name.className = 'result-name';
        name.textContent = n.name;
        textWrap.append(name);
        if (n.type === 'track' && n.connectedArtists?.[0]) {
          const sub = document.createElement('span');
          sub.className = 'result-sub';
          sub.textContent = n.connectedArtists[0];
          textWrap.append(sub);
        }
        const kind = document.createElement('span');
        kind.className = 'result-kind';
        const meta = n.type !== 'genre' ? itemMetaLabel(n) : `${n.neighbors?.size || 0} artists`;
        kind.textContent = meta || KIND_LABEL[n.type];
        li.append(dot, textWrap, kind);
        li.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          choose(n);
        });
        return li;
      }) : [Object.assign(document.createElement('li'), { textContent: 'Nothing by that name or era in your universe' })]));
      list.hidden = false;
      springIn(list, { y: 6, scale: 0.98, visualDuration: 0.25 });
      active = results.length ? 0 : -1;
      highlight();
    });

    // Global keyboard shortcuts: ⌘K, Ctrl+K, or "/" to focus search
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.focus();
        input.select();
      } else if (e.key === '/' && document.activeElement !== input && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        input.focus();
      }
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
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  /* ---------- Time & Memory Lens bar ---------- */

  initLensBar() {
    const bar = $('lens-bar');
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest?.('.lens-pill');
      if (!btn) return;
      this.setLens(btn.dataset.lens || 'all');
    });
  }

  setLens(lens) {
    this.state.activeLens = lens || 'all';
    document.querySelectorAll('#lens-bar .lens-pill').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.lens === this.state.activeLens);
    });

    const banner = $('active-lens-banner');
    const desc = LENS_DESCRIPTIONS[this.state.activeLens];
    if (desc) {
      banner.replaceChildren();
      const span = document.createElement('span');
      span.textContent = desc;
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = 'Reset';
      clearBtn.addEventListener('click', () => this.setLens('all'));
      banner.append(span, clearBtn);
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    this.renderClusters(this.suns);
    this.renderMemoriesView();
    this.renderSongsBrowser();
    this.cb.onLensChange?.(this.state.activeLens);
  }

  setLensBarVisible(visible) {
    $('lens-bar').hidden = !visible;
  }

  /* ---------- View settings ---------- */

  initViewPanel() {
    const btn = $('view-toggle-btn');
    const panel = $('view-panel');
    const setOpen = (open) => {
      if (open) {
        panel.hidden = false;
        springIn(panel, { y: 8, scale: 0.95, visualDuration: 0.32 });
      } else {
        panel.hidden = true;
      }
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

    const histCheckbox = $('toggle-history-songs');
    if (histCheckbox) {
      histCheckbox.checked = !this.state.spotifyApiOnly && this.state.layers.historySongs !== false;
      histCheckbox.addEventListener('change', (e) => {
        this.cb.onToggleHistorySongs?.(e.target.checked);
      });
    }

    const bindSlider = (id, label, format, onChange) => {
      const input = $(id);
      try {
        const saved = localStorage.getItem(`astra_${id}`);
        if (saved !== null) input.value = saved;
      } catch { /* storage unavailable */ }
      const apply = () => {
        const v = Number(input.value);
        $(label).textContent = format(v);
        onChange(v);
        try { localStorage.setItem(`astra_${id}`, input.value); } catch { /* ignore */ }
      };
      input.addEventListener('input', apply);
      this.applyInitialSettings.push(apply);
    };
    this.applyInitialSettings = [];

    bindSlider('glow-slider', 'glow-val', v => `${Math.round(v * 100)}%`, v => this.cb.onGlow(v));
    bindSlider('orbit-speed-slider', 'orbit-speed-val', v => (v === 0 ? 'paused' : `${v}×`), v => this.cb.onOrbitSpeed(v));
    bindSlider('cluster-spread-slider', 'cluster-spread-val', v => `${v.toFixed(2).replace(/\.?0+$/, '')}×`, v => this.cb.onClusterSpread?.(v));
    $('node-scale-slider').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $('node-scale-val').textContent = `${v}×`;
      this.cb.onNodeScale(v);
    });
  }

  syncHistoryToggleUI() {
    const histCheckbox = $('toggle-history-songs');
    const includeHistory = !this.state.spotifyApiOnly && this.state.layers.historySongs !== false;
    if (histCheckbox) histCheckbox.checked = includeHistory;

    const mergedBtn = $('mode-merged-btn');
    const spotifyOnlyBtn = $('mode-spotify-only-btn');
    if (mergedBtn && spotifyOnlyBtn) {
      mergedBtn.classList.toggle('btn-starlight', includeHistory);
      spotifyOnlyBtn.classList.toggle('btn-starlight', !includeHistory);
    }
  }

  restoreSettings() {
    this.applyInitialSettings.forEach(apply => apply());
    this.syncHistoryToggleUI();
  }

  /* ---------- Side panel (Clusters | Memories | Songs) with smooth mobile gestures ---------- */

  initSidePanel() {
    $('detail-back-btn').addEventListener('click', () => this.cb.onBack());

    document.querySelectorAll('.panel-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setSideTab(btn.dataset.tab);
        if (this.isPhone() && !this.sheetOpen) this.setSheet(true);
      });
    });

    const panel = $('side-panel');
    const handle = $('sheet-handle');
    let drag = null;

    handle.addEventListener('click', () => {
      if (this.isPhone()) this.setSheet(!this.sheetOpen);
    });

    // Mobile sheet drag: never hijack taps on buttons/tabs; only capture after > 7px vertical drag
    panel.addEventListener('pointerdown', (e) => {
      if (!this.isPhone()) return;
      const isInteractive = e.target.closest?.('button:not(#sheet-handle), a, input, .panel-tabs');
      if (isInteractive && this.sheetOpen) return;

      const onHandleOrHeader = e.target === handle || handle.contains(e.target) || e.target.closest?.('.panel-header-row');
      const scrollEl = !$('detail-view').hidden ? $('detail-view') : $('cluster-view');
      const atScrollTop = (scrollEl?.scrollTop || 0) <= 2;

      if (!this.sheetOpen || onHandleOrHeader || atScrollTop) {
        drag = {
          pointerId: e.pointerId,
          startY: e.clientY,
          moved: 0,
          captured: false,
          onHandleOrHeader: Boolean(onHandleOrHeader),
          isInteractive: Boolean(isInteractive)
        };
      }
    });

    panel.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dy = e.clientY - drag.startY;

      // If open and user is scrolling down the list (dy < 0) inside content, let native scroll work
      if (this.sheetOpen && !drag.onHandleOrHeader && dy < 0) {
        drag = null;
        return;
      }

      if (!drag.captured && Math.abs(dy) > 8) {
        drag.captured = true;
        try { panel.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }

      if (!drag.captured) return;
      drag.moved = dy;
      const base = this.sheetOpen ? 0 : panel.offsetHeight - this.peekHeight();
      panel.style.transition = 'none';
      panel.style.transform = `translateY(${Math.max(0, base + drag.moved)}px)`;
    });

    const endDrag = (e) => {
      if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
      const { moved, captured, onHandleOrHeader, isInteractive } = drag;
      drag = null;
      panel.style.transition = '';
      panel.style.transform = '';

      if (!captured) {
        if (!this.sheetOpen && onHandleOrHeader && !isInteractive) {
          this.setSheet(true);
        }
        return;
      }
      if (Math.abs(moved) > 28) {
        this.setSheet(moved < 0);
      } else {
        this.setSheet(this.sheetOpen);
      }
    };

    panel.addEventListener('pointerup', endDrag);
    panel.addEventListener('pointercancel', endDrag);
    this.sheetOpen = false;
    this.setSheet(false);
  }

  setSideTab(tab) {
    this.activeTab = tab || 'clusters';
    const titles = { clusters: 'Clusters', memories: 'Memories', songs: 'Songs' };
    $('side-panel-heading').textContent = titles[this.activeTab] || 'Clusters';
    document.querySelectorAll('.panel-tab').forEach(btn => {
      const active = btn.dataset.tab === this.activeTab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    $('cluster-list').hidden = this.activeTab !== 'clusters';
    $('memories-list').hidden = this.activeTab !== 'memories';
    $('songs-browser').hidden = this.activeTab !== 'songs';

    if (this.activeTab === 'memories') this.renderMemoriesView();
    if (this.activeTab === 'songs') this.renderSongsBrowser();
  }

  isPhone() {
    return window.innerWidth <= 760;
  }

  peekHeight() {
    return 88;
  }

  setSheet(open) {
    this.sheetOpen = open;
    document.body.classList.toggle('sheet-open', open);
    $('sheet-handle').setAttribute('aria-expanded', String(open));
    $('sheet-handle').setAttribute('aria-label', open ? 'Lower panel' : 'Raise panel');
    this.cb.onSheetChange?.();
  }

  sheetCover() {
    if (!this.isPhone()) return 0;
    return this.sheetOpen ? $('side-panel').offsetHeight + 10 : this.peekHeight() + 10;
  }

  showClusters() {
    document.body.classList.remove('showing-details');
    transitionViews($('detail-view'), $('cluster-view'), 'backward');
  }

  showDetails() {
    document.body.classList.add('showing-details');
    $('detail-view').scrollTop = 0;
    transitionViews($('cluster-view'), $('detail-view'), 'forward');
    if (this.isPhone()) this.setSheet(true);
  }

  /** Clusters, largest first; clicking one flies to it and opens its details. */
  renderClusters(suns) {
    this.suns = suns || [];
    const list = $('cluster-list');
    const lens = this.state.activeLens || 'all';
    const hasLens = lens !== 'all';

    list.replaceChildren(...this.suns
      .filter(sun => sun.meshGroup?.visible !== false)
      .slice()
      .sort((a, b) => (b.neighbors?.size || 0) - (a.neighbors?.size || 0))
      .map(sun => {
        const visibleArtists = [...(sun.neighbors || [])]
          .map(id => this.state.nodeMap.get(id))
          .filter(n => n && n.type === 'artist' && n.meshGroup?.visible !== false);

        const li = document.createElement('li');
        li.className = 'cluster-item';
        li.tabIndex = 0;
        const swatch = document.createElement('span');
        swatch.className = 'cluster-swatch';
        swatch.style.background = sun.color;
        const text = document.createElement('span');
        const name = document.createElement('span');
        name.className = 'cluster-name';
        name.textContent = sun.name;
        const sub = document.createElement('span');
        sub.className = 'cluster-sub';
        const topNames = (sun.topArtists || sun.subgenres || []).slice(0, 3).join(', ');
        const songCnt = sun.trackCount ? ` · ${sun.trackCount} songs` : '';
        sub.textContent = `${topNames}${songCnt}`;
        text.append(name, sub);

        const count = document.createElement('span');
        count.className = 'cluster-count';
        if (hasLens) {
          const matchingArtists = visibleArtists.filter(n => nodeMatchesLens(n, lens)).length;
          count.textContent = `${matchingArtists}/${visibleArtists.length}`;
          count.title = 'Matching artists in this lens';
        } else {
          count.textContent = visibleArtists.length;
          count.title = 'Artists';
        }
        li.append(swatch, text, count);
        const select = () => this.cb.onSelectNode(sun);
        li.addEventListener('click', select);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(); });
        return li;
      }));

    staggerRevealItems(list, 'li', { limit: 25, staggerDelay: 0.015 });
    this.renderMemoriesView();
    this.renderSongsBrowser();
  }

  /**
   * Renders the "Memories" tab: curated sections for Past Favorites, Dormant Gems
   * ("Haven't heard in a while"), Early 2024 / 2025 Time Capsules, and All-Time Staples.
   */
  renderMemoriesView() {
    const container = $('memories-list');
    if (!container) return;

    const tracks = this.state.nodes.filter(n => n.type === 'track' && n.meshGroup?.visible !== false && n.history?.plays);
    const artists = this.state.nodes.filter(n => n.type === 'artist' && n.meshGroup?.visible !== false && n.history?.plays);

    if (!tracks.length && !artists.length) {
      container.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'Import your Spotify Streaming History (via the History button above) to unlock past favorites, dormant gems and 2020–2026 time capsules.';
      container.append(empty);
      return;
    }

    const pastFavs = tracks
      .filter(t => t.history?.tags?.includes('past_fav'))
      .sort((a, b) => b.history.plays - a.history.plays)
      .slice(0, 12);

    const dormantGems = tracks
      .filter(t => t.history?.tags?.includes('dormant') && t.history.plays >= 10)
      .sort((a, b) => (b.history.plays * Math.sqrt(b.history.daysSinceLast)) - (a.history.plays * Math.sqrt(a.history.daysSinceLast)))
      .slice(0, 12);

    const early2024 = tracks
      .filter(t => t.history?.tags?.includes('early_2024') || t.history?.peakYear === '2024')
      .sort((a, b) => (b.history.byYear?.['2024'] || 0) - (a.history.byYear?.['2024'] || 0))
      .slice(0, 10);

    const early2025 = tracks
      .filter(t => t.history?.tags?.includes('early_2025') || t.history?.peakYear === '2025')
      .sort((a, b) => (b.history.byYear?.['2025'] || 0) - (a.history.byYear?.['2025'] || 0))
      .slice(0, 10);

    const buildGroup = (title, subtitle, lensId, items) => {
      if (!items.length) return null;
      const sec = document.createElement('section');
      sec.className = 'memory-group';
      const head = document.createElement('div');
      head.className = 'memory-group-head';
      const h3 = document.createElement('h3');
      h3.textContent = title;
      const lensBtn = document.createElement('button');
      lensBtn.type = 'button';
      lensBtn.className = 'memory-lens-link';
      lensBtn.textContent = this.state.activeLens === lensId ? 'Showing in 3D' : 'Light up in 3D';
      lensBtn.addEventListener('click', () => this.setLens(this.state.activeLens === lensId ? 'all' : lensId));
      head.append(h3, lensBtn);

      const sub = document.createElement('p');
      sub.className = 'memory-group-sub';
      sub.textContent = subtitle;

      const ul = document.createElement('ul');
      ul.className = 'song-list';
      items.forEach(item => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.addEventListener('click', () => this.cb.onSelectNode(item));

        const main = document.createElement('span');
        main.className = 'song-main';
        const tSpan = document.createElement('span');
        tSpan.className = 'song-title';
        tSpan.textContent = item.name;
        const aSpan = document.createElement('span');
        aSpan.className = 'song-sub';
        aSpan.textContent = item.connectedArtists?.[0] || item.artistName || '';
        main.append(tSpan, aSpan);

        const meta = document.createElement('span');
        meta.className = 'song-meta';
        meta.textContent = itemMetaLabel(item);

        btn.append(main, meta);
        li.append(btn);
        ul.append(li);
      });

      sec.append(head, sub, ul);
      return sec;
    };

    const groups = [
      buildGroup(
        'Past Favorites',
        'Songs you played on repeat in earlier eras that faded from recent rotation.',
        'past_fav',
        pastFavs
      ),
      buildGroup(
        'Haven’t Heard in a While',
        'High-play songs untouched for 4+ months.',
        'dormant',
        dormantGems
      ),
      buildGroup(
        '2025 Era Favorites',
        'Songs that defined your Early & Mid 2025 listening.',
        'era_2025',
        early2025
      ),
      buildGroup(
        '2024 Time Capsule',
        'Songs you had on heavy rotation back in 2024.',
        'era_2024',
        early2024
      )
    ].filter(Boolean);

    container.replaceChildren(...groups);
    staggerRevealItems(container, '.memory-group', { limit: 8, staggerDelay: 0.03 });
  }

  /**
   * Renders the "Songs" tab: lets the user browse and sort all songs in the universe
   * (automatically filtered by the active Time & Memory Lens and history toggle).
   */
  renderSongsBrowser() {
    const container = $('songs-browser');
    if (!container) return;

    const lens = this.state.activeLens || 'all';
    const allTracks = this.state.nodes
      .filter(n => n.type === 'track' && n.meshGroup?.visible !== false && nodeMatchesLens(n, lens))
      .sort((a, b) => (b.history?.plays || b.plays || 0) - (a.history?.plays || a.plays || 0));

    if (!allTracks.length) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'No songs match the selected filter.';
      container.replaceChildren(p);
      return;
    }

    const countNote = document.createElement('p');
    countNote.className = 'memory-group-sub';
    countNote.textContent = `Showing top ${Math.min(150, allTracks.length)} of ${allTracks.length.toLocaleString()} songs${lens !== 'all' ? ' in this lens' : ''}. Tap any song to fly to its moon.`;

    const ul = document.createElement('ul');
    ul.className = 'song-list';
    allTracks.slice(0, 150).forEach(t => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.addEventListener('click', () => this.cb.onSelectNode(t));

      const main = document.createElement('span');
      main.className = 'song-main';
      const title = document.createElement('span');
      title.className = 'song-title';
      title.textContent = t.name;
      const sub = document.createElement('span');
      sub.className = 'song-sub';
      sub.textContent = t.connectedArtists?.[0] || t.artistName || '';
      main.append(title, sub);

      const meta = document.createElement('span');
      meta.className = 'song-meta';
      meta.textContent = itemMetaLabel(t);

      btn.append(main, meta);
      li.append(btn);
      ul.append(li);
    });

    container.replaceChildren(countNote, ul);
    staggerRevealItems(ul, 'li', { limit: 30, staggerDelay: 0.015 });
  }

  /* ---------- History Import, Source Mode & Export Dialog ---------- */

  initHistoryDialog() {
    const dialog = $('history-dialog');
    const openBtn = $('history-btn');
    const closeBtn = $('history-close-btn');
    const folderBtn = $('import-folder-btn');
    const filesBtn = $('import-files-btn');
    const localBtn = $('use-local-history-btn');
    const folderInput = $('history-folder-input');
    const filesInput = $('history-files-input');
    const dropzone = $('history-dropzone');
    const exportJsonBtn = $('export-json-btn');
    const exportCsvBtn = $('export-csv-btn');
    const mergedBtn = $('mode-merged-btn');
    const spotifyOnlyBtn = $('mode-spotify-only-btn');
    const removeHistoryBtn = $('remove-history-btn');

    const closeDialog = async () => {
      await animateDialogOut(dialog);
      dialog.close();
    };

    openBtn.addEventListener('click', () => {
      this.updateHistoryDialogStatus();
      this.syncHistoryToggleUI();
      dialog.showModal();
      animateDialogIn(dialog);
    });
    closeBtn.addEventListener('click', closeDialog);
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) closeDialog();
    });

    mergedBtn?.addEventListener('click', () => {
      this.cb.onToggleHistorySongs?.(true);
      this.syncHistoryToggleUI();
      this.updateHistoryDialogStatus();
    });
    spotifyOnlyBtn?.addEventListener('click', async () => {
      this.cb.onToggleHistorySongs?.(false);
      this.syncHistoryToggleUI();
      this.updateHistoryDialogStatus();
      await closeDialog();
    });
    removeHistoryBtn?.addEventListener('click', async () => {
      await this.cb.onRemoveHistory?.();
      this.syncHistoryToggleUI();
      this.updateHistoryDialogStatus();
      await closeDialog();
    });

    folderBtn.addEventListener('click', () => folderInput.click());
    filesBtn.addEventListener('click', () => filesInput.click());
    localBtn.addEventListener('click', () => {
      this.cb.onUseLocalHistory?.();
      dialog.close();
    });

    const handleFiles = async (fileList) => {
      if (!fileList || !fileList.length) return;
      this.setHistoryFeedback('Reading and analyzing your listening history files…', false);
      try {
        await this.cb.onImportFiles?.(fileList);
        this.setHistoryFeedback('Listening history imported and mapped!', false);
        setTimeout(() => {
          if (dialog.open) dialog.close();
        }, 550);
      } catch (err) {
        this.setHistoryFeedback(err.message || 'Failed to import files.', true);
      }
    };

    folderInput.addEventListener('change', (e) => {
      handleFiles(e.target.files);
      folderInput.value = '';
    });
    filesInput.addEventListener('change', (e) => {
      handleFiles(e.target.files);
      filesInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(ev => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.remove('is-dragover');
      });
    });
    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    });

    exportJsonBtn.addEventListener('click', () => this.cb.onExportJson?.());
    exportCsvBtn.addEventListener('click', () => this.cb.onExportCsv?.());
  }

  setHistoryFeedback(message, isError = false) {
    const el = $('history-feedback');
    if (!message) {
      el.hidden = true;
      return;
    }
    el.textContent = message;
    el.className = `history-feedback${isError ? ' is-error' : ''}`;
    el.hidden = false;
  }

  updateHistoryDialogStatus() {
    const box = $('history-status-box');
    const localBtn = $('use-local-history-btn');
    const hm = this.state.rawDataset?.historyMeta;
    const local = this.authStatus?.localHistory;
    const spotifyOnly = Boolean(this.state.spotifyApiOnly || this.state.layers.historySongs === false);

    if (local?.available) {
      localBtn.hidden = false;
      localBtn.textContent = `Load "${local.sourceFolder}" (${local.validPlays.toLocaleString()} plays)`;
    } else {
      localBtn.hidden = true;
    }

    if (spotifyOnly) {
      box.innerHTML = `
        <div class="status-pill-row">
          <span class="status-dot is-active"></span>
          <strong>Spotify API Mode: History-only songs hidden</strong>
        </div>
        <p class="status-detail">Showing only the artists and songs returned by the Spotify API. Switch back to "Spotify + History Songs" anytime to restore all historical plays.</p>
      `;
    } else if (hm?.validPlays) {
      const years = Object.keys(hm.years || {}).sort();
      const yearSpan = years.length ? `${years[0]}–${years[years.length - 1]}` : `${hm.firstDate} to ${hm.lastDate}`;
      box.innerHTML = `
        <div class="status-pill-row">
          <span class="status-dot is-active"></span>
          <strong>Active History: ${hm.validPlays.toLocaleString()} plays (${hm.totalHours?.toLocaleString() || '—'} hrs)</strong>
        </div>
        <p class="status-detail">Spanning ${yearSpan} (${hm.firstDate} to ${hm.lastDate}) · Source: ${hm.sourceFolder || 'Imported'}${hm.connectedSpotify ? ' · Merged with live Spotify' : ''}</p>
      `;
    } else if (local?.available) {
      box.innerHTML = `
        <div class="status-pill-row">
          <span class="status-dot"></span>
          <strong>Detected in project folder: ${local.sourceFolder}</strong>
        </div>
        <p class="status-detail">${local.validPlays.toLocaleString()} plays (${local.totalHours} hrs) across ${local.fileCount} files (${local.firstDate} to ${local.lastDate}).</p>
      `;
    } else {
      box.innerHTML = `
        <div class="status-pill-row">
          <span class="status-dot"></span>
          <strong>No streaming history imported yet</strong>
        </div>
        <p class="status-detail">Select your Spotify Extended Streaming History folder or JSON files below to merge multi-year play history into your galaxy.</p>
      `;
    }
  }

  updateHistoryButtonBadge() {
    const btn = $('history-btn');
    const hm = this.state.rawDataset?.historyMeta;
    const includeHistory = !this.state.spotifyApiOnly && this.state.layers.historySongs !== false;
    if (hm?.validPlays && includeHistory) {
      const k = hm.validPlays >= 1000 ? `${(hm.validPlays / 1000).toFixed(1)}k` : hm.validPlays;
      btn.textContent = `History · ${k}`;
      btn.classList.add('has-history');
    } else {
      btn.textContent = 'History';
      btn.classList.remove('has-history');
    }
  }

  /* ---------- Caption, enrichment counter, notice, loading ---------- */

  setCaption(title, stats) {
    $('universe-title').textContent = title;
    $('universe-stats').textContent = stats || '';
  }

  updateEnrichmentStatus(status) {
    updateEnrichmentStatus(status);
  }

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

  setLoading(loading, title = 'Charting your universe', body = 'Merging your Spotify listening history, top charts and Liked Songs, then grouping every artist by sound.') {
    if (title) $('loading-title-text').textContent = title;
    if (body) $('loading-body-text').textContent = body;
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
