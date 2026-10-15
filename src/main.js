// src/main.js
import * as THREE from 'three';
import { GALAXY_PRESETS } from './config/presets.js';
import { buildUniverseGraph } from './etl/graphNormalizer.js';
import { getAuthStatus, fetchUniverse } from './api/backendClient.js';
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

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

async function initApp() {
  const { scene, camera, renderer, controls } = createUniverseScene(document.getElementById('webgl-canvas-container'));
  const { composer, bloomPass } = initPostProcessing(renderer, scene, camera);

  // Center the galaxy in the area the side panel leaves visible (right column on wide
  // screens, bottom sheet on phones), not in the whole window.
  function updateViewOffset() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const narrow = w <= 760;
    const shiftX = narrow ? 0 : (320 + 16) / 2;
    const shiftY = narrow ? h * 0.21 : 0;
    camera.setViewOffset(w, h, shiftX, shiftY, w, h);
  }
  updateViewOffset();
  window.addEventListener('resize', updateViewOffset);

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

  // ---------- Pointer: hover and click on the canvas only ----------

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-9, -9);
  let downAt = null;
  const setPointer = (e) => pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);

  renderer.domElement.addEventListener('pointermove', setPointer);
  renderer.domElement.addEventListener('pointerleave', () => pointer.set(-9, -9));
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    // A drag rotates the view; only a tap/click selects.
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    setPointer(e);
    const node = pickNode();
    if (node) selectNode(node);
    else if (AppState.selectedNode) clearSelection();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && AppState.selectedNode && document.activeElement?.tagName !== 'INPUT') clearSelection();
  });

  function pickNode() {
    raycaster.setFromCamera(pointer, camera);
    const meshes = [];
    AppState.nodes.forEach(n => { if (n.sphereMesh && n.meshGroup?.visible) meshes.push(n.sphereMesh); });
    if (factory.trackMesh && AppState.layers.tracks) meshes.push(factory.trackMesh);
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

    AppState.nodes.forEach(node => {
      if (node.type === 'genre') factory.buildGenreSun(node);
      else if (node.type === 'artist') factory.buildArtistPlanet(node);
    });
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
      } else if (diagnostics.lastfm?.pending) {
        hud.setNotice(`Genres for ${plural(diagnostics.lastfm.pending, 'artist')} are still being looked up; they’ll appear on your next visit.`);
      } else {
        hud.setNotice(null);
      }
    } catch (err) {
      console.error('Failed to load Spotify universe:', err);
      loadDemo();
      if (err.status === 401) {
        authStatus = { ...authStatus, loggedIn: false };
        hud.setAuthStatus(authStatus);
      }
      hud.setNotice(err.message, err.status === 401 ? null : { label: 'Try again', run: loadLive });
    } finally {
      hud.setLoading(false);
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

    layout.step(AppState.nodes, delta);
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
