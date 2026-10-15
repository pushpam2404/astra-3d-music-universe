// src/renderer/celestialFactory.js
import * as THREE from 'three';
import { createSolarShaderMaterial } from './shaders/solarPlasmaShader.js';
import { createFresnelPlanetMaterial } from './shaders/fresnelPlanetShader.js';
import { COLOR_SPOTIFY_GREEN } from '../config/constants.js';

const glowTextureCache = new Map();
const nebulaTextureCache = new Map();

// Opacity multiplier for everything outside the focused node's neighbourhood.
const DIM_LEVEL = 0.12;
const FOCUS_LERP = 0.12;
const SUN_LIGHT_INTENSITY = 1.2;
const NEBULA_OPACITY = 0.16;
const MAX_PULSES = 400;

const EDGE_STYLE = {
  artist_genre: { opacity: 0.09, focused: 0.55 },
  artist_bridge: { opacity: 0.1, focused: 0.7 },
  track_artist: { opacity: 0.05, focused: 0.4 },
  track_collab: { opacity: 0.1, focused: 0.85 }
};

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
  gradient.addColorStop(0.0, 'rgba(255, 255, 255, 0.9)');
  gradient.addColorStop(0.15, `rgba(${rgb}, 0.75)`);
  gradient.addColorStop(0.45, `rgba(${rgb}, 0.18)`);
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
  // Fade to transparent at the edge so the sprite never shows a square.
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

function createRing(innerR, outerR, colorHex, opacity) {
  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colorHex),
    side: THREE.DoubleSide,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(innerR, outerR, 72), ringMat);
  ring.rotation.x = Math.PI / 2.2;
  ring.rotation.y = Math.PI / 7.0;
  return ring;
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
 * Builds and styles the celestial meshes. Every material a node owns is registered in
 * node.fadeTargets so focus dimming can fade the whole body uniformly.
 */
export class CelestialFactory {
  constructor(scene) {
    this.scene = scene;
    this.solarMaterials = [];
    this.focusKey = null;
    // Glow multiplier (View → Glow): scales halos, nebulae and sun light; 0 turns them off.
    this.glow = 1;
  }

  /** isGlow targets (halos, coronas) also scale with the Glow setting. */
  register(node, material, baseOpacity, isUniform = false, isGlow = false) {
    node.fadeTargets = node.fadeTargets || [];
    node.fadeTargets.push({ material, baseOpacity, isUniform, isGlow });
  }

  applyFade(node) {
    node.fadeTargets?.forEach(({ material, baseOpacity, isUniform, isGlow }) => {
      const v = baseOpacity * (node.focusLevel ?? 1) * (isGlow ? this.glow : 1);
      if (isUniform) material.uniforms.uOpacity.value = v;
      else material.opacity = v;
    });
    if (node.light) node.light.intensity = SUN_LIGHT_INTENSITY * this.glow * (node.focusLevel ?? 1);
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

    // Cluster nebula: a large soft cloud that makes the cluster's territory readable.
    const nebulaSize = (node.clusterRadius || 60) * 2.3;
    const nebula = makeSprite(getNebulaTexture(node.color), nebulaSize, NEBULA_OPACITY);
    nebula.renderOrder = -1;
    group.add(nebula);
    node.nebula = nebula; // opacity driven by updateNebulae (focus × camera distance)

    node.light = new THREE.PointLight(node.color, SUN_LIGHT_INTENSITY * this.glow, (node.clusterRadius || 80) * 1.6, 1.2);
    group.add(node.light);

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
    node.sprite = corona;
    node.shaderMaterial = shaderMat;
    this.scene.add(group);
    return group;
  }

  buildArtistPlanet(node) {
    const group = new THREE.Group();
    group.position.copy(node.position);

    const seed = (parseInt(String(node.id).slice(-6), 36) % 997) / 997 || 0.3;
    const planetMat = createFresnelPlanetMaterial(node.color, node.valence ?? 0.6, seed);
    const sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(node.baseRadius, 32, 32), planetMat);
    sphereMesh.userData = { node };
    group.add(sphereMesh);
    this.register(node, planetMat, 1.0, true);

    const glow = makeSprite(getProceduralGlowTexture(node.color), node.baseRadius * 3.0, 0.2);
    group.add(glow);
    this.register(node, glow.material, 0.2, false, true);

    // Ring marks each cluster's headline artist.
    if (node.labelRank === 0 && !node.isBridge) {
      const ring = createRing(node.baseRadius * 1.45, node.baseRadius * 1.95, node.color, 0.32);
      group.add(ring);
      this.register(node, ring.material, 0.32);
    }

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
    node.sprite = glow;
    this.scene.add(group);
    return group;
  }

  /**
   * All tracks share one InstancedMesh (thousands of Liked Songs would otherwise be
   * thousands of draw calls). Each track gets a lightweight handle with the same
   * `position` / `scale` / `visible` surface as a THREE.Group, so the layout, layer
   * toggles and time machine keep working unchanged.
   */
  buildTrackSatellites(trackNodes) {
    const geometry = new THREE.SphereGeometry(1, 14, 10);
    // Lit (not glowing) so moons read as small shaded spheres in their planet's color.
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x111118 });
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, trackNodes.length));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    const white = new THREE.Color('#FFFFFF');
    trackNodes.forEach((node, i) => {
      node.instanceIndex = i;
      // Moons keep their planet's hue (only slightly lifted) so a system reads as one color.
      node.baseInstanceColor = new THREE.Color(node.color || COLOR_SPOTIFY_GREEN).lerp(white, 0.2);
      node.meshGroup = { position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1), visible: true, isInstanceHandle: true };
      mesh.setColorAt(i, node.baseInstanceColor);
    });
    mesh.count = trackNodes.length;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.trackMesh = mesh;
    this.trackNodes = trackNodes;
    this.scene.add(mesh);
    return mesh;
  }

  /** Writes every track handle into the instance matrices (call once per frame). */
  updateTrackInstances() {
    if (!this.trackMesh) return;
    const m = this._m || (this._m = new THREE.Matrix4());
    const q = this._q || (this._q = new THREE.Quaternion());
    const sc = this._s || (this._s = new THREE.Vector3());
    for (const node of this.trackNodes) {
      const h = node.meshGroup;
      const r = h.visible ? node.baseRadius : 0;
      sc.copy(h.scale).multiplyScalar(r);
      m.compose(h.position, q, sc);
      this.trackMesh.setMatrixAt(node.instanceIndex, m);
    }
    this.trackMesh.instanceMatrix.needsUpdate = true;
  }

  /** Resolves a raycast hit (planet/sun mesh or a track instance) to its node. */
  nodeFromHit(hit) {
    if (hit.object === this.trackMesh) return this.trackNodes[hit.instanceId] || null;
    return hit.object.userData.node || null;
  }

  disposeBatches() {
    [this.trackMesh, this.edgeLines, this.pulseMesh].forEach(obj => {
      if (!obj) return;
      this.scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    });
    this.trackMesh = this.edgeLines = this.pulseMesh = null;
    this.trackNodes = [];
  }

  /**
   * All links are one LineSegments draw call. With additive blending, a vertex color
   * scaled by k looks exactly like opacity k, so per-link opacity lives in the colors.
   */
  buildEdgeVisuals(edges) {
    const positions = new Float32Array(edges.length * 6);
    const colors = new Float32Array(edges.length * 6);
    edges.forEach((edge, i) => {
      const isBridgeLink = edge.type === 'artist_genre' && edge.source.genres?.[1] === edge.target.id;
      edge.style = EDGE_STYLE[isBridgeLink ? 'artist_bridge' : edge.type] || EDGE_STYLE.track_artist;
      edge.index = i;
      edge.baseColor = new THREE.Color(edge.color || '#00F0FF');
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

    // Energy pulses ride the structural links only (not every moon tether), capped.
    const pulseEdges = edges.filter(e => e.type !== 'track_artist').slice(0, MAX_PULSES);
    const pulseMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.45, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      Math.max(1, pulseEdges.length)
    );
    pulseMesh.count = pulseEdges.length;
    pulseMesh.frustumCulled = false;
    pulseEdges.forEach((e, i) => pulseMesh.setColorAt(i, new THREE.Color(e.type === 'track_collab' ? '#FFB800' : (e.color || '#FFFFFF'))));
    if (pulseMesh.instanceColor) pulseMesh.instanceColor.needsUpdate = true;
    this.pulseMesh = pulseMesh;

    const pulseParticles = pulseEdges.map((edge, idx) => ({
      edge,
      progress: (idx * 0.173) % 1.0,
      speed: 0.0025 + (idx % 4) * 0.001
    }));

    this.focusKey = null;
    // edgeLinesGroup lets main.js toggle the whole link layer.
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

  /** Copies endpoint positions into the merged line geometry (once per frame). */
  updateEdgeGeometry(edges) {
    if (!this.edgeLines) return;
    const pos = this.edgeLines.geometry.attributes.position;
    const arr = pos.array;
    for (const e of edges) {
      const o = e.index * 6;
      const s = e.source.position, d = e.target.position;
      const hidden = !e.source.meshGroup?.visible || !e.target.meshGroup?.visible;
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
    const speedScale = Math.max(0.2, orbitSpeed);
    const m = this._pm || (this._pm = new THREE.Matrix4());
    const v = this._pv || (this._pv = new THREE.Vector3());
    pulseParticles.forEach((p, i) => {
      p.progress = (p.progress + p.speed * speedScale) % 1.0;
      v.lerpVectors(p.edge.source.position, p.edge.target.position, p.progress);
      // Pulses fade with their link when out of focus.
      const s = Math.min(1, p.edge.level / p.edge.style.opacity) > 0.5 ? 1 : 0.35;
      m.makeScale(s, s, s).setPosition(v);
      this.pulseMesh.setMatrixAt(i, m);
    });
    this.pulseMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Fades everything outside the active node's neighbourhood. Targets are recomputed
   * only when the active node changes; levels ease toward them every frame.
   */
  updateFocus(activeNode, nodes, edges) {
    const key = activeNode ? activeNode.id : null;
    if (key !== this.focusKey) {
      this.focusKey = key;
      const lit = new Set();
      if (activeNode) {
        lit.add(activeNode.id);
        activeNode.neighbors?.forEach(id => lit.add(id));
        // A sun lights its whole system: planets and their moons.
        if (activeNode.type === 'genre') {
          nodes.forEach(n => {
            if (n.type === 'artist' && n.genres?.includes(activeNode.id)) n.neighbors.forEach(id => lit.add(id));
          });
        }
      }
      nodes.forEach(n => { n.focusTarget = !activeNode || lit.has(n.id) ? 1 : DIM_LEVEL; });
      edges.forEach(e => {
        const both = activeNode && lit.has(e.source.id) && lit.has(e.target.id);
        const touches = activeNode && (e.source.id === activeNode.id || e.target.id === activeNode.id);
        e.focusTarget = !activeNode ? e.style.opacity : (touches || both ? e.style.focused : e.style.opacity * 0.25);
      });
    }

    let trackColorsDirty = false;
    const tmpColor = this._fc || (this._fc = new THREE.Color());
    for (const n of nodes) {
      if (n.focusLevel === undefined) n.focusLevel = 1;
      const target = n.focusTarget ?? 1;
      if (Math.abs(n.focusLevel - target) < 0.002) continue;
      n.focusLevel += (target - n.focusLevel) * FOCUS_LERP;
      if (n.instanceIndex !== undefined && this.trackMesh) {
        this.trackMesh.setColorAt(n.instanceIndex, tmpColor.copy(n.baseInstanceColor).multiplyScalar(n.focusLevel));
        trackColorsDirty = true;
      }
      this.applyFade(n);
    }
    if (trackColorsDirty) this.trackMesh.instanceColor.needsUpdate = true;

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

  /**
   * Nebulae fade out as the camera flies into them: from inside, a cluster's cloud
   * would cover the whole screen.
   */
  updateNebulae(camera, suns) {
    for (const sun of suns) {
      if (!sun.nebula) continue;
      const size = sun.nebula.scale.x;
      const d = camera.position.distanceTo(sun.position);
      const fade = THREE.MathUtils.smoothstep(d, size * 0.35, size * 0.9);
      sun.nebula.material.opacity = NEBULA_OPACITY * this.glow * (sun.focusLevel ?? 1) * fade;
    }
  }

  updateSolarShaders(time) {
    for (let i = 0; i < this.solarMaterials.length; i++) {
      this.solarMaterials[i].uniforms.uTime.value = time;
    }
  }
}
