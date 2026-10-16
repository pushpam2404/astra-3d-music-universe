// src/main.js
import * as THREE from 'three';
import { GALAXY_PRESETS } from './config/presets.js';
import { buildUniverseGraph } from './etl/graphNormalizer.js';
import { getAuthStatus, fetchUniverse, enrichArtists } from './api/backendClient.js';
import { loadArtistMeta, saveArtistMeta } from './api/artistMetaCache.js';
import { createUniverseScene } from './renderer/universeScene.js';
import { initPostProcessing, BLOOM_STRENGTH } from './renderer/postProcessing.js';
import { CelestialFactory } from './renderer/celestialFactory.js';
import { GalaxyLayoutEngine } from './physics/galaxyLayout.js';
import { CameraFlightController } from './renderer/cameraController.js';
import { LabelProjector } from './renderer/labelProjector.js';
import { Hud } from './ui/hud.js';
import { DetailPanel } from './ui/detailPanel.js';

const AppState = {
  isDemo: true,
  nodeScaleMultiplier: 1.0,
  layers: { genres: true, artists: true, tracks: true, edges: true, labels: true },
  nodes: [],
  edges: [],
  nodeMap: new Map(),
  pulseParticles: [],
  hoveredNode: null,
  selectedNode: null
};

const ENRICH_BATCH = 40;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

async function initApp() {
  const { scene, camera, renderer, controls } = createUniverseScene(document.getElementById('webgl-canvas-container'));
  const { composer, bloomPass } = initPostProcessing(renderer, scene, camera);

  // Center the galaxy in the area the side panel leaves visible (right column on wide
  // screens, bottom sheet on phones), not in the whole window.
  // On phones the shift follows the bottom sheet, eased so the galaxy glides up/down.
  const viewShift = { x: 0, y: 0, tx: 0, ty: 0 };
  let sheetCover = () => 84; // replaced once the HUD exists
  function updateViewOffset(snap = false) {
    const narrow = window.innerWidth <= 760;
    viewShift.tx = narrow ? 0 : (320 + 16) / 2;
    // Centre in the gap between the top bar and the sheet.
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
    likedSongsConnected: () => !authStatus.missingScopes?.includes('user-library-read')
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
    onLayersChange: applyLayerVisibility,
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
    onDisconnected: () => loadDemo()
  });
  sheetCover = () => hud.sheetCover();
  updateViewOffset(true);

  // ---------- Pointer: hover and click on the canvas only ----------

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-9, -9);
  let downAt = null;
  const setPointer = (e) => pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);

  renderer.domElement.addEventListener('pointermove', setPointer);
  renderer.domElement.addEventListener('pointerleave', () => pointer.set(-9, -9));
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    // A drag rotates the view; only a tap/click selects. Fingers wobble more than mice.
    const touch = e.pointerType !== 'mouse';
    const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : Infinity;
    if (moved <= (touch ? 10 : 5)) {
      setPointer(e);
      const node = pickNode() || pickNearest(e.clientX, e.clientY, touch ? 26 : 8);
      if (node) {
        selectNode(node);
        if (touch) navigator.vibrate?.(8);
      } else if (AppState.selectedNode) clearSelection();
      else if (touch && hud.sheetOpen) hud.setSheet(false);
    }
    // Touch has no hover: don't leave a phantom hover where the finger lifted.
    if (touch) pointer.set(-9, -9);
  });
  renderer.domElement.addEventListener('pointercancel', () => pointer.set(-9, -9));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && AppState.selectedNode && document.activeElement?.tagName !== 'INPUT') clearSelection();
  });

  /** Closest sun or artist on screen within `radius` px: small planets are hard to tap exactly. */
  function pickNearest(x, y, radius) {
    let best = null, bestD = radius;
    const v = new THREE.Vector3();
    for (const n of AppState.nodes) {
      if (n.type === 'track' || !n.position || n.meshGroup?.visible === false) continue;
      if (n.type === 'artist' && !AppState.layers.artists) continue;
      v.copy(n.position).project(camera);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x + 1) / 2 * window.innerWidth - x, (1 - v.y) / 2 * window.innerHeight - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  function pickNode() {
    raycaster.setFromCamera(pointer, camera);
    const meshes = [];
    AppState.nodes.forEach(n => { if (n.sphereMesh && n.meshGroup?.visible) meshes.push(n.sphereMesh); });
    if (factory.artistMesh && AppState.layers.artists) meshes.push(factory.artistMesh);
    // Moons are only pickable once something is selected: testing thousands of them on
    // every hover isn't worth it, and moons only matter up close.
    if (factory.trackMesh && AppState.layers.tracks && AppState.selectedNode) meshes.push(factory.trackMesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit ? factory.nodeFromHit(hit) : null;
  }

  // ---------- Building a universe ----------

  function loadDataset(rawDataset) {
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

    AppState.nodes.forEach(node => { if (node.type === 'genre') factory.buildGenreSun(node); });
    factory.buildArtistPlanets(AppState.nodes.filter(n => n.type === 'artist'));
    factory.buildTrackSatellites(AppState.nodes.filter(n => n.type === 'track'));
    const edgeData = factory.buildEdgeVisuals(AppState.edges);
    edgeGroup = edgeData.edgeLinesGroup;
    AppState.pulseParticles = edgeData.pulseParticles;
    if (AppState.nodeScaleMultiplier !== 1) AppState.nodes.forEach(n => n.meshGroup?.scale.setScalar(AppState.nodeScaleMultiplier));

    suns = AppState.nodes.filter(n => n.type === 'genre');
    labelProjector.syncLabels(AppState.nodes, selectNode);
    hud.renderClusters(AppState.nodes.filter(n => n.type === 'genre'));
    hud.showClusters();
    hud.restoreSettings();
    applyLayerVisibility();
    cameraController.resetOverview();
  }

  function applyLayerVisibility() {
    const show = { genre: AppState.layers.genres, artist: AppState.layers.artists, track: AppState.layers.tracks };
    AppState.nodes.forEach(n => { if (n.meshGroup) n.meshGroup.visible = show[n.type]; });
    if (factory.trackMesh) factory.trackMesh.visible = AppState.layers.tracks;
    if (factory.artistMesh) factory.artistMesh.visible = factory.artistDecor.visible = AppState.layers.artists;
    if (edgeGroup) edgeGroup.visible = AppState.layers.edges;
  }

  function loadDemo() {
    AppState.isDemo = true;
    loadDataset(GALAXY_PRESETS.cosmic_synth);
    hud.setCaption('A demo universe', 'Connect Spotify to map your own listening.');
    hud.setNotice(null);
  }

  async function loadLive() {
    hud.setLoading(true);
    try {
      const { dataset, artistMeta, diagnostics } = await fetchUniverse(loadArtistMeta());
      saveArtistMeta(artistMeta);
      console.info('[Astra] universe diagnostics:', diagnostics);
      if (!dataset) {
        loadDemo();
        hud.setNotice('Spotify has no listening data for this account yet.');
        return;
      }
      AppState.isDemo = false;
      loadDataset(dataset);
      hud.setCaption('Your music universe', `${plural(dataset.artists.length, 'artist')} and ${plural(dataset.tracks.length, 'song')} in ${plural(dataset.genres.length, 'cluster')}`);

      if (authStatus.missingScopes?.includes('user-library-read')) {
        hud.setNotice('Your Liked Songs aren’t included yet.', { label: 'Reconnect Spotify', run: () => document.getElementById('spotify-btn').click() });
      } else {
        hud.setNotice(null);
      }
      if (diagnostics.pendingArtists?.length) enrichInBackground(diagnostics.pendingArtists);
    } catch (err) {
      console.error('Failed to load Spotify universe:', err);
      loadDemo();
      if (err.status === 401) {
        authStatus = { ...authStatus, loggedIn: false };
        hud.setAuthStatus(authStatus);
      }
      hud.setNotice(err.message, err.status === 401 || err.status === 429 ? null : { label: 'Try again', run: loadLive });
    } finally {
      hud.setLoading(false);
    }
  }

  /**
   * Looks up genres for the artists the load didn't get to, a batch at a time, while
   * the page is open. Progress is saved in the browser, so closing the tab loses
   * nothing; "Update map" re-arranges the universe with what was learned.
   */
  let enrichRun = 0;
  async function enrichInBackground(pending) {
    const run = ++enrichRun;
    const total = pending.length;
    let finished = 0;
    const updateAction = { label: 'Update map', run: () => { enrichRun++; loadLive(); } };
    for (let i = 0; i < pending.length && run === enrichRun; i += ENRICH_BATCH) {
      if (!authStatus.missingScopes?.length) {
        hud.setNotice(`Looking up genres in the background: ${plural(finished, 'artist')} of ${total.toLocaleString()} done.`, finished ? updateAction : null);
      }
      try {
        const { artistMeta } = await enrichArtists(pending.slice(i, i + ENRICH_BATCH));
        saveArtistMeta(artistMeta);
        finished += Object.keys(artistMeta).length;
      } catch (err) {
        console.warn('Background genre lookup stopped:', err);
        break;
      }
    }
    if (run === enrichRun && finished && !authStatus.missingScopes?.length) {
      hud.setNotice(`Found genres for ${plural(finished, 'more artist')}.`, updateAction);
    }
  }

  // ---------- Start ----------

  const authError = new URLSearchParams(window.location.search).get('auth_error');
  if (authError) window.history.replaceState({}, document.title, window.location.pathname);

  authStatus = await getAuthStatus();
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
    factory.updateArtistInstances();
    factory.updateTrackInstances();
    factory.updateEdgeGeometry(AppState.edges);
    factory.updatePulses(AppState.pulseParticles, layout.orbitMultiplier);
    factory.updateSolarShaders(now * 0.001);
    factory.updateNebulae(camera, suns);
    factory.updateFocus(AppState.selectedNode || AppState.hoveredNode, AppState.nodes, AppState.edges);

    cameraController.update(AppState.selectedNode);

    // Hover every 3rd frame: raycasting thousands of moons isn't free.
    if (frame++ % 3 === 0) {
      const hovered = pickNode();
      if (hovered !== AppState.hoveredNode) {
        AppState.hoveredNode = hovered;
        renderer.domElement.style.cursor = hovered ? 'pointer' : '';
      }
    }

    labelProjector.update(AppState.nodes, camera, AppState.selectedNode || AppState.hoveredNode, AppState.nodeScaleMultiplier, AppState.layers.labels);
    composer.render();
  }
  requestAnimationFrame(animate);

  if (authStatus.loggedIn && !authError) {
    await loadLive();
  } else {
    loadDemo();
    if (authError) hud.setNotice(`Spotify login didn’t complete: ${authError}`);
  }

  // Dev-only hook for loading arbitrary datasets from the console.
  if (import.meta.env.DEV) window.__astra = { loadDataset, AppState };
}

window.addEventListener('DOMContentLoaded', () => {
  initApp().catch(err => console.error('Astra failed to start:', err));
});
