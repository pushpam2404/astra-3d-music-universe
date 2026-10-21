// src/main.js
import * as THREE from 'three';
import { animate } from 'motion';
import { GALAXY_PRESETS } from './config/presets.js';
import { buildUniverseGraph } from './etl/graphNormalizer.js';
import { getAuthStatus, fetchUniverse, enrichArtists } from './api/backendClient.js';
import { loadArtistMeta, saveArtistMeta } from './api/artistMetaCache.js';
import {
  loadStoredHistorySummary,
  saveStoredHistorySummary,
  loadStoredUniverseSnapshot,
  saveStoredUniverseSnapshot,
  clearStoredHistory,
  parseImportedFiles,
  exportUniverseSnapshotJson,
  exportListeningHistoryCsv
} from './api/historyStorage.js';
import { createUniverseScene } from './renderer/universeScene.js';
import { initPostProcessing, BLOOM_STRENGTH } from './renderer/postProcessing.js';
import { CelestialFactory, nodeMatchesLens } from './renderer/celestialFactory.js';
import { GalaxyLayoutEngine } from './physics/galaxyLayout.js';
import { CameraFlightController } from './renderer/cameraController.js';
import { LabelProjector } from './renderer/labelProjector.js';
import { Hud } from './ui/hud.js';
import { DetailPanel } from './ui/detailPanel.js';

const AppState = {
  isDemo: true,
  rawDataset: null,
  historySummary: null,
  spotifyApiOnly: false,
  activeLens: 'all',
  nodeScaleMultiplier: 1.0,
  layers: { genres: true, artists: true, tracks: true, historySongs: true, edges: true, labels: true },
  nodes: [],
  edges: [],
  nodeMap: new Map(),
  pulseParticles: [],
  hoveredNode: null,
  selectedNode: null
};

const ENRICH_BATCH = 40;
// Auto-refine once this many artists (or this share of the pending ones) have new
// genres, after this long without interaction.
const AUTO_REFINE_MIN = 60;
const AUTO_REFINE_SHARE = 0.15;
const AUTO_REFINE_IDLE_MS = 8000;
const plural = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;

async function initApp() {
  const { scene, camera, renderer, controls } = createUniverseScene(document.getElementById('webgl-canvas-container'));
  const { composer, bloomPass } = initPostProcessing(renderer, scene, camera);

  const viewShift = { x: 0, y: 0, tx: 0, ty: 0 };
  let sheetCover = () => 88;
  function updateViewOffset(snap = false) {
    const narrow = window.innerWidth <= 760;
    viewShift.tx = narrow ? 0 : (340 + 16) / 2;
    const barBottom = narrow ? document.getElementById('top-bar').getBoundingClientRect().bottom : 0;
    viewShift.ty = narrow ? (sheetCover() - barBottom) / 2 : 0;
    if (snap === true) { viewShift.x = viewShift.tx; viewShift.y = viewShift.ty; }
    applyViewOffset();
  }
  function applyViewOffset() {
    camera.setViewOffset(window.innerWidth, window.innerHeight, viewShift.x, viewShift.y, window.innerWidth, window.innerHeight);
  }
  function easeViewOffset() {
    if (Math.abs(viewShift.tx - viewShift.x) + Math.abs(viewShift.ty - viewShift.y) < 0.5) return;
    viewShift.x += (viewShift.tx - viewShift.x) * 0.15;
    viewShift.y += (viewShift.ty - viewShift.y) * 0.15;
    applyViewOffset();
  }
  updateViewOffset(true);
  window.addEventListener('resize', () => updateViewOffset(true));

  const factory = new CelestialFactory(scene);
  const layout = new GalaxyLayoutEngine();
  const cameraController = new CameraFlightController(camera, controls);
  const labelProjector = new LabelProjector(document.getElementById('hud-labels-container'));
  let edgeGroup = null;
  let suns = [];
  let authStatus = { loggedIn: false };

  // ---------- Selection ----------

  function selectNode(node) {
    if (!node) return;
    AppState.selectedNode = node;
    cameraController.flyToNode(node);
    detailPanel.render(node);
    hud.showDetails();
  }

  function clearSelection() {
    AppState.selectedNode = null;
    hud.showClusters();
    if (hud.isPhone()) hud.setSheet(false);
  }

  const detailPanel = new DetailPanel(document.getElementById('detail-content'), {
    resolve: (id) => AppState.nodeMap.get(id),
    onSelect: selectNode,
    onFly: (node) => cameraController.flyToNode(node),
    isDemo: () => AppState.isDemo,
    likedSongsConnected: () => !authStatus.missingScopes?.includes('user-library-read'),
    getActiveLens: () => AppState.activeLens,
    onSetLens: (lens) => hud.setLens(lens)
  });

  const hud = new Hud(AppState, {
    onSelectNode: selectNode,
    onBack: () => {
      clearSelection();
      cameraController.resetOverview();
    },
    onResetCamera: () => {
      clearSelection();
      cameraController.resetOverview();
    },
    onZoomStep: (factor) => {
      cameraController.zoomBy(factor);
    },
    onLayersChange: applyLayerVisibility,
    onToggleHistorySongs: async (includeHistory) => {
      AppState.layers.historySongs = includeHistory;
      AppState.spotifyApiOnly = !includeHistory;
      hud.syncHistoryToggleUI();
      hud.updateHistoryButtonBadge();

      const hasSpotifyItemsInCurrent = AppState.nodes.some(n => n.fromSpotifyApi);
      if (authStatus.loggedIn) {
        await loadLive({
          historySummary: includeHistory ? AppState.historySummary : null,
          useLocalHistory: includeHistory,
          spotifyApiOnly: !includeHistory,
          skipInitialEnrich: true
        });
        return;
      }

      if (hasSpotifyItemsInCurrent) {
        applyLayerVisibility();
        return;
      }

      if (!includeHistory) {
        loadDemo();
        hud.setNotice('History songs hidden. Connect Spotify to map your live Spotify library, or re-enable History songs in View.', {
          label: 'Restore history songs',
          run: () => hud.cb.onToggleHistorySongs(true)
        });
      } else if (AppState.historySummary || authStatus.localHistory?.available) {
        await loadLive({ historySummary: AppState.historySummary, useLocalHistory: true, skipInitialEnrich: true });
      }
    },
    onRemoveHistory: async () => {
      AppState.historySummary = null;
      AppState.spotifyApiOnly = true;
      AppState.layers.historySongs = false;
      await clearStoredHistory();
      hud.syncHistoryToggleUI();
      hud.updateHistoryButtonBadge();
      if (authStatus.loggedIn) {
        await loadLive({ historySummary: null, useLocalHistory: false, spotifyApiOnly: true });
      } else {
        loadDemo();
        hud.setNotice('Removed streaming history. Connect Spotify to map your live library.');
      }
    },
    onLensChange: () => {
      factory.focusKey = null;
      if (AppState.selectedNode) detailPanel.render(AppState.selectedNode);
    },
    onSheetChange: () => updateViewOffset(),
    onGlow: (level) => {
      bloomPass.strength = BLOOM_STRENGTH * level;
      factory.setGlow(level, AppState.nodes);
    },
    onOrbitSpeed: (speed) => {
      layout.orbitMultiplier = speed;
      controls.autoRotate = speed > 0;
      controls.autoRotateSpeed = 0.35 * speed;
    },
    onNodeScale: (scale) => {
      AppState.nodeScaleMultiplier = scale;
      layout.nodeScaleMultiplier = scale;
      AppState.nodes.forEach(n => n.meshGroup?.scale.setScalar(scale));
    },
    onClusterSpread: (spread) => {
      layout.clusterSpreadMultiplier = spread;
      layout.boundingRadius = layout.bounds[layout.mode] * spread;
      cameraController.setSceneRadius(layout.boundingRadius);
    },
    onImportFiles: async (fileList) => {
      const parsed = await parseImportedFiles(fileList);
      AppState.spotifyApiOnly = false;
      AppState.layers.historySongs = true;
      hud.syncHistoryToggleUI();

      if (parsed.kind === 'snapshot') {
        if (parsed.artistMeta) saveArtistMeta(parsed.artistMeta);
        if (parsed.historySummary) {
          AppState.historySummary = parsed.historySummary;
          await saveStoredHistorySummary(parsed.historySummary);
        }
        await saveStoredUniverseSnapshot(parsed.snapshot);
        AppState.isDemo = false;
        loadDataset(parsed.dataset);
        updateUniverseCaption(parsed.dataset);
        hud.setNotice(`Loaded universe snapshot (${parsed.fileNames[0]}).`);
        return;
      }

      AppState.historySummary = parsed.historySummary;
      await saveStoredHistorySummary(parsed.historySummary);
      await saveStoredUniverseSnapshot(null);
      await loadLive({ historySummary: parsed.historySummary });
    },
    onUseLocalHistory: async () => {
      AppState.historySummary = null;
      AppState.spotifyApiOnly = false;
      AppState.layers.historySongs = true;
      hud.syncHistoryToggleUI();
      await saveStoredHistorySummary(null);
      await saveStoredUniverseSnapshot(null);
      await loadLive({ useLocalHistory: true });
    },
    onExportJson: () => {
      exportUniverseSnapshotJson(AppState.rawDataset, loadArtistMeta(), AppState.historySummary);
    },
    onExportCsv: () => {
      exportListeningHistoryCsv(AppState.rawDataset);
    },
    onDisconnected: () => {
      if ((authStatus.localHistory?.available || AppState.historySummary) && !AppState.spotifyApiOnly) {
        loadLive({ historySummary: AppState.historySummary });
      } else {
        loadDemo();
      }
    }
  });
  sheetCover = () => hud.sheetCover();
  updateViewOffset(true);

  // ---------- Pointer & Touch: multi-touch safe tap, pinch-zoom & double-tap ----------

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-9, -9);
  const activeTouches = new Set();
  let gestureHadMultiTouch = false;
  let downAt = null;
  let lastTap = { time: 0, x: 0, y: 0 };
  const setPointer = (e) => pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (activeTouches.size <= 1) setPointer(e);
  });
  renderer.domElement.addEventListener('pointerleave', () => pointer.set(-9, -9));
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') {
      activeTouches.add(e.pointerId);
      if (activeTouches.size > 1) gestureHadMultiTouch = true;
    }
    if (activeTouches.size <= 1) {
      downAt = { x: e.clientX, y: e.clientY, time: performance.now() };
    }
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    const touch = e.pointerType !== 'mouse';
    if (touch) activeTouches.delete(e.pointerId);

    // Never treat the end of a two-finger pinch-zoom or pan gesture as a node tap
    if (touch && (gestureHadMultiTouch || activeTouches.size > 0)) {
      if (activeTouches.size === 0) gestureHadMultiTouch = false;
      pointer.set(-9, -9);
      return;
    }

    const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : Infinity;
    const elapsed = downAt ? performance.now() - downAt.time : Infinity;
    if (moved <= (touch ? 14 : 5) && elapsed < 550) {
      setPointer(e);
      const node = pickNode(touch) || pickNearest(e.clientX, e.clientY, touch ? 34 : 12, touch);
      const now = performance.now();
      const isDoubleTap = touch && (now - lastTap.time < 320) && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 36;
      lastTap = { time: now, x: e.clientX, y: e.clientY };

      if (node) {
        selectNode(node);
        if (isDoubleTap) cameraController.zoomBy(0.65);
        if (touch) navigator.vibrate?.(8);
      } else if (isDoubleTap) {
        clearSelection();
        cameraController.resetOverview();
      } else if (AppState.selectedNode) {
        clearSelection();
      } else if (touch && hud.sheetOpen) {
        hud.setSheet(false);
      }
    }
    if (touch) pointer.set(-9, -9);
  });
  renderer.domElement.addEventListener('pointercancel', (e) => {
    activeTouches.delete(e.pointerId);
    if (activeTouches.size === 0) gestureHadMultiTouch = false;
    pointer.set(-9, -9);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && AppState.selectedNode && document.activeElement?.tagName !== 'INPUT') clearSelection();
  });

  /** Closest visible sun, artist, or song moon on screen within `radius` px. */
  function pickNearest(x, y, radius, isTouch = false) {
    let bestFocused = null, bestFocusedD = radius;
    let bestAny = null, bestAnyD = radius;
    const v = new THREE.Vector3();
    const hasLens = AppState.activeLens && AppState.activeLens !== 'all';
    for (const n of AppState.nodes) {
      if (!n.position || n.meshGroup?.visible === false) continue;
      if (n.type === 'artist' && !AppState.layers.artists) continue;
      if (n.type === 'track') {
        if (!AppState.layers.tracks) continue;
        if (!AppState.selectedNode && !hasLens && !isTouch) continue;
        if (hasLens && !nodeMatchesLens(n, AppState.activeLens)) continue;
      }
      v.copy(n.position).project(camera);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x + 1) / 2 * window.innerWidth - x, (1 - v.y) / 2 * window.innerHeight - y);
      const isFocusedNode = (n.focusTarget ?? 1) >= 0.5;
      if (isFocusedNode && d < bestFocusedD) {
        bestFocusedD = d;
        bestFocused = n;
      }
      if (d < bestAnyD) {
        bestAnyD = d;
        bestAny = n;
      }
    }
    return bestFocused || bestAny;
  }

  function pickNode(isTouch = false, allowDimmedFallback = true) {
    raycaster.setFromCamera(pointer, camera);
    const interactiveMeshes = [];
    AppState.nodes.forEach(n => {
      if (n.sphereMesh && n.meshGroup?.visible) {
        interactiveMeshes.push(n.sphereMesh);
      }
    });
    if (factory.artistMesh && AppState.layers.artists) interactiveMeshes.push(factory.artistMesh);
    const zoomedIn = camera.position.length() < layout.boundingRadius * 0.95;
    const hasLens = AppState.activeLens && AppState.activeLens !== 'all';
    if (factory.trackMesh && AppState.layers.tracks && (AppState.selectedNode || hasLens || zoomedIn || isTouch)) {
      interactiveMeshes.push(factory.trackMesh);
    }

    const pickableTargets = interactiveMeshes.filter((m) => m.visible);
    const hits = raycaster.intersectObjects(pickableTargets, false);
    let fallbackDimmed = null;
    for (const hit of hits) {
      const node = factory.nodeFromHit(hit);
      if (!node || node.meshGroup?.visible === false) continue;
      if ((node.focusTarget ?? 1) >= 0.65) {
        return node;
      }
      if (allowDimmedFallback && !fallbackDimmed) fallbackDimmed = node;
    }
    return fallbackDimmed;
  }

  // ---------- Building a universe ----------

  function updateUniverseCaption(dataset) {
    const hm = dataset.historyMeta;
    const totalArtists = dataset.artists?.length || AppState.rawDataset?.artists?.length || hm?.artistCount || AppState.nodes.filter(n => n.type === 'artist').length;
    const totalTracks = dataset.tracks?.length || AppState.rawDataset?.tracks?.length || hm?.trackCount || AppState.nodes.filter(n => n.type === 'track').length;
    const totalClusters = dataset.genres?.length || AppState.rawDataset?.genres?.length || AppState.nodes.filter(n => n.type === 'genre').length;

    if (hm?.validPlays && !AppState.spotifyApiOnly && AppState.layers.historySongs !== false) {
      const years = Object.keys(hm.years || {}).sort();
      const span = years.length ? `${years[0]}–${years[years.length - 1]}` : '';
      hud.setCaption(
        dataset.name || 'Your Complete Music Universe',
        `${plural(totalArtists, 'artist')} & ${plural(totalTracks, 'song')} in ${plural(totalClusters, 'cluster')} · ${hm.validPlays.toLocaleString()} plays (${hm.totalHours?.toLocaleString() || '—'} hrs${span ? `, ${span}` : ''})`
      );
    } else {
      hud.setCaption(
        dataset.name || 'Your music universe',
        `${plural(totalArtists, 'artist')} & ${plural(totalTracks, 'song')} in ${plural(totalClusters, 'cluster')}`
      );
    }
  }

  /**
   * @param {object} rawDataset
   * @param {{ morph?: boolean }} opts  morph: keep the camera and let suns and planets
   *   glide from their old positions (used when the map refines in the background).
   */
  function loadDataset(rawDataset, { morph = false } = {}) {
    const previous = new Map();
    if (morph) AppState.nodes.forEach(n => { if (n.type !== 'track' && n.position) previous.set(n.id, n.position.clone()); });
    AppState.rawDataset = rawDataset;
    AppState.nodes.forEach(n => { if (n.meshGroup?.isObject3D) scene.remove(n.meshGroup); });
    if (edgeGroup) scene.remove(edgeGroup);
    factory.solarMaterials = [];
    factory.disposeBatches();
    AppState.selectedNode = null;
    AppState.hoveredNode = null;

    const graph = buildUniverseGraph(rawDataset);
    AppState.nodes = graph.nodes;
    AppState.edges = graph.edges;
    AppState.nodeMap = graph.nodeMap;

    layout.initializeNodePositions(AppState.nodes);
    cameraController.setSceneRadius(layout.boundingRadius);
    if (morph) startMorph(previous);

    AppState.nodes.forEach(node => { if (node.type === 'genre') factory.buildGenreSun(node); });
    factory.buildArtistPlanets(AppState.nodes.filter(n => n.type === 'artist'));
    factory.buildTrackSatellites(AppState.nodes.filter(n => n.type === 'track'));
    const edgeData = factory.buildEdgeVisuals(AppState.edges);
    edgeGroup = edgeData.edgeLinesGroup;
    AppState.pulseParticles = edgeData.pulseParticles;
    if (AppState.nodeScaleMultiplier !== 1) AppState.nodes.forEach(n => n.meshGroup?.scale.setScalar(AppState.nodeScaleMultiplier));

    suns = AppState.nodes.filter(n => n.type === 'genre');
    labelProjector.syncLabels(AppState.nodes, selectNode);
    hud.setLensBarVisible(Boolean(!AppState.isDemo || rawDataset.historyMeta));
    hud.updateHistoryButtonBadge();
    applyLayerVisibility();
    hud.restoreSettings();
    if (!morph) cameraController.resetOverview();
  }

  function applyLayerVisibility() {
    const show = { genre: AppState.layers.genres, artist: AppState.layers.artists, track: AppState.layers.tracks };
    const includeHistoryItems = AppState.layers.historySongs !== false && !AppState.spotifyApiOnly;
    const hasSpotifyItems = AppState.nodes.some(n => n.fromSpotifyApi);

    AppState.nodes.forEach(n => {
      if (!n.meshGroup) return;
      let vis = Boolean(show[n.type]);
      if (vis && !includeHistoryItems && hasSpotifyItems && n.historyOnly) {
        vis = false;
      }
      n.meshGroup.visible = vis;
    });

    if (factory.trackMesh) factory.trackMesh.visible = AppState.layers.tracks;
    if (factory.trackDimMesh) factory.trackDimMesh.visible = AppState.layers.tracks && Boolean(AppState.selectedNode || (AppState.activeLens && AppState.activeLens !== 'all'));
    if (factory.artistMesh) factory.artistMesh.visible = factory.artistDecor.visible = AppState.layers.artists;
    if (factory.artistDimMesh) factory.artistDimMesh.visible = AppState.layers.artists && Boolean(AppState.selectedNode || (AppState.activeLens && AppState.activeLens !== 'all'));
    if (edgeGroup) edgeGroup.visible = AppState.layers.edges;
    factory.focusKey = null;
    hud.renderClusters(suns);
    if (AppState.rawDataset && !AppState.isDemo) updateUniverseCaption(AppState.rawDataset);
  }

  function loadDemo() {
    AppState.isDemo = true;
    loadDataset(GALAXY_PRESETS.cosmic_synth);
    hud.setCaption('A demo universe', 'Connect Spotify or import your listening history to map your own music.');
    hud.updateEnrichmentStatus({ waitingCount: 0, readyOnReloadCount: 0 });
    hud.setNotice(null);
  }

  async function loadLive({
    historySummary = AppState.historySummary,
    useLocalHistory = true,
    skipInitialEnrich = false,
    spotifyApiOnly = AppState.spotifyApiOnly,
    refine = false
  } = {}) {
    if (!refine) hud.setLoading(true);
    try {
      const { dataset, artistMeta, diagnostics } = await fetchUniverse(loadArtistMeta(), {
        historySummary: spotifyApiOnly ? null : historySummary,
        useLocalHistory: spotifyApiOnly ? false : useLocalHistory,
        loggedIn: Boolean(authStatus.loggedIn),
        skipInitialEnrich,
        spotifyApiOnly
      });
      saveArtistMeta(artistMeta);
      console.info('[Astra] universe diagnostics:', diagnostics);
      if (!dataset) {
        loadDemo();
        hud.setNotice('Spotify has no listening data for this account yet.');
        return;
      }
      const morph = refine && !AppState.isDemo;
      AppState.isDemo = false;
      loadDataset(dataset, { morph });
      updateUniverseCaption(dataset);

      if (authStatus.loggedIn && authStatus.missingScopes?.includes('user-library-read')) {
        hud.setNotice('Your Liked Songs aren’t included yet.', { label: 'Reconnect Spotify', run: () => document.getElementById('spotify-btn').click() });
      } else if (!authStatus.loggedIn && dataset.historyMeta) {
        hud.setNotice('Mapped from your streaming history. Connect Spotify anytime to merge live top charts & Liked Songs.');
      } else if (spotifyApiOnly) {
        hud.setNotice('Showing only songs & artists from the Spotify API (history songs excluded).', {
          label: 'Include history songs',
          run: () => hud.cb.onToggleHistorySongs(true)
        });
      } else {
        hud.setNotice(null);
      }

      if (diagnostics.pendingArtists?.length) {
        enrichInBackground(diagnostics.pendingArtists);
      } else {
        hud.updateEnrichmentStatus({ waitingCount: 0, readyOnReloadCount: 0 });
      }
    } catch (err) {
      console.error('Failed to load universe:', err);
      loadDemo();
      if (err.status === 401) {
        authStatus = { ...authStatus, loggedIn: false };
        hud.setAuthStatus(authStatus);
      }
      hud.setNotice(err.message, err.status === 401 || err.status === 429 ? null : { label: 'Try again', run: () => loadLive({ historySummary, useLocalHistory, spotifyApiOnly }) });
    } finally {
      hud.setLoading(false);
    }
  }

  // One spring drives every glide (Motion: a single interruptible animation, no
  // per-node tweens). Cluster ids change between maps, so a new sun starts from
  // where its artists were.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let morphAnimation = null;
  function startMorph(previous) {
    const v = new THREE.Vector3();
    AppState.nodes.forEach(n => {
      if (n.type === 'artist') n.morphFrom = previous.get(n.id) || null;
    });
    AppState.nodes.forEach(n => {
      if (n.type !== 'genre') return;
      if (previous.has(n.id)) { n.morphFrom = previous.get(n.id); return; }
      let count = 0;
      v.set(0, 0, 0);
      AppState.nodes.forEach(a => {
        if (a.type === 'artist' && a.genres?.[0] === n.id && a.morphFrom) { v.add(a.morphFrom); count++; }
      });
      n.morphFrom = count ? v.clone().divideScalar(count) : null;
    });
    morphAnimation?.stop();
    if (reduceMotion.matches) { layout.morphT = 1; return; }
    layout.morphT = 0;
    morphAnimation = animate(0, 1, {
      type: 'spring', visualDuration: 1.4, bounce: 0,
      onUpdate: (t) => { layout.morphT = t; }
    });
  }

  // The map refines itself as genres arrive, but only while you aren't exploring:
  // never mid-gesture, never with something selected.
  let lastInteraction = performance.now();
  ['pointerdown', 'wheel', 'keydown', 'touchstart'].forEach(type =>
    window.addEventListener(type, () => { lastInteraction = performance.now(); }, { passive: true }));
  const isIdle = () => !AppState.selectedNode && document.visibilityState === 'visible' &&
    performance.now() - lastInteraction > AUTO_REFINE_IDLE_MS;

  let enrichRun = 0;
  async function enrichInBackground(unenrichedArtists) {
    const run = ++enrichRun;
    let waitingToFetchCount = unenrichedArtists.length;
    let newlyResolvedForReloadCount = 0;

    const applyResolvedNow = async () => {
      enrichRun++;
      hud.updateEnrichmentStatus({ waitingCount: 0, readyOnReloadCount: 0 });
      await loadLive({ skipInitialEnrich: true, refine: true });
    };
    const refineThreshold = Math.max(AUTO_REFINE_MIN, Math.round(unenrichedArtists.length * AUTO_REFINE_SHARE));

    hud.updateEnrichmentStatus({
      waitingCount: waitingToFetchCount,
      readyOnReloadCount: newlyResolvedForReloadCount,
      onApply: applyResolvedNow
    });

    for (let i = 0; i < unenrichedArtists.length && run === enrichRun; i += ENRICH_BATCH) {
      const batch = unenrichedArtists.slice(i, i + ENRICH_BATCH);
      try {
        // Calls Wikidata/Last.fm/MusicBrainz ONLY (never Spotify)
        const { artistMeta } = await enrichArtists(batch);
        if (run !== enrichRun) return;

        const toSave = {};
        for (const item of batch) {
          const id = item.id || item;
          const meta = artistMeta?.[id] || { g: [], c: [], t: Date.now(), l: 4 };
          // Mark as checked in localStorage so we don't re-fetch empty results on every page load
          toSave[id] = meta;
          const genres = meta.g || meta.genres;
          if (Array.isArray(genres) && genres.length > 0) {
            newlyResolvedForReloadCount++;
          }
        }
        saveArtistMeta(toSave);

        waitingToFetchCount = Math.max(0, unenrichedArtists.length - (i + batch.length));
        const finished = waitingToFetchCount === 0;
        if (newlyResolvedForReloadCount > 0 && (finished || newlyResolvedForReloadCount >= refineThreshold) && isIdle()) {
          // The refined map starts its own lookup loop for whatever is still pending.
          applyResolvedNow();
          return;
        }
        hud.updateEnrichmentStatus({
          waitingCount: waitingToFetchCount,
          readyOnReloadCount: newlyResolvedForReloadCount,
          onApply: applyResolvedNow
        });
      } catch (err) {
        console.warn('Background genre lookup stopped:', err);
        break;
      }
    }
  }

  // ---------- Start ----------

  const authError = new URLSearchParams(window.location.search).get('auth_error');
  if (authError) window.history.replaceState({}, document.title, window.location.pathname);

  const [status, storedHistory, storedSnapshot] = await Promise.all([
    getAuthStatus(),
    loadStoredHistorySummary(),
    loadStoredUniverseSnapshot()
  ]);
  authStatus = status;
  AppState.historySummary = storedHistory;
  hud.setAuthStatus(authStatus);

  // ---------- Frame loop ----------

  let lastTime = performance.now();
  let frame = 0;

  function animate(now) {
    requestAnimationFrame(animate);
    const delta = Math.min(32, now - lastTime);
    lastTime = now;

    easeViewOffset();
    layout.step(AppState.nodes, delta);
    factory.updateArtistInstances(AppState.hoveredNode);
    factory.updateTrackInstances(AppState.hoveredNode);
    factory.updateEdgeGeometry(AppState.edges);
    factory.updatePulses(AppState.pulseParticles, layout.orbitMultiplier);
    factory.updateSolarShaders(now * 0.001);
    factory.updateNebulae(camera, suns);
    factory.updateFocus(AppState.selectedNode, AppState.nodes, AppState.edges, AppState.activeLens, AppState.hoveredNode);

    cameraController.update(AppState.selectedNode);

    if (frame++ % 3 === 0) {
      const hovered = pickNode(false);
      if (hovered !== AppState.hoveredNode) {
        AppState.hoveredNode = hovered;
        renderer.domElement.style.cursor = hovered ? 'pointer' : '';
      }
    }

    labelProjector.update(
      AppState.nodes,
      camera,
      AppState.selectedNode,
      AppState.nodeScaleMultiplier,
      AppState.layers.labels,
      AppState.activeLens,
      AppState.hoveredNode
    );
    composer.render();
  }
  requestAnimationFrame(animate);

  if (storedSnapshot?.dataset && !authStatus.loggedIn && !authStatus.localHistory?.available) {
    AppState.isDemo = false;
    loadDataset(storedSnapshot.dataset);
    updateUniverseCaption(storedSnapshot.dataset);
  } else if ((authStatus.loggedIn && !authError) || authStatus.localHistory?.available || storedHistory) {
    await loadLive({ historySummary: storedHistory, useLocalHistory: true });
  } else {
    loadDemo();
    if (authError) hud.setNotice(`Spotify login didn’t complete: ${authError}`);
  }

  if (import.meta.env.DEV) window.__astra = { loadDataset, AppState };
}

window.addEventListener('DOMContentLoaded', () => {
  initApp().catch(err => console.error('Astra failed to start:', err));
});
