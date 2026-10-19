// src/renderer/celestialFactory.js
import * as THREE from 'three';
import { createSolarShaderMaterial } from './shaders/solarPlasmaShader.js';
import { createPlanetMaterial, createMoonCrystalMaterial } from './shaders/planetShader.js';
import { COLOR_SPOTIFY_GREEN } from '../config/constants.js';

const sunGlowTextureCache = new Map();
const nebulaTextureCache = new Map();

const FOCUS_LERP = 0.18;
const SUN_LIGHT_INTENSITY = 1.1;
const NEBULA_OPACITY = 0.09;
const MAX_PULSES = 450;
const STARLIGHT_HEX = '#F4E9C8';

// Soft dim levels so unselected objects remain visibly present in the background without stealing attention
const DIM_PLANET_FOCUS = 0.22;
const DIM_SUN_FOCUS = 0.18;
const DIM_MOON_FOCUS = 0.18;

// Connection weights: subtle in overview so long-distance collab lines don't clutter empty space,
// and high-contrast when focused on an artist, song, or lens.
const EDGE_STYLE = {
  artist_genre: { opacity: 0.06, focused: 0.58 },
  artist_bridge: { opacity: 0.045, focused: 0.72 },
  track_artist: { opacity: 0.14, focused: 0.96 },
  track_collab: { opacity: 0.045, focused: 0.88 }
};

const UP_VEC = new THREE.Vector3(0, 1, 0);

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
 * Helper for Artist Focus Mode: keeps unselected nodes in view but dimmed & transparent
 * (`depthWrite = false`, low opacity) while highlighting the selected artist, their songs,
 * and collaborating artists.
 */
export function applyArtistIsolationMode(sceneState, selectedArtistId) {
  if (!sceneState) return;

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
      if (m.material) {
        m.material.opacity = 1.0;
        m.material.depthWrite = true;
      }
      if (m.userData?.collabRing) m.userData.collabRing.visible = false;
      if (m.userData?.selectionCorona) m.userData.selectionCorona.visible = false;
    });
    moonMeshes.forEach((m) => {
      m.visible = true;
      m.scale.setScalar(m.userData?.baseScale || 1);
      if (m.material) {
        m.material.opacity = 1.0;
        m.material.depthWrite = true;
      }
    });
    sunMeshes.forEach((s) => {
      s.visible = true;
      if (s.material) { s.material.opacity = 1.0; s.material.depthWrite = false; }
    });
    nebulaMeshes.forEach((n) => {
      n.visible = true;
      if (n.material) n.material.opacity = NEBULA_OPACITY;
    });
    return;
  }

  const activeSongIds = new Set();
  const collabArtistIds = new Set();

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

  sunMeshes.forEach((s) => {
    s.visible = true;
    if (s.material) {
      s.material.transparent = true;
      s.material.opacity = DIM_SUN_FOCUS;
      s.material.depthWrite = false;
    }
  });
  nebulaMeshes.forEach((n) => {
    n.visible = true;
    if (n.material) n.material.opacity = NEBULA_OPACITY * 0.2;
  });

  artistMeshes.forEach((mesh) => {
    const id = mesh.userData?.artistId ?? mesh.userData?.node?.id;
    const baseScale = mesh.userData?.baseScale || 1;
    mesh.visible = true;

    if (id === selectedArtistId) {
      mesh.scale.setScalar(baseScale * 1.32);
      if (mesh.material) {
        mesh.material.opacity = 1.0;
        mesh.material.depthWrite = true;
      }
      if (mesh.userData?.collabRing) mesh.userData.collabRing.visible = false;
    } else if (collabArtistIds.has(id)) {
      mesh.scale.setScalar(baseScale * 1.08);
      if (mesh.material) {
        mesh.material.opacity = 1.0;
        mesh.material.depthWrite = true;
      }
      if (mesh.userData?.collabRing) mesh.userData.collabRing.visible = true;
    } else {
      mesh.scale.setScalar(baseScale * 0.85);
      if (mesh.material) {
        mesh.material.transparent = true;
        mesh.material.opacity = DIM_PLANET_FOCUS;
        mesh.material.depthWrite = false;
      }
      if (mesh.userData?.collabRing) mesh.userData.collabRing.visible = false;
    }
  });

  moonMeshes.forEach((moon) => {
    const id = moon.userData?.trackId ?? moon.userData?.node?.id;
    const baseScale = moon.userData?.baseScale || 1;
    moon.visible = true;

    if (activeSongIds.has(id)) {
      moon.scale.setScalar(baseScale * 1.4);
      if (moon.material) {
        moon.material.opacity = 1.0;
        moon.material.depthWrite = true;
      }
    } else {
      moon.scale.setScalar(baseScale * 0.75);
      if (moon.material) {
        moon.material.transparent = true;
        moon.material.opacity = DIM_MOON_FOCUS;
        moon.material.depthWrite = false;
      }
    }
  });
}

/**
 * Soft, see-through solar corona texture used exclusively for Cluster Centers (Genre Suns)
 * so cluster centers shine warmly without blocking any planets, moons, or lines behind them.
 */
export function getProceduralGlowTexture(hexColor) {
  if (sunGlowTextureCache.has(hexColor)) return sunGlowTextureCache.get(hexColor);

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(hexColor);
  const rgb = `${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}`;

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  gradient.addColorStop(0.0, 'rgba(255, 248, 232, 0.72)');
  gradient.addColorStop(0.22, `rgba(${rgb}, 0.48)`);
  gradient.addColorStop(0.55, `rgba(${rgb}, 0.14)`);
  gradient.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  sunGlowTextureCache.set(hexColor, texture);
  return texture;
}

/**
 * Subtle nebula backdrop per cluster.
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
  for (let i = 0; i < 12; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = rand() * size * 0.22;
    const x = size / 2 + Math.cos(angle) * dist;
    const y = size / 2 + Math.sin(angle) * dist;
    const r = size * (0.16 + rand() * 0.22);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb}, ${0.14 + rand() * 0.1})`);
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

function createSolidOrbitLine(radius, colorHex, opacity = 0.55, tiltX = Math.PI / 2.0, tiltY = 0) {
  const segments = 72;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, 0));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(pts);
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(colorHex),
    transparent: true,
    opacity,
    depthWrite: false
  });
  const line = new THREE.Line(geometry, material);
  line.rotation.x = tiltX;
  line.rotation.y = tiltY;
  return line;
}

/**
 * Creates a crisp dashed orbital line loop for Collaborator Artists in their cluster color.
 */
function createDashedOrbitLoop(radius, colorHex = STARLIGHT_HEX, opacity = 0.85, tiltX = Math.PI / 2.2, tiltY = 0) {
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
 *  - Genre Suns (Cluster Centers): warm, see-through solar shine (`depthWrite: false` + radial corona)
 *    that never blocks planets, moons, or lines behind it
 *  - Artist Planets: crisp `SphereGeometry(1, 32, 32)` spheres in refined luxury cluster shades
 *  - Song Moons: faceted `IcosahedronGeometry(1, 0)` crystals matching their parent artist's color
 *  - Dynamic Focus Overlay: weighted 3D connection cylinders for artist <-> song and thinner
 *    same-color cylinders for song <-> collaborator connections.
 */
export class CelestialFactory {
  constructor(scene) {
    this.scene = scene;
    this.solarMaterials = [];
    this.focusKey = null;
    this.glow = 1;
    this.focusHighlightGroup = new THREE.Group();
    this.scene.add(this.focusHighlightGroup);
    this.dynamicCollabMarkers = [];
    this.dynamicConnectionTubes = [];
    this.mainArtistBeacon = null;
  }

  register(node, material, baseOpacity, isUniform = false, isGlow = false) {
    node.fadeTargets = node.fadeTargets || [];
    node.fadeTargets.push({ material, baseOpacity, isUniform, isGlow });
  }

  applyFade(node) {
    const fl = node.focusLevel ?? 1;
    node.fadeTargets?.forEach(({ material, baseOpacity, isUniform, isGlow }) => {
      const v = baseOpacity * Math.min(1.0, fl) * (isGlow ? this.glow : 1);
      if (isUniform && material.uniforms?.uOpacity) material.uniforms.uOpacity.value = v;
      else material.opacity = v;
    });
    if (node.shaderMaterial?.uniforms?.uOpacity) {
      node.shaderMaterial.uniforms.uOpacity.value = Math.min(1, fl);
    }
    if (node.type === 'genre' && node.sphereMesh) {
      const vis = Boolean(node.meshGroup?.visible !== false);
      node.sphereMesh.visible = vis;
      // Keep depthWrite false on cluster suns at all times so their shine never blocks anything behind them!
      node.sphereMesh.material.depthWrite = false;
      if (node.sprite) node.sprite.visible = vis;
      if (node.ring) node.ring.visible = vis && fl >= 0.35;
    }
    if (node.light) node.light.intensity = SUN_LIGHT_INTENSITY * this.glow * Math.min(1.0, fl);
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
    sphereMesh.renderOrder = -1;
    sphereMesh.userData = { node };
    group.add(sphereMesh);

    // Soft see-through solar shine around the cluster center (drawn behind planets with depthWrite: false)
    const corona = makeSprite(getProceduralGlowTexture(node.color), node.baseRadius * 3.8, 0.46);
    corona.renderOrder = -1;
    group.add(corona);
    this.register(node, corona.material, 0.46, false, true);

    const ring = createSolidOrbitLine(node.baseRadius * 1.48, node.color, 0.32, Math.PI / 2.2, Math.PI / 7.0);
    group.add(ring);
    this.register(node, ring.material, 0.32);

    const nebulaSize = (node.clusterRadius || 60) * 1.7;
    const nebula = makeSprite(getNebulaTexture(node.color), nebulaSize, NEBULA_OPACITY);
    nebula.renderOrder = -2;
    group.add(nebula);
    node.nebula = nebula;

    node.light = new THREE.PointLight(node.color, SUN_LIGHT_INTENSITY, (node.clusterRadius || 80) * 1.5, 1.2);
    group.add(node.light);

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
    node.sprite = corona;
    node.ring = ring;
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

    artistNodes.forEach((node, i) => {
      const listen = node.normScore ?? 1;
      // Strictly keep seedFrac in [0.005, 0.485] so (roleCode + seedFrac) never crosses an integer boundary!
      const rawHash = Math.abs(parseInt(String(node.id).replace(/[^0-9a-z]/gi, '').slice(-6), 36) || (i * 137));
      const seed = (rawHash % 480) / 1000 + 0.005;
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
      if (node.labelRank === 0 && !node.isBridge) {
        const ring = createSolidOrbitLine(1.55, node.color, 0.32, Math.PI / 2.2, Math.PI / 7.0);
        ring.userData.size = 1;
        decor.add(ring);
        node.decor.push(ring);
        this.register(node, ring.material, 0.32);
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
      const activeVisible = Boolean(h.visible);
      const r = activeVisible ? node.baseRadius * (node.lensScale ?? 1) : 0;
      sc.copy(h.scale).multiplyScalar(r);
      m.compose(h.position, q, sc);
      this.artistMesh.setMatrixAt(node.artistIndex, m);

      const showDecor = activeVisible && (node.focusLevel ?? 1) >= 0.65;
      for (const d of node.decor) {
        d.visible = showDecor;
        if (!showDecor) continue;
        d.position.copy(h.position);
        const s = r * h.scale.x * d.userData.size;
        d.scale.setScalar(s);
      }
    }
    this.artistMesh.instanceMatrix.needsUpdate = true;
    this.updateFocusHighlightPositions();
  }

  /**
   * Builds Song Moons as faceted 3D crystalline icosahedrons (`IcosahedronGeometry(1, 0)`)
   * while matching each moon's color directly to its parent artist's color (`node.color`).
   */
  buildTrackSatellites(trackNodes) {
    const n = Math.max(1, trackNodes.length);
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    const material = createMoonCrystalMaterial();
    const moonInfo = new Float32Array(n * 3);
    const mesh = new THREE.InstancedMesh(geometry, material, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    trackNodes.forEach((node, i) => {
      node.instanceIndex = i;
      node.lensScale = 1.0;
      const isCollab = Boolean(node.featArtistIds?.length || node.featArtistId);
      const isPastFav = node.history?.status === 'past_fav';

      node.baseInstanceColor = new THREE.Color(node.color || COLOR_SPOTIFY_GREEN);

      node.specialCode = isCollab ? 1.0 : (isPastFav ? 0.5 : 0.0);
      node.meshGroup = { position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1), visible: true, isInstanceHandle: true };
      mesh.setColorAt(i, node.baseInstanceColor);

      moonInfo[i * 3] = 1.0;
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
      const activeVisible = Boolean(h.visible);
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
    this.dynamicCollabMarkers = [];
    this.dynamicConnectionTubes = [];
    this.mainArtistBeacon = null;
  }

  /**
   * Creates a weighted 3D cylinder link between two nodes so connections between
   * artists, songs, and collaborators are clearly visible.
   */
  addConnectionTube(sourceNode, targetNode, colorHex, radius = 0.08, opacity = 0.72) {
    const geom = new THREE.CylinderGeometry(radius, radius, 1, 6, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true,
      opacity,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    this.focusHighlightGroup.add(mesh);
    this.dynamicConnectionTubes.push({ mesh, source: sourceNode, target: targetNode });
  }

  /**
   * Builds crisp geometric overlays and weighted 3D connection links for the focused artist or song:
   *  - Artist <-> Song links use weighted tubes in the artist's color (`radius = 0.082`)
   *  - Song <-> Collaborator links use a thinner line of the SAME color (`radius = 0.044`, NOT blue!)
   */
  rebuildFocusHighlights(activeNode, artistTracks = [], collabArtists = []) {
    this.clearFocusHighlights();
    if (!activeNode) return;

    if (activeNode.type === 'artist') {
      const baseColor = activeNode.color || STARLIGHT_HEX;

      // 1. Crisp thin geometric ring around the selected artist
      const beacon = new THREE.Group();
      const primaryRing = createSolidOrbitLine(activeNode.baseRadius * 1.65, STARLIGHT_HEX, 0.72, Math.PI / 2.1, 0.2);
      beacon.add(primaryRing);

      // Subtle thin orbital paths where the artist's song moons orbit
      const uniqueOrbitRadii = [];
      const sortedTracks = artistTracks.slice().sort((a, b) => (a.moonRadius || 0) - (b.moonRadius || 0));
      for (const tNode of sortedTracks) {
        const mr = tNode?.moonRadius;
        if (!mr) continue;
        if (!uniqueOrbitRadii.some(existing => Math.abs(existing - mr) < 1.1)) {
          uniqueOrbitRadii.push(mr);
        }
        if (uniqueOrbitRadii.length >= 6) break;
      }
      uniqueOrbitRadii.forEach(mr => {
        const orbitLine = createSolidOrbitLine(mr, baseColor, 0.22, Math.PI / 2.0, 0);
        beacon.add(orbitLine);
      });

      this.focusHighlightGroup.add(beacon);
      this.mainArtistBeacon = { group: beacon, node: activeNode };

      // 2. Collaborator Artist dashed orbital rings in matching color (no blue)
      const collabById = new Map();
      collabArtists.forEach(cNode => {
        collabById.set(cNode.id, cNode);
        const marker = new THREE.Group();
        const r = Math.max(1.5, cNode.baseRadius * 1.08);
        const dashedRing = createDashedOrbitLoop(r * 1.55, cNode.color || baseColor, 0.82, Math.PI / 2.2, Math.PI / 6);
        marker.add(dashedRing);
        this.focusHighlightGroup.add(marker);
        this.dynamicCollabMarkers.push({ group: marker, node: cNode });
      });

      // 3. Weighted 3D connection tubes:
      //    - Artist <-> Song Moon: main weight (0.082) in the artist's color
      //    - Song Moon <-> Collaborating Artist: thinner line (0.044) of the SAME color!
      artistTracks.forEach(tNode => {
        const lineColor = activeNode.color || tNode.color || STARLIGHT_HEX;
        this.addConnectionTube(
          activeNode,
          tNode,
          lineColor,
          0.082,
          0.74
        );

        const otherIds = new Set();
        if (tNode.artistId && tNode.artistId !== activeNode.id) otherIds.add(tNode.artistId);
        (tNode.featArtistIds || []).forEach(fId => {
          if (fId && fId !== activeNode.id) otherIds.add(fId);
        });
        if (tNode.featArtistId && tNode.featArtistId !== activeNode.id) otherIds.add(tNode.featArtistId);

        otherIds.forEach(otherId => {
          const cNode = collabById.get(otherId);
          if (cNode && cNode.meshGroup?.visible !== false) {
            this.addConnectionTube(tNode, cNode, lineColor, 0.044, 0.65);
          }
        });
      });
    } else if (activeNode.type === 'track') {
      const songColor = activeNode.color || STARLIGHT_HEX;
      const beacon = new THREE.Group();
      const moonRing = createSolidOrbitLine(Math.max(1.4, activeNode.baseRadius * 2.4), STARLIGHT_HEX, 0.82, Math.PI / 2.2, 0.2);
      beacon.add(moonRing);
      this.focusHighlightGroup.add(beacon);
      this.mainArtistBeacon = { group: beacon, node: activeNode };

      collabArtists.forEach(cNode => {
        const isPrimary = cNode.id === activeNode.artistId;
        const marker = new THREE.Group();
        const r = Math.max(1.5, cNode.baseRadius * (isPrimary ? 1.32 : 1.08));
        const ring = isPrimary
          ? createSolidOrbitLine(r * 1.55, STARLIGHT_HEX, 0.82, Math.PI / 2.2, Math.PI / 6)
          : createDashedOrbitLoop(r * 1.55, cNode.color || songColor, 0.82, Math.PI / 2.2, Math.PI / 6);
        marker.add(ring);
        this.focusHighlightGroup.add(marker);
        this.dynamicCollabMarkers.push({ group: marker, node: cNode });

        // Primary artist gets main weight (0.085); collaborating artists get a thinner line (0.044) of the same color
        this.addConnectionTube(
          activeNode,
          cNode,
          songColor,
          isPrimary ? 0.085 : 0.044,
          isPrimary ? 0.78 : 0.65
        );
      });
    }
  }

  updateFocusHighlightPositions() {
    const now = performance.now();
    if (this.mainArtistBeacon) {
      const { group, node } = this.mainArtistBeacon;
      group.position.copy(node.position);
      group.rotation.z = now * 0.0004;
    }
    for (const m of this.dynamicCollabMarkers) {
      m.group.position.copy(m.node.position);
      m.group.rotation.z = now * 0.0007;
    }
    if (this.dynamicConnectionTubes.length) {
      const mid = this._tubeMid || (this._tubeMid = new THREE.Vector3());
      const dir = this._tubeDir || (this._tubeDir = new THREE.Vector3());
      for (const item of this.dynamicConnectionTubes) {
        const a = item.source.position;
        const b = item.target.position;
        dir.subVectors(b, a);
        const len = dir.length();
        if (len < 1e-3) {
          item.mesh.visible = false;
          continue;
        }
        item.mesh.visible = true;
        mid.addVectors(a, b).multiplyScalar(0.5);
        item.mesh.position.copy(mid);
        item.mesh.scale.set(1, len, 1);
        dir.divideScalar(len);
        item.mesh.quaternion.setFromUnitVectors(UP_VEC, dir);
      }
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
      // Keep collaboration lines in the same color as the parent artist/song rather than blue
      edge.baseColor = new THREE.Color(edge.color || edge.source?.color || STARLIGHT_HEX);
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

    const collabEdges = edges.filter(e => e.type === 'track_collab');
    const trackEdges = edges.filter(e => e.type === 'track_artist');
    const pulseEdges = [...collabEdges, ...trackEdges].slice(0, MAX_PULSES);

    const pulseMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.28, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }),
      Math.max(1, pulseEdges.length)
    );
    pulseMesh.count = pulseEdges.length;
    pulseMesh.frustumCulled = false;
    pulseEdges.forEach((e, i) => pulseMesh.setColorAt(i, new THREE.Color(e.color || e.source?.color || STARLIGHT_HEX)));
    if (pulseMesh.instanceColor) pulseMesh.instanceColor.needsUpdate = true;
    this.pulseMesh = pulseMesh;

    const pulseParticles = pulseEdges.map((edge, idx) => ({
      edge,
      progress: (idx * 0.173) % 1.0,
      speed: 0.0032 + (idx % 4) * 0.001
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
    const boost = k > 0.5 ? 1.15 : 1.0;
    colors[o] = colors[o + 3] = Math.min(1, c.r * k * boost);
    colors[o + 1] = colors[o + 4] = Math.min(1, c.g * k * boost);
    colors[o + 2] = colors[o + 5] = Math.min(1, c.b * k * boost);
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
      let s = 0;
      if (p.edge.level > 0.45 && p.edge.source.meshGroup?.visible && p.edge.target.meshGroup?.visible) {
        s = p.edge.type === 'track_collab' ? 0.65 : 0.75;
      }
      m.makeScale(s, s, s).setPosition(v);
      this.pulseMesh.setMatrixAt(i, m);
    });
    this.pulseMesh.instanceMatrix.needsUpdate = true;
  }

  setFocusedNode(focusedNodeOrId, nodes = [], edges = [], activeLens = 'all') {
    const activeNode = typeof focusedNodeOrId === 'string'
      ? nodes.find(n => n.id === focusedNodeOrId) || null
      : focusedNodeOrId;
    this.updateFocus(activeNode, nodes, edges, activeLens);
  }

  /**
   * Focus & Dimming Mode:
   * Guarantees that every illuminated connection line has BOTH of its endpoint nodes
   * illuminated and clearly visible.
   */
  updateFocus(activeNode, nodes, edges, activeLens = 'all') {
    const hasLens = Boolean(activeLens && activeLens !== 'all');
    const key = `${activeNode ? activeNode.id : 'none'}|${activeLens || 'all'}`;
    if (key !== this.focusKey) {
      this.focusKey = key;

      const isFocusedView = Boolean(activeNode || hasLens);
      if (this.artistMesh?.material) {
        this.artistMesh.material.depthWrite = !isFocusedView;
      }
      if (this.trackMesh?.material) {
        this.trackMesh.material.depthWrite = !isFocusedView;
      }

      const lensMatch = new Set();
      const lensClusterHasMatch = new Set();
      const lensArtistHasMatchTrack = new Set();
      if (hasLens) {
        for (const n of nodes) {
          if (n.type !== 'genre' && nodeMatchesLens(n, activeLens)) {
            lensMatch.add(n.id);
            if (n.type === 'track') {
              if (n.artistId) lensArtistHasMatchTrack.add(n.artistId);
              (n.featArtistIds || []).forEach(fId => { if (fId) lensArtistHasMatchTrack.add(fId); });
              if (n.featArtistId) lensArtistHasMatchTrack.add(n.featArtistId);
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
            if (n.featArtistId && n.featArtistId !== activeNode.id) collabArtistIds.add(n.featArtistId);
          }
        });

        nodes.forEach(n => {
          let target = DIM_PLANET_FOCUS;
          let scale = 0.85;
          let roleCode = 0;

          if (n.id === activeNode.id) {
            target = 1.25;
            scale = 1.32;
            roleCode = 1;
          } else if (artistTrackIds.has(n.id)) {
            const isCollabSong = activeNode.collabTrackIds?.has(n.id) || (n.featArtistIds?.length > 0);
            const matches = !hasLens || lensMatch.has(n.id);
            target = matches ? 1.2 : 0.65;
            scale = isCollabSong ? 1.5 : 1.38;
          } else if (collabArtistIds.has(n.id)) {
            target = 1.15;
            scale = 1.1;
            roleCode = 2;
            collabArtistNodes.push(n);
          } else if (n.type === 'genre') {
            target = DIM_SUN_FOCUS;
            scale = 0.9;
          } else if (n.type === 'track') {
            target = DIM_MOON_FOCUS;
            scale = 0.75;
          } else {
            target = DIM_PLANET_FOCUS;
            scale = 0.85;
          }

          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = roleCode;
        });

        this.rebuildFocusHighlights(activeNode, artistTrackNodes, collabArtistNodes);

        edges.forEach(e => {
          const sId = e.source.id;
          const tId = e.target.id;
          const touchesSelectedArtist = sId === activeNode.id || tId === activeNode.id;
          const touchesArtistTrack = artistTrackIds.has(sId) || artistTrackIds.has(tId);
          const touchesCollabArtist = collabArtistIds.has(sId) || collabArtistIds.has(tId);

          if (touchesArtistTrack && touchesCollabArtist) {
            e.focusTarget = 0.72;
          } else if (touchesSelectedArtist && touchesArtistTrack) {
            e.focusTarget = 0.95;
          } else {
            e.focusTarget = 0.008;
          }
        });
      } else if (activeNode?.type === 'track') {
        const involvedArtistIds = new Set();
        const involvedArtistNodes = [];
        if (activeNode.artistId) involvedArtistIds.add(activeNode.artistId);
        (activeNode.featArtistIds || []).forEach(id => involvedArtistIds.add(id));
        if (activeNode.featArtistId) involvedArtistIds.add(activeNode.featArtistId);

        nodes.forEach(n => {
          let target = DIM_PLANET_FOCUS;
          let scale = 0.85;
          let roleCode = 0;
          if (n.id === activeNode.id) {
            target = 1.25;
            scale = 1.9;
          } else if (involvedArtistIds.has(n.id)) {
            const isPrimary = n.id === activeNode.artistId;
            target = isPrimary ? 1.25 : 1.15;
            scale = isPrimary ? 1.32 : 1.1;
            roleCode = isPrimary ? 1 : 2;
            involvedArtistNodes.push(n);
          } else if (n.type === 'track' && n.artistId === activeNode.artistId) {
            target = 0.4;
            scale = 0.95;
          } else if (n.type === 'genre') {
            target = DIM_SUN_FOCUS;
            scale = 0.9;
          } else if (n.type === 'track') {
            target = DIM_MOON_FOCUS;
            scale = 0.75;
          }
          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = roleCode;
        });

        this.rebuildFocusHighlights(activeNode, [activeNode], involvedArtistNodes);

        edges.forEach(e => {
          const touchesSong = e.source.id === activeNode.id || e.target.id === activeNode.id;
          e.focusTarget = touchesSong ? 0.85 : 0.008;
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
          let target = inCluster ? 1.0 : (n.type === 'genre' ? DIM_SUN_FOCUS : (n.type === 'track' ? DIM_MOON_FOCUS : DIM_PLANET_FOCUS));
          let scale = inCluster ? 1.0 : 0.85;
          if (hasLens && inCluster && n.id !== activeNode.id) {
            const matches = lensMatch.has(n.id);
            target = matches ? 1.2 : 0.35;
            if (matches && n.type === 'track') scale = 1.4;
          }
          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = 0;
        });

        edges.forEach(e => {
          const bothInCluster = lit.has(e.source.id) && lit.has(e.target.id);
          e.focusTarget = bothInCluster ? e.style.focused * 0.85 : 0.008;
        });
      } else {
        this.clearFocusHighlights();
        const litInLens = new Set();
        nodes.forEach(n => {
          let target = 1.0;
          let scale = 1.0;
          if (hasLens) {
            if (n.type === 'genre') {
              target = lensClusterHasMatch.has(n.id) ? 0.82 : DIM_SUN_FOCUS;
              if (lensClusterHasMatch.has(n.id)) litInLens.add(n.id);
            } else if (lensMatch.has(n.id)) {
              target = 1.2;
              scale = n.type === 'track' ? 1.4 : 1.15;
              litInLens.add(n.id);
            } else if (n.type === 'artist' && lensArtistHasMatchTrack.has(n.id)) {
              target = 0.92;
              scale = 1.05;
              litInLens.add(n.id);
            } else {
              target = n.type === 'track' ? DIM_MOON_FOCUS : DIM_PLANET_FOCUS;
              scale = 0.85;
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
            const bothLit = litInLens.has(e.source.id) && litInLens.has(e.target.id);
            const atLeastOneDirectMatch = lensMatch.has(e.source.id) || lensMatch.has(e.target.id);
            e.focusTarget = (bothLit && atLeastOneDirectMatch) ? Math.min(0.85, e.style.opacity * 2.2) : 0.008;
          }
        });
      }

      if (this.artistInfo) {
        for (const n of this.artistNodes) {
          this.artistInfo.array[n.artistIndex * 3 + 1] = n.focusLevel ?? 1;
          this.artistInfo.array[n.artistIndex * 3 + 2] = (n.roleCode || 0) + (n.seedFrac || 0.15);
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
      sun.nebula.visible = Boolean(sun.meshGroup?.visible !== false) && fl >= 0.15;
      if (!sun.nebula.visible) continue;
      const size = (sun.currentClusterRadius || sun.clusterRadius || 60) * 1.7;
      sun.nebula.scale.set(size, size, 1);
      const d = camera.position.distanceTo(sun.position);
      const fade = THREE.MathUtils.smoothstep(d, size * 0.35, size * 0.9);
      sun.nebula.material.opacity = NEBULA_OPACITY * Math.min(1, fl) * fade;
    }
  }

  updateSolarShaders(time) {
    for (let i = 0; i < this.solarMaterials.length; i++) {
      this.solarMaterials[i].uniforms.uTime.value = time;
    }
  }
}
