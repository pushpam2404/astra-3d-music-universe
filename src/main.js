// src/main.js
import * as THREE from 'three';
import { GALAXY_PRESETS } from './config/presets.js';
import { buildUniverseGraph } from './etl/graphNormalizer.js';
import { getAuthStatus, fetchUniverse } from './api/backendClient.js';
import { collideGalaxies } from './etl/galaxyCollider.js';
import { TemporalUniverseScrubber } from './etl/timeMachine4D.js';
import { createUniverseScene } from './renderer/universeScene.js';
import { initPostProcessing } from './renderer/postProcessing.js';
import { CelestialFactory } from './renderer/celestialFactory.js';
import { GalaxyLayoutEngine } from './physics/galaxyLayout.js';
import { CameraFlightController } from './renderer/cameraController.js';
import { LabelProjector } from './renderer/labelProjector.js';
import { SonicDnaSynthesizer } from './audio/sonicSynthesizer.js';
import { InspectorDrawer } from './ui/inspectorDrawer.js';
import { HudController } from './ui/hudController.js';
import { CosmicCinemaDirector } from './ui/cinemaExporter.js';

// Master Global State Store (Blueprint 01)
const AppState = {
  activePreset: 'cosmic_synth',
  timeRange: 'medium_term',
  layoutMode: 'force',
  orbitSpeedMultiplier: 1.0,
  nodeScaleMultiplier: 1.0,
  autoPilotActive: false,
  spotifyConnected: false,
  layers: {
    genres: true,
    artists: true,
    tracks: true,
    edges: true,
    labels: true
  },
  nodes: [],
  edges: [],
  nodeMap: new Map(),
  pulseParticles: [],
  hoveredNode: null,
  selectedNode: null
};

// Application Bootstrapper
async function initApp() {
  const canvasContainer = document.getElementById('webgl-canvas-container');
  const labelsContainer = document.getElementById('hud-labels-container');
  const inspectorEl = document.getElementById('inspector-drawer');

  // 1. Initialize Scene & Renderer
  const { scene, camera, renderer, controls } = createUniverseScene(canvasContainer);

  // 2. Initialize Post-Processing & Warp Shader
  const { composer, warpPass } = initPostProcessing(renderer, scene, camera);

  // 3. Initialize Engines & Controllers
  const factory = new CelestialFactory(scene);
  const physics = new GalaxyLayoutEngine();
  const cameraController = new CameraFlightController(camera, controls);
  const labelProjector = new LabelProjector(labelsContainer);
  const synth = new SonicDnaSynthesizer();
  const inspector = new InspectorDrawer(inspectorEl, synth, cameraController);
  const cinemaDirector = new CosmicCinemaDirector(renderer, camera, controls, synth);

  cameraController.onWarpChange = (intensity) => {
    warpPass.uniforms.uWarpIntensity.value = intensity;
  };

  let timeMachine = new TemporalUniverseScrubber();
  let edgeGroup = null;

  // 4. Raycaster & Pointer Interaction
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2(-999, -999);
  let isPointerDown = false;
  let pointerDownPos = { x: 0, y: 0 };

  window.addEventListener('mousemove', (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });

  window.addEventListener('pointerdown', (e) => {
    isPointerDown = true;
    pointerDownPos = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener('pointerup', (e) => {
    if (!isPointerDown) return;
    isPointerDown = false;

    // Detect click vs drag (tolerance: 5 pixels)
    const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    if (dist < 6) {
      handleRaycastClick(e);
    }
  });

  function getIntersectedNode() {
    raycaster.setFromCamera(mouse, camera);
    const meshes = AppState.nodes.map(n => n.sphereMesh).filter(Boolean);
    const intersects = raycaster.intersectObjects(meshes, false);
    if (intersects.length > 0) {
      return intersects[0].object.userData.node;
    }
    return null;
  }

  function handleRaycastClick(e) {
    // Avoid clicking through UI overlays
    if (e.target.closest('#inspector-drawer') || e.target.closest('#hud-nav-bar') || e.target.closest('.modal-overlay')) {
      return;
    }

    const clickedNode = getIntersectedNode();
    if (clickedNode) {
      selectNode(clickedNode);
    } else if (AppState.selectedNode) {
      // Clicking empty space releases the focus.
      AppState.selectedNode = null;
      inspector.close();
    }
  }

  function selectNode(node) {
    AppState.selectedNode = node;
    cameraController.flyToNode(node);
    inspector.open(node);
  }

  inspector.onNodeSelected = (node) => selectNode(node);
  inspector.resolveNode = (id) => AppState.nodeMap.get(id);

  // 5. Load and Rebuild Graph Universe
  function loadDataset(rawDataset, timeMultiplier = 1.0) {
    // Clear previous celestial meshes from scene
    AppState.nodes.forEach(n => {
      if (n.meshGroup) scene.remove(n.meshGroup);
    });
    if (edgeGroup) {
      scene.remove(edgeGroup);
      edgeGroup = null;
    }
    AppState.pulseParticles = [];
    factory.solarMaterials = [];

    // Normalize graph
    const graphData = buildUniverseGraph(rawDataset, timeMultiplier);
    AppState.nodes = graphData.nodes;
    AppState.edges = graphData.edges;
    AppState.nodeMap = graphData.nodeMap;

    // Lay out the galaxy and frame the camera around it
    physics.initializeNodePositions(AppState.nodes);
    cameraController.setSceneRadius(physics.boundingRadius);

    // Build 3D meshes for each tier
    AppState.nodes.forEach(node => {
      if (node.type === 'genre') {
        factory.buildGenreSun(node);
      } else if (node.type === 'artist') {
        factory.buildArtistPlanet(node);
      } else if (node.type === 'track') {
        factory.buildTrackSatellite(node);
      }
    });

    // Build synaptic edge network
    const edgeData = factory.buildEdgeVisuals(AppState.edges);
    edgeGroup = edgeData.edgeLinesGroup;
    AppState.pulseParticles = edgeData.pulseParticles;

    // Project labels
    labelProjector.syncLabels(AppState.nodes, (node) => selectNode(node));

    // Update active preset info in HUD
    const titleEl = document.getElementById('galaxy-title-text');
    const descEl = document.getElementById('galaxy-desc-text');
    if (titleEl) titleEl.textContent = rawDataset.name || 'ASTRA Galaxy';
    if (descEl) descEl.textContent = rawDataset.description || '';

    hud.renderClusterLegend(AppState.nodes.filter(n => n.type === 'genre'));

    // Apply layer visibility
    applyLayerVisibility();
  }

  function applyLayerVisibility() {
    AppState.nodes.forEach(n => {
      if (n.meshGroup) {
        if (n.type === 'genre') n.meshGroup.visible = AppState.layers.genres;
        if (n.type === 'artist') n.meshGroup.visible = AppState.layers.artists;
        if (n.type === 'track') n.meshGroup.visible = AppState.layers.tracks;
      }
    });
    if (edgeGroup) {
      edgeGroup.visible = AppState.layers.edges;
    }
  }

  // 6. HUD Controller & Callbacks
  const hud = new HudController(AppState, {
    onLoadPreset: (presetId) => {
      AppState.activePreset = presetId;
      const dataset = GALAXY_PRESETS[presetId] || GALAXY_PRESETS.cosmic_synth;
      timeMachine = new TemporalUniverseScrubber();
      loadDataset(dataset);
      cameraController.resetOverview();
    },

    onTimeRangeChange: async (range) => {
      if (AppState.activePreset === 'live_spotify') {
        await loadLiveSpotify(range);
      } else {
        // Multiplier fallback for presets
        const mult = range === 'short_term' ? 0.6 : (range === 'long_term' ? 1.7 : 1.0);
        const preset = GALAXY_PRESETS[AppState.activePreset] || GALAXY_PRESETS.cosmic_synth;
        loadDataset(preset, mult);
      }
    },

    onSelectNode: (node) => selectNode(node),

    onLayerVisibilityChange: (layer, visible) => {
      applyLayerVisibility();
    },

    onLayoutModeChange: (mode) => {
      physics.layoutMode = mode;
    },

    onOrbitSpeedChange: (speed) => {
      physics.orbitMultiplier = speed;
    },

    onNodeScaleChange: (scale) => {
      physics.nodeScaleMultiplier = scale;
      AppState.nodes.forEach(n => {
        if (n.meshGroup) {
          n.meshGroup.scale.setScalar(scale);
        }
      });
    },

    onResetCamera: () => {
      AppState.selectedNode = null;
      inspector.close();
      cameraController.resetOverview();
    },

    onAutoPilotToggle: (active) => {
      if (active) {
        cameraController.startAutoPilot(AppState.nodes);
      } else {
        cameraController.stopAutoPilot();
      }
    },

    onStartCinemaRecording: (onProgress, onComplete) => {
      // Auto-start sonic signature of top genre or artist during recording
      const topNode = AppState.nodes.find(n => n.type === 'genre') || AppState.nodes[0];
      if (topNode) synth.playNodeSignature(topNode);

      cinemaDirector.startCinematicRecording(AppState.nodes, 14000, onProgress, () => {
        synth.stop();
        if (onComplete) onComplete();
      });
    },

    onTimeScrub: (u) => {
      return timeMachine.evaluateAtProgress(u, AppState.nodes);
    },

    onCustomHistoryLoaded: (dataset, rawEvents) => {
      AppState.activePreset = 'custom_upload';
      timeMachine = new TemporalUniverseScrubber(rawEvents);
      loadDataset(dataset);
      cameraController.resetOverview();
    },

    onTriggerCollision: (idA, idB) => {
      const presetA = GALAXY_PRESETS[idA] || GALAXY_PRESETS.cosmic_synth;
      const presetB = GALAXY_PRESETS[idB] || GALAXY_PRESETS.hyper_bass;

      const graphA = buildUniverseGraph(presetA);
      const graphB = buildUniverseGraph(presetB);

      const collisionResult = collideGalaxies(graphA, graphB);

      // Re-populate and render collision graph
      AppState.activePreset = 'collision_mode';
      loadDataset({
        id: 'collision',
        name: `${presetA.name.split('&')[0]} ✕ ${presetB.name.split('&')[0]} Collision`,
        description: 'Binary Star Merger with L1 Lagrange Bridge of shared musical taste.',
        genres: collisionResult.nodes.filter(n => n.type === 'genre'),
        artists: collisionResult.nodes.filter(n => n.type === 'artist'),
        tracks: collisionResult.nodes.filter(n => n.type === 'track')
      });

      hud.showCollisionBanner(collisionResult.metrics);
      cameraController.resetOverview();
    }
  });

  function showNotice(message) {
    const descEl = document.getElementById('galaxy-desc-text');
    if (descEl) descEl.textContent = `⚠ ${message}`;
  }

  // Loads the user's live universe from the backend. Returns true on success;
  // on failure, keeps whatever is currently rendered and shows the reason.
  async function loadLiveSpotify(range) {
    try {
      const { dataset, diagnostics } = await fetchUniverse(range);
      console.info('[ASTRA] Spotify universe diagnostics:', diagnostics);
      if (!dataset) {
        showNotice(diagnostics.warnings.join(' '));
        return false;
      }
      AppState.activePreset = 'live_spotify';
      loadDataset(dataset);
      cameraController.resetOverview();
      if (diagnostics.warnings.length) showNotice(diagnostics.warnings.join(' '));
      return true;
    } catch (err) {
      console.error('Failed to load Spotify universe:', err);
      if (err.status === 401) hud.setSpotifyConnected(false);
      showNotice(err.message);
      return false;
    }
  }

  // 7. Restore backend Spotify session (OAuth callback redirects back to "/")
  const authError = new URLSearchParams(window.location.search).get('auth_error');
  if (authError) window.history.replaceState({}, document.title, window.location.pathname);

  loadDataset(GALAXY_PRESETS.cosmic_synth);
  cameraController.resetOverview();
  const authStatus = await getAuthStatus();
  hud.setAuthStatus(authStatus);
  if (authError) {
    showNotice(`Spotify login failed: ${authError}`);
  } else if (authStatus.loggedIn) {
    await loadLiveSpotify(AppState.timeRange);
  }

  // 8. Master Animation & Render Loop (60 FPS)
  let lastTime = performance.now();

  function animate(now) {
    requestAnimationFrame(animate);

    const delta = Math.min(32, now - lastTime);
    lastTime = now;
    const timeSec = now * 0.001;

    // 1. Step 3D Physics Engine
    physics.step(AppState.nodes, delta);
    physics.updateEdgeLines(AppState.edges);
    physics.updateSynapticPulses(AppState.pulseParticles, physics.orbitMultiplier);

    // 2. Update GLSL Solar Plasma Noise Shaders and focus dimming
    factory.updateSolarShaders(timeSec);
    factory.updateFocus(AppState.selectedNode || AppState.hoveredNode, AppState.nodes, AppState.edges);

    // 3. Update Camera Flight or Cinema Spline
    if (cinemaDirector.isRecording) {
      cinemaDirector.updateCinemaCamera(now);
    } else {
      cameraController.update(AppState.selectedNode, now);
    }

    // 4. Update Hovered Node Highlight Cursor
    const hovered = getIntersectedNode();
    if (hovered !== AppState.hoveredNode) {
      AppState.hoveredNode = hovered;
      document.body.style.cursor = hovered ? 'pointer' : 'default';
    }

    // 5. Update Frustum Projected 2D HTML Labels
    labelProjector.update(
      AppState.nodes,
      camera,
      AppState.selectedNode || AppState.hoveredNode,
      AppState.nodeScaleMultiplier,
      AppState.layers.labels
    );

    // 6. Render Inspector Drawer Audio Spectrum
    inspector.renderSpectrum();

    // 7. Render Scene with HDR Bloom & Chromatic Warp Post-Processing
    composer.render();
  }

  requestAnimationFrame(animate);
}

// Boot application when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  initApp().catch(err => console.error('ASTRA Initialization Error:', err));
});
