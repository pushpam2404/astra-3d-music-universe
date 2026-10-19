// src/renderer/celestialFactory.js
import * as THREE from 'three';
import { createSolarShaderMaterial } from './shaders/solarPlasmaShader.js';
import { createPlanetMaterial, createMoonCrystalMaterial } from './shaders/planetShader.js';
import { COLOR_SPOTIFY_GREEN } from '../config/constants.js';

const glowTextureCache = new Map();
const nebulaTextureCache = new Map();

const FOCUS_LERP = 0.18;
const SUN_LIGHT_INTENSITY = 1.2;
const NEBULA_OPACITY = 0.13;
const MAX_PULSES = 450;
// Only the most-played artists get an individual glow halo in overview (each halo is a draw call).
const HALO_LIMIT = 320;
const COLLAB_CYAN = '#38bdf8';
const COLLAB_CYAN_LIGHT = '#7dd3fc';
const COLLAB_GOLD = '#FFB800';
const STARLIGHT_HEX = '#FFF3D1';

const EDGE_STYLE = {
  artist_genre: { opacity: 0.07, focused: 0.52 },
  artist_bridge: { opacity: 0.04, focused: 0.65 },
  track_artist: { opacity: 0.035, focused: 0.82 },
  track_collab: { opacity: 0.025, focused: 0.98 }
};

/**
 * Checks whether an artist or track node matches the active Time & Memory Lens.
 */
export function nodeMatchesLens(node, lens) {
  if (!lens || lens === 'all') return true;
  if (!node) return false;
  const h = node.history;
  if (lens === 'current_rotation') {
    if (h?.tags?.includes('current_rotation') || h?.status === 'current_rotation') return true;
    if (node.ranks?.short_term || node.recentPlays > 0) return true;
    return false;
  }
  if (!h) return false;
  if (h.status === lens) return true;
  if (Array.isArray(h.tags) && h.tags.includes(lens)) return true;
  return false;
}

/**
 * Standalone helper for Artist Isolation Mode (Hard Visibility Culling + Primary vs. Collab differentiation).
 * Works with both explicit mesh arrays (`artistMeshes`, `moonMeshes`, `sunMeshes`, `nebulaMeshes`)
 * and Astra's instanced node graph (`nodes`, `edges`, `factory`).
 */
export function applyArtistIsolationMode(sceneState, selectedArtistId) {
  if (!sceneState) return;

  // Support Astra's instanced CelestialFactory + nodes graph directly if passed
  if (sceneState.factory && Array.isArray(sceneState.nodes)) {
    const targetNode = selectedArtistId
      ? sceneState.nodes.find(n => n.id === selectedArtistId) || null
      : null;
    sceneState.factory.updateFocus(targetNode, sceneState.nodes, sceneState.edges || [], sceneState.activeLens || 'all');
    return;
  }

  const {
    artistMeshes = [],
    moonMeshes = [],
    sunMeshes = [],
    nebulaMeshes = [],
    graph = { tracks: [] }
  } = sceneState;

  if (!selectedArtistId) {
    artistMeshes.forEach((m) => {
      m.visible = true;
      m.scale.setScalar(m.userData?.baseScale || 1);
      if (m.material && 'emissiveIntensity' in m.material) m.material.emissiveIntensity = 1.0;
      if (m.userData?.collabRing) m.userData.collabRing.visible = false;
      if (m.userData?.selectionCorona) m.userData.selectionCorona.visible = false;
    });
    moonMeshes.forEach((m) => {
      m.visible = true;
      m.scale.setScalar(m.userData?.baseScale || 1);
      if (m.material && 'emissiveIntensity' in m.material) m.material.emissiveIntensity = 1.0;
    });
    sunMeshes.forEach((s) => { s.visible = true; });
    nebulaMeshes.forEach((n) => { n.visible = true; });
    return;
  }

  const activeSongIds = new Set();
  const collabArtistIds = new Set();

  // 1. Collect all songs belonging to the selected artist & any co-credited artists
  for (const song of (graph.tracks || [])) {
    const isSelectedSong =
      song.artistIds?.includes(selectedArtistId) ||
      song.featArtistIds?.includes(selectedArtistId) ||
      song.primaryArtistId === selectedArtistId ||
      song.artistId === selectedArtistId;
    if (isSelectedSong) {
      activeSongIds.add(song.id);
      const credited = song.artistIds || [song.artistId, ...(song.featArtistIds || [])].filter(Boolean);
      credited.forEach((aid) => {
        if (aid && aid !== selectedArtistId) collabArtistIds.add(aid);
      });
    }
  }

  // 2. Hide all cluster suns and nebulae completely so they never cross the camera
  sunMeshes.forEach((s) => { s.visible = false; });
  nebulaMeshes.forEach((n) => { n.visible = false; });

  // 3. Update Artist Planets: Main glows bright, Collabs get cyan ring, Others vanish completely
  artistMeshes.forEach((mesh) => {
    const id = mesh.userData?.artistId ?? mesh.userData?.node?.id;
    const baseScale = mesh.userData?.baseScale || 1;

    if (id === selectedArtistId) {
      mesh.visible = true;
      mesh.scale.setScalar(baseScale * 1.38);
      if (mesh.material) mesh.material.emissiveIntensity = 2.8;
      if (mesh.userData?.collabRing) mesh.userData.collabRing.visible = false;
      if (mesh.userData?.selectionCorona) mesh.userData.selectionCorona.visible = true;
    } else if (collabArtistIds.has(id)) {
      mesh.visible = true;
      mesh.scale.setScalar(baseScale * 1.08);
      if (mesh.material) mesh.material.emissiveIntensity = 1.15;
      if (mesh.userData?.collabRing) mesh.userData.collabRing.visible = true;
      if (mesh.userData?.selectionCorona) mesh.userData.selectionCorona.visible = false;
    } else {
      mesh.visible = false;
    }
  });

  // 4. Update Song Moons: Selected artist's songs glow brightly, all other moons vanish
  moonMeshes.forEach((moon) => {
    const id = moon.userData?.trackId ?? moon.userData?.node?.id;
    const baseScale = moon.userData?.baseScale || 1;

    if (activeSongIds.has(id)) {
      moon.visible = true;
      moon.scale.setScalar(baseScale * 1.45);
      if (moon.material) moon.material.emissiveIntensity = 2.25;
    } else {
      moon.visible = false;
    }
  });
}

/**
 * Radial glow sprite texture rendered on an offscreen canvas (no external assets).
 */
export function getProceduralGlowTexture(hexColor) {
  if (glowTextureCache.has(hexColor)) return glowTextureCache.get(hexColor);

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(hexColor);
  const rgb = `${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}`;

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  gradient.addColorStop(0.0, 'rgba(255, 255, 255, 0.95)');
  gradient.addColorStop(0.18, `rgba(${rgb}, 0.82)`);
  gradient.addColorStop(0.48, `rgba(${rgb}, 0.22)`);
  gradient.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  glowTextureCache.set(hexColor, texture);
  return texture;
}

/**
 * Wispy nebula cloud: overlapping soft blobs, deterministic per color.
 */
function getNebulaTexture(hexColor) {
  if (nebulaTextureCache.has(hexColor)) return nebulaTextureCache.get(hexColor);

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(hexColor);
  const rgb = `${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}`;

  let seed = parseInt(hexColor.replace('#', ''), 16) || 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 14; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = rand() * size * 0.22;
    const x = size / 2 + Math.cos(angle) * dist;
    const y = size / 2 + Math.sin(angle) * dist;
    const r = size * (0.16 + rand() * 0.22);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb}, ${0.22 + rand() * 0.14})`);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size / 2);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  nebulaTextureCache.set(hexColor, texture);
  return texture;
}

function createRing(innerR, outerR, colorHex, opacity, tiltX = Math.PI / 2.2, tiltY = Math.PI / 7.0) {
  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colorHex),
    side: THREE.DoubleSide,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(innerR, outerR, 72), ringMat);
  ring.rotation.x = tiltX;
  ring.rotation.y = tiltY;
  return ring;
}

/**
 * Creates a distinct cyan dashed orbital halo ring loop for Collaborator Artists
 * so they immediately read as linked via a shared track rather than the primary selection.
 */
function createDashedOrbitLoop(radius, colorHex = COLLAB_CYAN, opacity = 0.92, tiltX = Math.PI / 2.2, tiltY = 0) {
  const segments = 64;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, 0));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(pts);
  const material = new THREE.LineDashedMaterial({
    color: new THREE.Color(colorHex),
    transparent: true,
    opacity,
    dashSize: Math.max(0.35, radius * 0.16),
    gapSize: Math.max(0.22, radius * 0.1),
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const line = new THREE.Line(geometry, material);
  line.computeLineDistances();
  line.rotation.x = tiltX;
  line.rotation.y = tiltY;
  return line;
}

function makeSprite(texture, size, opacity) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  }));
  sprite.scale.set(size, size, 1);
  return sprite;
}

/**
 * Builds and styles the celestial meshes:
 *  - Genre Suns: plasma shader spheres with solar corona & nebula
 *  - Artist Planets: textured spheres (`SphereGeometry(1, 32, 32)`) wrapped with atmospheric
 *    rim shader and tilted planetary rings (`RingGeometry`) for high-play artists
 *  - Song Moons: faceted crystalline icosahedrons (`IcosahedronGeometry(1, 0)` with flatShading)
 *    tethered to their parent artist via subtle orbital ring paths
 *  - Dynamic Focus Overlay: pulsing golden/white corona sprite on the main selected artist,
 *    distinct cyan dashed orbital halo rings on collaborator artists, and glowing diamond
 *    halos on the selected artist's song moons.
 */
export class CelestialFactory {
  constructor(scene) {
    this.scene = scene;
    this.solarMaterials = [];
    this.focusKey = null;
    this.glow = 1;
    this.focusHighlightGroup = new THREE.Group();
    this.scene.add(this.focusHighlightGroup);
    this.dynamicTrackHalos = [];
    this.dynamicCollabMarkers = [];
    this.mainArtistBeacon = null;
  }

  register(node, material, baseOpacity, isUniform = false, isGlow = false) {
    node.fadeTargets = node.fadeTargets || [];
    node.fadeTargets.push({ material, baseOpacity, isUniform, isGlow });
  }

  applyFade(node) {
    const fl = node.focusLevel ?? 1;
    node.fadeTargets?.forEach(({ material, baseOpacity, isUniform, isGlow }) => {
      const v = baseOpacity * Math.min(1.5, fl) * (isGlow ? this.glow : 1);
      if (isUniform && material.uniforms?.uOpacity) material.uniforms.uOpacity.value = v;
      else material.opacity = v;
    });
    if (node.shaderMaterial?.uniforms?.uOpacity) {
      node.shaderMaterial.uniforms.uOpacity.value = Math.min(1, fl);
    }
    if (node.type === 'genre' && node.sphereMesh) {
      // Hard visibility culling: hide sun sphere, ring, corona, nebula, and point light completely when culled
      const sunVisible = fl >= 0.05 && (node.focusTarget ?? 1) > 0;
      node.sphereMesh.visible = sunVisible;
      if (node.ring) node.ring.visible = sunVisible;
      if (node.nebula) node.nebula.visible = sunVisible;
      if (node.sprite) node.sprite.visible = sunVisible;
      if (node.light) node.light.visible = sunVisible;
    }
    if (node.light) node.light.intensity = SUN_LIGHT_INTENSITY * this.glow * Math.min(1.2, fl);
  }

  setGlow(level, nodes) {
    this.glow = level;
    nodes.forEach(n => this.applyFade(n));
  }

  buildGenreSun(node) {
    const group = new THREE.Group();
    group.position.copy(node.position);

    const shaderMat = createSolarShaderMaterial(node.color, node.energy || 0.8);
    this.solarMaterials.push(shaderMat);
    const sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(node.baseRadius, 48, 48), shaderMat);
    sphereMesh.userData = { node };
    group.add(sphereMesh);

    const ring = createRing(node.baseRadius * 1.5, node.baseRadius * 1.62, node.color, 0.45);
    group.add(ring);
    this.register(node, ring.material, 0.45);

    const corona = makeSprite(getProceduralGlowTexture(node.color), node.haloRadius || node.baseRadius * 4, 0.55);
    group.add(corona);
    this.register(node, corona.material, 0.55, false, true);

    const nebulaSize = (node.clusterRadius || 60) * 1.9;
    const nebula = makeSprite(getNebulaTexture(node.color), nebulaSize, NEBULA_OPACITY);
    nebula.renderOrder = -1;
    group.add(nebula);
    node.nebula = nebula;

    node.light = new THREE.PointLight(node.color, SUN_LIGHT_INTENSITY * this.glow, (node.clusterRadius || 80) * 1.6, 1.2);
    group.add(node.light);

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
    node.ring = ring;
    node.sprite = corona;
    node.shaderMaterial = shaderMat;
    this.scene.add(group);
    return group;
  }

  buildArtistPlanets(artistNodes) {
    const n = Math.max(1, artistNodes.length);
    const geometry = new THREE.SphereGeometry(1, 32, 32);
    const info = new Float32Array(n * 3);
    const mesh = new THREE.InstancedMesh(geometry, createPlanetMaterial(), n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    const decor = new THREE.Group();
    const byListening = artistNodes.slice().sort((a, b) => (b.normScore ?? 0) - (a.normScore ?? 0));
    const haloSet = new Set(byListening.slice(0, HALO_LIMIT));

    artistNodes.forEach((node, i) => {
      const listen = node.normScore ?? 1;
      const seed = (parseInt(String(node.id).slice(-6), 36) % 990) / 1000 + 0.005;
      node.artistIndex = i;
      node.seedFrac = seed;
      node.roleCode = 0; // 0 = normal, 1 = selected main artist, 2 = collaborator artist
      node.lensScale = 1.0;
      node.meshGroup = { position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1), visible: true, isInstanceHandle: true };
      mesh.setColorAt(i, new THREE.Color(node.color));
      info[i * 3] = listen;
      info[i * 3 + 1] = 1.0;
      info[i * 3 + 2] = seed;

      node.decor = [];
      if (haloSet.has(node)) {
        const haloOpacity = 0.06 + 0.26 * listen * listen;
        const glow = makeSprite(getProceduralGlowTexture(node.color), node.baseRadius * 3.1, haloOpacity);
        glow.userData.size = 3.1;
        decor.add(glow);
        node.decor.push(glow);
        this.register(node, glow.material, haloOpacity, false, true);
      }
      // Tilted planetary rings (RingGeometry) for high-play & past-favorite artists
      if ((node.labelRank < 8 && !node.isBridge) || node.history?.status === 'past_fav' || listen > 0.55) {
        const ringColor = node.history?.status === 'past_fav' ? '#F4E9C8' : node.color;
        const ringOpacity = node.labelRank === 0 ? 0.38 : 0.25;
        const ring = createRing(1.38, 1.82, ringColor, ringOpacity);
        ring.userData.size = 1;
        decor.add(ring);
        node.decor.push(ring);
        this.register(node, ring.material, ringOpacity);
      }
    });
    geometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 3));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.artistMesh = mesh;
    this.artistNodes = artistNodes;
    this.artistInfo = geometry.getAttribute('aInfo');
    this.artistDecor = decor;
    this.scene.add(mesh, decor);
  }

  updateArtistInstances() {
    if (!this.artistMesh) return;
    const m = this._am || (this._am = new THREE.Matrix4());
    const q = this._aq || (this._aq = new THREE.Quaternion());
    const sc = this._as || (this._as = new THREE.Vector3());
    for (const node of this.artistNodes) {
      const h = node.meshGroup;
      const fl = node.focusLevel ?? 1;
      const ft = node.focusTarget ?? 1;
      // Hard Visibility Culling: scale culled instances to (0, 0, 0) so unselected planets never cross the camera
      const activeVisible = h.visible && fl >= 0.06 && ft > 0.0;
      const r = activeVisible ? node.baseRadius * (node.lensScale ?? 1) : 0;
      sc.copy(h.scale).multiplyScalar(r);
      m.compose(h.position, q, sc);
      this.artistMesh.setMatrixAt(node.artistIndex, m);

      for (const d of node.decor) {
        d.visible = activeVisible;
        if (!activeVisible) continue;
        d.position.copy(h.position);
        const s = r * h.scale.x * d.userData.size;
        if (d.isSprite) d.scale.set(s, s, 1);
        else d.scale.setScalar(s);
      }
    }
    this.artistMesh.instanceMatrix.needsUpdate = true;
    this.updateFocusHighlightPositions();
  }

  /**
   * Builds Song Moons as faceted 3D crystalline icosahedrons (`IcosahedronGeometry(1, 0)`)
   * with flat facet shading so songs are visually distinct from spherical artist planets.
   */
  buildTrackSatellites(trackNodes) {
    const n = Math.max(1, trackNodes.length);
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    const material = createMoonCrystalMaterial();
    const moonInfo = new Float32Array(n * 3);
    const mesh = new THREE.InstancedMesh(geometry, material, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    const white = new THREE.Color('#FFFFFF');
    const gold = new THREE.Color('#F4E9C8');
    const collabTint = new THREE.Color(COLLAB_CYAN_LIGHT);

    trackNodes.forEach((node, i) => {
      node.instanceIndex = i;
      node.lensScale = 1.0;
      const base = new THREE.Color(node.color || COLOR_SPOTIFY_GREEN);
      const isCollab = Boolean(node.featArtistIds?.length || node.featArtistId);
      const isPastFav = node.history?.status === 'past_fav';

      node.baseInstanceColor = isCollab
        ? base.clone().lerp(collabTint, 0.45)
        : (isPastFav ? base.clone().lerp(gold, 0.38) : base.clone().lerp(white, 0.28));

      node.specialCode = isCollab ? 1.0 : (isPastFav ? 0.5 : 0.0);
      node.meshGroup = { position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1), visible: true, isInstanceHandle: true };
      mesh.setColorAt(i, node.baseInstanceColor);

      moonInfo[i * 3] = 1.0; // focusLevel / emissiveIntensity
      moonInfo[i * 3 + 1] = node.specialCode;
      moonInfo[i * 3 + 2] = (i % 97) / 97;
    });
    geometry.setAttribute('aMoonInfo', new THREE.InstancedBufferAttribute(moonInfo, 3));
    mesh.count = trackNodes.length;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.trackMesh = mesh;
    this.trackNodes = trackNodes;
    this.trackInfo = geometry.getAttribute('aMoonInfo');
    this.scene.add(mesh);
    return mesh;
  }

  updateTrackInstances() {
    if (!this.trackMesh) return;
    const m = this._m || (this._m = new THREE.Matrix4());
    const q = this._q || (this._q = new THREE.Quaternion());
    const euler = this._e || (this._e = new THREE.Euler());
    const sc = this._s || (this._s = new THREE.Vector3());
    const spin = performance.now() * 0.0012;

    for (const node of this.trackNodes) {
      const h = node.meshGroup;
      const fl = node.focusLevel ?? 1;
      const ft = node.focusTarget ?? 1;
      // Hard Visibility Culling: scale culled moon instances to (0, 0, 0)
      const activeVisible = h.visible && fl >= 0.06 && ft > 0.0;
      const r = activeVisible ? node.baseRadius * (node.lensScale ?? 1) : 0;
      sc.copy(h.scale).multiplyScalar(r);
      if (activeVisible) {
        euler.set(spin + (node.instanceIndex % 7) * 0.4, spin * 1.3 + (node.instanceIndex % 11) * 0.3, 0);
        q.setFromEuler(euler);
      }
      m.compose(h.position, q, sc);
      this.trackMesh.setMatrixAt(node.instanceIndex, m);
    }
    this.trackMesh.instanceMatrix.needsUpdate = true;
  }

  nodeFromHit(hit) {
    if (hit.object === this.trackMesh) return this.trackNodes[hit.instanceId] || null;
    if (hit.object === this.artistMesh) return this.artistNodes[hit.instanceId] || null;
    return hit.object.userData.node || null;
  }

  clearFocusHighlights() {
    while (this.focusHighlightGroup.children.length) {
      const child = this.focusHighlightGroup.children[0];
      this.focusHighlightGroup.remove(child);
      child.geometry?.dispose();
      if (child.material && !child.material.map) child.material.dispose();
    }
    this.dynamicTrackHalos = [];
    this.dynamicCollabMarkers = [];
    this.mainArtistBeacon = null;
  }

  /**
   * Builds dynamic 3D overlays for the focused artist/song:
   *  - Main selected artist gets a pulsing golden/white corona sprite & double planetary ring beacon,
   *    plus subtle orbital ring paths tethering their song moons to the parent planet.
   *  - Collaborator artists get a distinct cyan (#38bdf8) dashed orbital halo ring (`collabRing`) & aura.
   *  - Selected artist's song moons get glowing diamond crystal halos.
   */
  rebuildFocusHighlights(activeNode, artistTracks = [], collabArtists = []) {
    this.clearFocusHighlights();
    if (!activeNode) return;

    if (activeNode.type === 'artist') {
      // 1. Main Selected Artist Beacon (pulsing golden/white corona sprite + radiant rings)
      const beacon = new THREE.Group();
      const baseCoronaSize = activeNode.baseRadius * 7.8;
      const corona = makeSprite(getProceduralGlowTexture(STARLIGHT_HEX), baseCoronaSize, 0.94 * this.glow);
      const coreGlow = makeSprite(getProceduralGlowTexture(activeNode.color || STARLIGHT_HEX), activeNode.baseRadius * 4.5, 0.88 * this.glow);
      const innerRing = createRing(activeNode.baseRadius * 1.52, activeNode.baseRadius * 1.82, STARLIGHT_HEX, 0.88, Math.PI / 2.1, 0.2);
      const outerRing = createRing(activeNode.baseRadius * 2.1, activeNode.baseRadius * 2.28, activeNode.color || STARLIGHT_HEX, 0.68, Math.PI / 2.1, -0.25);
      beacon.add(corona, coreGlow, innerRing, outerRing);

      // Tether song moons to their parent artist via subtle orbital ring paths
      const uniqueOrbitRadii = [];
      const sortedTracks = artistTracks.slice().sort((a, b) => (a.moonRadius || 0) - (b.moonRadius || 0));
      for (const tNode of sortedTracks) {
        const mr = tNode?.moonRadius;
        if (!mr) continue;
        if (!uniqueOrbitRadii.some(existing => Math.abs(existing - mr) < 0.85)) {
          uniqueOrbitRadii.push(mr);
        }
        if (uniqueOrbitRadii.length >= 8) break;
      }
      uniqueOrbitRadii.forEach(mr => {
        const orbitRing = createRing(mr - 0.06, mr + 0.06, activeNode.color || STARLIGHT_HEX, 0.2, Math.PI / 2.0, 0);
        beacon.add(orbitRing);
      });

      this.focusHighlightGroup.add(beacon);
      this.mainArtistBeacon = { group: beacon, corona, baseCoronaSize, node: activeNode };

      // 2. Collaborating Artist Differentiators (distinct cyan dashed orbital halo ring + cyan glow)
      collabArtists.forEach(cNode => {
        const marker = new THREE.Group();
        const r = Math.max(1.5, cNode.baseRadius * 1.08);
        const cyanHalo = makeSprite(getProceduralGlowTexture(COLLAB_CYAN), r * 3.8, 0.68 * this.glow);
        const dashedRing = createDashedOrbitLoop(r * 1.68, COLLAB_CYAN, 0.95, Math.PI / 2.2, Math.PI / 6);
        const innerCyanRing = createRing(r * 1.38, r * 1.5, COLLAB_CYAN_LIGHT, 0.65, Math.PI / 2.2, Math.PI / 6);
        marker.add(cyanHalo, dashedRing, innerCyanRing);
        this.focusHighlightGroup.add(marker);
        this.dynamicCollabMarkers.push({ group: marker, node: cNode });
      });

      // 3. Glowing Diamond Crystal Halos for the Selected Artist's Song Moons
      artistTracks.slice(0, 120).forEach(tNode => {
        const isCollabSong = activeNode.collabTrackIds?.has(tNode.id) || (tNode.featArtistIds?.length > 0);
        const haloColor = isCollabSong ? COLLAB_CYAN_LIGHT : (tNode.color || STARLIGHT_HEX);
        const sprite = makeSprite(
          getProceduralGlowTexture(haloColor),
          Math.max(2.2, tNode.baseRadius * 5.0),
          (isCollabSong ? 0.9 : 0.76) * this.glow
        );
        this.focusHighlightGroup.add(sprite);
        this.dynamicTrackHalos.push({ sprite, node: tNode });
      });
    } else if (activeNode.type === 'track') {
      // Selected Song Moon Beacon + Primary vs. Collaborator Artist Markers
      const sprite = makeSprite(getProceduralGlowTexture(STARLIGHT_HEX), Math.max(3.5, activeNode.baseRadius * 7.5), 0.95 * this.glow);
      this.focusHighlightGroup.add(sprite);
      this.dynamicTrackHalos.push({ sprite, node: activeNode });

      collabArtists.forEach(cNode => {
        const isPrimary = cNode.id === activeNode.artistId;
        const marker = new THREE.Group();
        const r = Math.max(1.6, cNode.baseRadius * (isPrimary ? 1.35 : 1.08));
        const color = isPrimary ? (cNode.color || STARLIGHT_HEX) : COLLAB_CYAN;
        const halo = makeSprite(getProceduralGlowTexture(color), r * 4.2, 0.78 * this.glow);
        const ring = isPrimary
          ? createRing(r * 1.48, r * 1.82, STARLIGHT_HEX, 0.85, Math.PI / 2.2, Math.PI / 6)
          : createDashedOrbitLoop(r * 1.65, COLLAB_CYAN, 0.92, Math.PI / 2.2, Math.PI / 6);
        marker.add(halo, ring);
        this.focusHighlightGroup.add(marker);
        this.dynamicCollabMarkers.push({ group: marker, node: cNode });
      });
    }
  }

  updateFocusHighlightPositions() {
    const now = performance.now();
    if (this.mainArtistBeacon) {
      const { group, corona, baseCoronaSize, node } = this.mainArtistBeacon;
      group.position.copy(node.position);
      group.rotation.z = now * 0.0004;
      if (corona && baseCoronaSize) {
        const pulse = 1.0 + 0.1 * Math.sin(now * 0.0032);
        corona.scale.set(baseCoronaSize * pulse, baseCoronaSize * pulse, 1);
      }
    }
    for (const m of this.dynamicCollabMarkers) {
      m.group.position.copy(m.node.position);
      m.group.rotation.z = now * 0.0007;
    }
    for (const h of this.dynamicTrackHalos) {
      h.sprite.position.copy(h.node.position);
    }
  }

  disposeBatches() {
    this.clearFocusHighlights();
    [this.trackMesh, this.artistMesh, this.edgeLines, this.pulseMesh].forEach(obj => {
      if (!obj) return;
      this.scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    });
    if (this.artistDecor) {
      this.scene.remove(this.artistDecor);
      this.artistDecor.children.forEach(d => { d.geometry?.dispose(); d.material.dispose(); });
    }
    this.trackMesh = this.artistMesh = this.edgeLines = this.pulseMesh = this.artistDecor = null;
    this.trackNodes = [];
    this.artistNodes = [];
  }

  buildEdgeVisuals(edges) {
    const positions = new Float32Array(edges.length * 6);
    const colors = new Float32Array(edges.length * 6);
    edges.forEach((edge, i) => {
      const isBridgeLink = edge.type === 'artist_genre' && edge.source.genres?.[1] === edge.target.id;
      edge.style = EDGE_STYLE[isBridgeLink ? 'artist_bridge' : edge.type] || EDGE_STYLE.track_artist;
      edge.index = i;
      edge.baseColor = new THREE.Color(edge.type === 'track_collab' ? COLLAB_CYAN : (edge.color || '#00F0FF'));
      edge.level = edge.style.opacity;
      this.writeEdgeColor(colors, edge);
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    this.edgeLines = lines;

    // Prioritize collaboration threads first so every collaboration edge gets animated pulses
    const collabEdges = edges.filter(e => e.type === 'track_collab');
    const otherPulseEdges = edges.filter(e => e.type !== 'track_artist' && e.type !== 'track_collab');
    const pulseEdges = [...collabEdges, ...otherPulseEdges].slice(0, MAX_PULSES);

    const pulseMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.48, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      Math.max(1, pulseEdges.length)
    );
    pulseMesh.count = pulseEdges.length;
    pulseMesh.frustumCulled = false;
    pulseEdges.forEach((e, i) => pulseMesh.setColorAt(i, new THREE.Color(e.type === 'track_collab' ? COLLAB_CYAN_LIGHT : (e.color || '#FFFFFF'))));
    if (pulseMesh.instanceColor) pulseMesh.instanceColor.needsUpdate = true;
    this.pulseMesh = pulseMesh;

    const pulseParticles = pulseEdges.map((edge, idx) => ({
      edge,
      progress: (idx * 0.173) % 1.0,
      speed: 0.0028 + (idx % 4) * 0.001
    }));

    this.focusKey = null;
    const edgeLinesGroup = new THREE.Group();
    edgeLinesGroup.add(lines, pulseMesh);
    this.scene.add(edgeLinesGroup);
    return { edgeLinesGroup, pulseParticles };
  }

  writeEdgeColor(colors, edge) {
    const o = edge.index * 6;
    const c = edge.baseColor;
    const k = edge.level;
    colors[o] = colors[o + 3] = c.r * k;
    colors[o + 1] = colors[o + 4] = c.g * k;
    colors[o + 2] = colors[o + 5] = c.b * k;
  }

  updateEdgeGeometry(edges) {
    if (!this.edgeLines) return;
    const pos = this.edgeLines.geometry.attributes.position;
    const arr = pos.array;
    for (const e of edges) {
      const o = e.index * 6;
      const s = e.source.position, d = e.target.position;
      const hidden = !e.source.meshGroup?.visible || !e.target.meshGroup?.visible || e.level < 0.004;
      if (hidden) {
        arr[o] = arr[o + 3] = s.x; arr[o + 1] = arr[o + 4] = s.y; arr[o + 2] = arr[o + 5] = s.z;
        continue;
      }
      arr[o] = s.x; arr[o + 1] = s.y; arr[o + 2] = s.z;
      arr[o + 3] = d.x; arr[o + 4] = d.y; arr[o + 5] = d.z;
    }
    pos.needsUpdate = true;
  }

  updatePulses(pulseParticles, orbitSpeed) {
    if (!this.pulseMesh) return;
    const speedScale = Math.max(0.25, orbitSpeed);
    const m = this._pm || (this._pm = new THREE.Matrix4());
    const v = this._pv || (this._pv = new THREE.Vector3());
    pulseParticles.forEach((p, i) => {
      p.progress = (p.progress + p.speed * speedScale) % 1.0;
      v.lerpVectors(p.edge.source.position, p.edge.target.position, p.progress);
      let s = 0.35;
      if (p.edge.level < 0.025 || !p.edge.source.meshGroup?.visible || !p.edge.target.meshGroup?.visible) {
        s = 0;
      } else if (p.edge.level > 0.35) {
        s = p.edge.type === 'track_collab' ? 1.55 : 1.0;
      }
      m.makeScale(s, s, s).setPosition(v);
      this.pulseMesh.setMatrixAt(i, m);
    });
    this.pulseMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Alias for `updateFocus` matching the `setFocusedNode(focusedId)` API contract.
   */
  setFocusedNode(focusedNodeOrId, nodes = [], edges = [], activeLens = 'all') {
    const activeNode = typeof focusedNodeOrId === 'string'
      ? nodes.find(n => n.id === focusedNodeOrId) || null
      : focusedNodeOrId;
    this.updateFocus(activeNode, nodes, edges, activeLens);
  }

  /**
   * Hard Visibility Culling & Artist/Song Focus Isolation:
   *
   * When an Artist (`activeNode.type === 'artist'`) is selected:
   *  - Main Selected Artist: `focusTarget = 2.8` (emissiveIntensity = 2.8), `lensScale = 1.38` (~1.35x),
   *    `roleCode = 1`, plus pulsing golden/white corona sprite.
   *  - Collaborator Artists: `focusTarget = 1.15` (emissiveIntensity = 1.15), `lensScale = 1.08` (~1.05x),
   *    `roleCode = 2`, plus distinct cyan dashed orbital halo ring (`#38bdf8`).
   *  - Selected Artist's Song Moons: `focusTarget = 2.25` (emissiveIntensity = 2.2+), `lensScale = 1.45` (~1.4x),
   *    lighting up as glowing diamond crystals around the planet.
   *  - All unselected cluster suns, nebulae, planets, and moons are hard-culled (`focusTarget = 0.0`,
   *    `focusLevel = 0.0`, `lensScale = 0.0`, `visible = false`) so nothing unselected can ever
   *    cross the camera's field of vision or intercept raycaster clicks.
   */
  updateFocus(activeNode, nodes, edges, activeLens = 'all') {
    const hasLens = Boolean(activeLens && activeLens !== 'all');
    const key = `${activeNode ? activeNode.id : 'none'}|${activeLens || 'all'}`;
    if (key !== this.focusKey) {
      this.focusKey = key;

      const lensMatch = new Set();
      const lensClusterHasMatch = new Set();
      const lensArtistHasMatchTrack = new Set();
      if (hasLens) {
        for (const n of nodes) {
          if (n.type !== 'genre' && nodeMatchesLens(n, activeLens)) {
            lensMatch.add(n.id);
            if (n.type === 'track' && n.artistId) {
              lensArtistHasMatchTrack.add(n.artistId);
            }
            if (n.type === 'artist') {
              (n.genres || []).forEach(gId => lensClusterHasMatch.add(gId));
            }
          }
        }
        for (const n of nodes) {
          if (n.type === 'artist' && lensArtistHasMatchTrack.has(n.id)) {
            (n.genres || []).forEach(gId => lensClusterHasMatch.add(gId));
          }
        }
      }

      if (activeNode?.type === 'artist') {
        const artistTrackIds = new Set();
        const artistTrackNodes = [];
        const collabArtistIds = new Set(activeNode.collaboratorArtistIds || []);
        const collabArtistNodes = [];

        nodes.forEach(n => {
          if (n.type === 'track' && activeNode.neighbors?.has(n.id) && n.meshGroup?.visible !== false) {
            artistTrackIds.add(n.id);
            artistTrackNodes.push(n);
            if (n.artistId && n.artistId !== activeNode.id) collabArtistIds.add(n.artistId);
            (n.featArtistIds || []).forEach(fId => {
              if (fId !== activeNode.id) collabArtistIds.add(fId);
            });
          }
        });

        nodes.forEach(n => {
          let target = 0.0;
          let scale = 0.0;
          let roleCode = 0;

          if (n.id === activeNode.id) {
            // Main selected artist: emissiveIntensity = 2.8, scale up 1.38x
            target = 2.8;
            scale = 1.38;
            roleCode = 1;
          } else if (artistTrackIds.has(n.id)) {
            // Selected artist's song moons: emissiveIntensity = 2.25, scale 1.45x
            const isCollabSong = activeNode.collabTrackIds?.has(n.id) || (n.featArtistIds?.length > 0);
            const matches = !hasLens || lensMatch.has(n.id);
            target = matches ? 2.25 : 0.55;
            scale = isCollabSong ? 1.55 : 1.42;
          } else if (collabArtistIds.has(n.id)) {
            // Collaborator artist: scale 1.08x (~1.05x) with cyan dashed orbital ring
            target = 1.15;
            scale = 1.08;
            roleCode = 2;
            collabArtistNodes.push(n);
          } else {
            // Hard Visibility Culling: completely hide unselected suns, planets, and moons
            target = 0.0;
            scale = 0.0;
            roleCode = 0;
          }

          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = roleCode;
          if (n.focusTarget === 0.0) {
            n.focusLevel = 0.0;
          }
        });

        this.rebuildFocusHighlights(activeNode, artistTrackNodes, collabArtistNodes);

        edges.forEach(e => {
          const sId = e.source.id;
          const tId = e.target.id;
          const touchesSelectedArtist = sId === activeNode.id || tId === activeNode.id;
          const touchesArtistTrack = artistTrackIds.has(sId) || artistTrackIds.has(tId);
          const touchesCollabArtist = collabArtistIds.has(sId) || collabArtistIds.has(tId);

          if (e.type === 'artist_genre') {
            e.focusTarget = 0.0;
          } else if (touchesArtistTrack && touchesCollabArtist) {
            e.focusTarget = 0.98;
          } else if (touchesSelectedArtist && touchesArtistTrack) {
            e.focusTarget = 0.85;
          } else {
            e.focusTarget = 0.0;
          }
        });
      } else if (activeNode?.type === 'track') {
        const involvedArtistIds = new Set();
        const involvedArtistNodes = [];
        if (activeNode.artistId) involvedArtistIds.add(activeNode.artistId);
        (activeNode.featArtistIds || []).forEach(id => involvedArtistIds.add(id));
        if (activeNode.featArtistId) involvedArtistIds.add(activeNode.featArtistId);

        nodes.forEach(n => {
          let target = 0.0;
          let scale = 0.0;
          let roleCode = 0;
          if (n.id === activeNode.id) {
            target = 2.25;
            scale = 2.0;
          } else if (involvedArtistIds.has(n.id)) {
            const isPrimary = n.id === activeNode.artistId;
            target = isPrimary ? 2.4 : 1.15;
            scale = isPrimary ? 1.35 : 1.08;
            roleCode = isPrimary ? 1 : 2;
            involvedArtistNodes.push(n);
          } else {
            target = 0.0;
            scale = 0.0;
          }
          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = roleCode;
          if (n.focusTarget === 0.0) n.focusLevel = 0.0;
        });

        this.rebuildFocusHighlights(activeNode, [activeNode], involvedArtistNodes);

        edges.forEach(e => {
          const touchesSong = e.source.id === activeNode.id || e.target.id === activeNode.id;
          e.focusTarget = touchesSong ? 0.96 : 0.0;
        });
      } else if (activeNode?.type === 'genre') {
        this.clearFocusHighlights();
        const lit = new Set([activeNode.id]);
        activeNode.neighbors?.forEach(id => lit.add(id));
        nodes.forEach(n => {
          if (n.type === 'artist' && n.genres?.includes(activeNode.id)) {
            n.neighbors?.forEach(id => lit.add(id));
          }
        });

        nodes.forEach(n => {
          const inCluster = lit.has(n.id);
          let target = inCluster ? 1.0 : 0.0;
          let scale = inCluster ? 1.0 : 0.0;
          if (hasLens && inCluster && n.id !== activeNode.id) {
            const matches = lensMatch.has(n.id);
            target = matches ? 1.35 : 0.25;
            if (matches && n.type === 'track') scale = 1.45;
          }
          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = 0;
          if (n.focusTarget === 0.0) n.focusLevel = 0.0;
        });

        edges.forEach(e => {
          const both = lit.has(e.source.id) && lit.has(e.target.id);
          e.focusTarget = both ? e.style.focused * 0.75 : 0.0;
        });
      } else {
        this.clearFocusHighlights();
        nodes.forEach(n => {
          let target = 1.0;
          let scale = 1.0;
          if (hasLens) {
            if (n.type === 'genre') {
              target = lensClusterHasMatch.has(n.id) ? 0.78 : 0.14;
            } else if (lensMatch.has(n.id)) {
              target = n.type === 'track' ? 1.45 : 1.25;
              scale = n.type === 'track' ? 1.45 : 1.15;
            } else if (n.type === 'artist' && lensArtistHasMatchTrack.has(n.id)) {
              target = 0.55;
              scale = 0.95;
            } else {
              target = 0.0;
              scale = 0.0;
            }
          }
          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = 0;
        });

        edges.forEach(e => {
          if (!hasLens) {
            e.focusTarget = e.style.opacity;
          } else {
            const bothMatch = lensMatch.has(e.source.id) || lensMatch.has(e.target.id);
            e.focusTarget = bothMatch ? e.style.opacity * 1.8 : 0.0;
          }
        });
      }

      // Sync roleCode and instant-culled focusLevels to GPU attributes right away
      if (this.artistInfo) {
        for (const n of this.artistNodes) {
          this.artistInfo.array[n.artistIndex * 3 + 1] = n.focusLevel ?? 1;
          this.artistInfo.array[n.artistIndex * 3 + 2] = (n.roleCode || 0) + (n.seedFrac || 0.25);
        }
        this.artistInfo.needsUpdate = true;
      }
      if (this.trackInfo) {
        for (const n of this.trackNodes) {
          this.trackInfo.array[n.instanceIndex * 3] = n.focusLevel ?? 1;
        }
        this.trackInfo.needsUpdate = true;
      }
      nodes.forEach(n => { if (n.type === 'genre') this.applyFade(n); });
    }

    let trackInfoDirty = false;
    let artistInfoDirty = false;
    for (const n of nodes) {
      if (n.focusLevel === undefined) n.focusLevel = 1;
      const target = n.focusTarget ?? 1;
      if (Math.abs(n.focusLevel - target) < 0.003) continue;
      n.focusLevel += (target - n.focusLevel) * FOCUS_LERP;
      if (n.instanceIndex !== undefined && this.trackInfo) {
        this.trackInfo.array[n.instanceIndex * 3] = n.focusLevel;
        trackInfoDirty = true;
      }
      this.applyFade(n);
      if (n.artistIndex !== undefined && this.artistInfo) {
        this.artistInfo.array[n.artistIndex * 3 + 1] = n.focusLevel;
        artistInfoDirty = true;
      }
    }
    if (trackInfoDirty) this.trackInfo.needsUpdate = true;
    if (artistInfoDirty) this.artistInfo.needsUpdate = true;

    if (!this.edgeLines) return;
    const colors = this.edgeLines.geometry.attributes.color;
    let edgesDirty = false;
    for (const e of edges) {
      if (e.focusTarget === undefined || Math.abs(e.level - e.focusTarget) < 0.002) continue;
      e.level += (e.focusTarget - e.level) * FOCUS_LERP;
      this.writeEdgeColor(colors.array, e);
      edgesDirty = true;
    }
    if (edgesDirty) colors.needsUpdate = true;
  }

  updateNebulae(camera, suns) {
    for (const sun of suns) {
      if (!sun.nebula) continue;
      const fl = sun.focusLevel ?? 1;
      if (fl < 0.05 || (sun.focusTarget ?? 1) === 0) {
        sun.nebula.visible = false;
        continue;
      }
      sun.nebula.visible = true;
      const size = (sun.currentClusterRadius || sun.clusterRadius || 60) * 1.9;
      sun.nebula.scale.set(size, size, 1);
      const d = camera.position.distanceTo(sun.position);
      const fade = THREE.MathUtils.smoothstep(d, size * 0.35, size * 0.9);
      sun.nebula.material.opacity = NEBULA_OPACITY * this.glow * fl * fade;
    }
  }

  updateSolarShaders(time) {
    for (let i = 0; i < this.solarMaterials.length; i++) {
      this.solarMaterials[i].uniforms.uTime.value = time;
    }
  }
}
