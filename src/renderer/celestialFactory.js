// src/renderer/celestialFactory.js
import * as THREE from 'three';
import { createSolarShaderMaterial } from './shaders/solarPlasmaShader.js';
import { createPlanetMaterial } from './shaders/planetShader.js';
import { COLOR_SPOTIFY_GREEN } from '../config/constants.js';

const glowTextureCache = new Map();
const nebulaTextureCache = new Map();

// Opacity multiplier for everything outside the focused node's neighbourhood.
const DIM_LEVEL = 0.025;
const FOCUS_LERP = 0.16;
const SUN_LIGHT_INTENSITY = 1.2;
const NEBULA_OPACITY = 0.13;
const MAX_PULSES = 450;
// Only the most-played artists get an individual glow halo (each halo is a draw call).
const HALO_LIMIT = 320;

const EDGE_STYLE = {
  artist_genre: { opacity: 0.07, focused: 0.52 },
  artist_bridge: { opacity: 0.04, focused: 0.65 },
  track_artist: { opacity: 0.035, focused: 0.78 },
  track_collab: { opacity: 0.025, focused: 0.95 }
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
 * node.fadeTargets so focus dimming and temporal lenses can fade the whole body uniformly.
 */
export class CelestialFactory {
  constructor(scene) {
    this.scene = scene;
    this.solarMaterials = [];
    this.focusKey = null;
    this.glow = 1;
  }

  register(node, material, baseOpacity, isUniform = false, isGlow = false) {
    node.fadeTargets = node.fadeTargets || [];
    node.fadeTargets.push({ material, baseOpacity, isUniform, isGlow });
  }

  applyFade(node) {
    const fl = node.focusLevel ?? 1;
    node.fadeTargets?.forEach(({ material, baseOpacity, isUniform, isGlow }) => {
      const v = baseOpacity * fl * (isGlow ? this.glow : 1);
      if (isUniform && material.uniforms?.uOpacity) material.uniforms.uOpacity.value = v;
      else material.opacity = v;
    });
    if (node.shaderMaterial?.uniforms?.uOpacity) {
      node.shaderMaterial.uniforms.uOpacity.value = fl;
    }
    if (node.sphereMesh && node.type === 'genre') {
      node.sphereMesh.scale.setScalar(fl < 0.08 ? 0.35 + fl * 8 : 1.0);
    }
    if (node.light) node.light.intensity = SUN_LIGHT_INTENSITY * this.glow * fl;
  }

  setGlow(level, nodes) {
    this.glow = level;
    nodes.forEach(n => this.applyFade(n));
  }

  buildGenreSun(node) {
    const group = new THREE.Group();
    group.position.copy(node.position);

    const shaderMat = createSolarShaderMaterial(node.color, node.energy || 0.8);
    if (!shaderMat.uniforms.uOpacity) {
      shaderMat.uniforms.uOpacity = { value: 1.0 };
    }
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

    const nebulaSize = (node.clusterRadius || 60) * 1.95;
    const nebula = makeSprite(getNebulaTexture(node.color), nebulaSize, NEBULA_OPACITY);
    nebula.renderOrder = -1;
    group.add(nebula);
    node.nebula = nebula;

    node.light = new THREE.PointLight(node.color, SUN_LIGHT_INTENSITY * this.glow, (node.clusterRadius || 80) * 1.6, 1.2);
    group.add(node.light);

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
    node.sprite = corona;
    node.shaderMaterial = shaderMat;
    this.scene.add(group);
    return group;
  }

  buildArtistPlanets(artistNodes) {
    const n = Math.max(1, artistNodes.length);
    const geometry = new THREE.SphereGeometry(1, 24, 18);
    const info = new Float32Array(n * 3);
    const mesh = new THREE.InstancedMesh(geometry, createPlanetMaterial(), n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    const decor = new THREE.Group();
    const byListening = artistNodes.slice().sort((a, b) => (b.normScore ?? 0) - (a.normScore ?? 0));
    const haloSet = new Set(byListening.slice(0, HALO_LIMIT));

    artistNodes.forEach((node, i) => {
      const listen = node.normScore ?? 1;
      node.artistIndex = i;
      node.lensScale = 1.0;
      node.meshGroup = { position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1), visible: true, isInstanceHandle: true };
      mesh.setColorAt(i, new THREE.Color(node.color));
      info[i * 3] = listen;
      info[i * 3 + 1] = 1;
      info[i * 3 + 2] = (parseInt(String(node.id).slice(-6), 36) % 997) / 997 || 0.3;

      node.decor = [];
      if (haloSet.has(node)) {
        const haloOpacity = 0.05 + 0.25 * listen * listen;
        const glow = makeSprite(getProceduralGlowTexture(node.color), node.baseRadius * 3.0, haloOpacity);
        glow.userData.size = 3.0;
        decor.add(glow);
        node.decor.push(glow);
        this.register(node, glow.material, haloOpacity, false, true);
      }
      // Headline artists or past-favorite artists get an orbital ring
      if ((node.labelRank === 0 && !node.isBridge) || node.history?.status === 'past_fav') {
        const ringColor = node.history?.status === 'past_fav' ? '#F4E9C8' : node.color;
        const ringOpacity = node.labelRank === 0 ? 0.32 : 0.22;
        const ring = createRing(1.42, 1.88, ringColor, ringOpacity);
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
      const r = h.visible ? node.baseRadius * (node.lensScale ?? 1) : 0;
      sc.copy(h.scale).multiplyScalar(r);
      m.compose(h.position, q, sc);
      this.artistMesh.setMatrixAt(node.artistIndex, m);
      const showDecor = h.visible && (node.focusLevel ?? 1) > 0.08;
      for (const d of node.decor) {
        d.visible = showDecor;
        if (!showDecor) continue;
        d.position.copy(h.position);
        const s = r * h.scale.x * d.userData.size;
        if (d.isSprite) d.scale.set(s, s, 1);
        else d.scale.setScalar(s);
      }
    }
    this.artistMesh.instanceMatrix.needsUpdate = true;
  }

  buildTrackSatellites(trackNodes) {
    const geometry = new THREE.SphereGeometry(1, 14, 10);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x161622 });
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, trackNodes.length));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    const white = new THREE.Color('#FFFFFF');
    const gold = new THREE.Color('#F4E9C8');
    trackNodes.forEach((node, i) => {
      node.instanceIndex = i;
      node.lensScale = 1.0;
      const base = new THREE.Color(node.color || COLOR_SPOTIFY_GREEN);
      // Past favorites get a warm starlight tint so they are subtly distinguishable up close
      node.baseInstanceColor = node.history?.status === 'past_fav'
        ? base.lerp(gold, 0.32)
        : base.lerp(white, 0.2);
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

  updateTrackInstances() {
    if (!this.trackMesh) return;
    const m = this._m || (this._m = new THREE.Matrix4());
    const q = this._q || (this._q = new THREE.Quaternion());
    const sc = this._s || (this._s = new THREE.Vector3());
    for (const node of this.trackNodes) {
      const h = node.meshGroup;
      const r = h.visible ? node.baseRadius * (node.lensScale ?? 1) : 0;
      sc.copy(h.scale).multiplyScalar(r);
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

  disposeBatches() {
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

    // Prioritize collaboration threads first so every collaboration edge gets animated pulses
    const collabEdges = edges.filter(e => e.type === 'track_collab');
    const otherPulseEdges = edges.filter(e => e.type !== 'track_artist' && e.type !== 'track_collab');
    const pulseEdges = [...collabEdges, ...otherPulseEdges].slice(0, MAX_PULSES);

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
        s = p.edge.type === 'track_collab' ? 1.45 : 1.0;
      }
      m.makeScale(s, s, s).setPosition(v);
      this.pulseMesh.setMatrixAt(i, m);
    });
    this.pulseMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Fades everything outside the active node's neighbourhood AND/OR highlights nodes
   * matching the active Time & Memory Lens (`activeLens`).
   *
   * When an Artist (`activeNode.type === 'artist'`) is focused:
   *  - All cluster suns, unrelated planets, and unrelated moons fade away deeply
   *  - Only the selected artist, all of their songs (including featured tracks),
   *    all collaborating artists on those songs, and the threads connecting
   *    artist <-> songs <-> collaborating artists remain brightly illuminated.
   */
  updateFocus(activeNode, nodes, edges, activeLens = 'all') {
    const hasLens = Boolean(activeLens && activeLens !== 'all');
    const key = `${activeNode ? activeNode.id : 'none'}|${activeLens || 'all'}`;
    if (key !== this.focusKey) {
      this.focusKey = key;

      // Identify lens matches when a temporal lens is active
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
        // Deep Artist Isolation Mode:
        // 1. Selected artist's songs (primary + featured)
        // 2. Collaborating artists connected to those songs
        const artistTrackIds = new Set();
        const collabArtistIds = new Set(activeNode.collaboratorArtistIds || []);
        const parentSunIds = new Set(activeNode.genres || []);

        nodes.forEach(n => {
          if (n.type === 'track' && activeNode.neighbors?.has(n.id)) {
            artistTrackIds.add(n.id);
            if (n.artistId && n.artistId !== activeNode.id) collabArtistIds.add(n.artistId);
            (n.featArtistIds || []).forEach(fId => {
              if (fId !== activeNode.id) collabArtistIds.add(fId);
            });
          }
        });

        nodes.forEach(n => {
          let target = 0.012;
          let scale = 1.0;

          if (n.id === activeNode.id) {
            target = 1.0;
            scale = 1.38;
          } else if (artistTrackIds.has(n.id)) {
            const isCollabSong = activeNode.collabTrackIds?.has(n.id) || (n.featArtistIds?.length > 0);
            const matches = !hasLens || lensMatch.has(n.id);
            target = matches ? 1.0 : 0.35;
            scale = isCollabSong ? 1.75 : 1.5;
          } else if (collabArtistIds.has(n.id)) {
            target = 0.96;
            scale = 1.24;
          } else if (n.type === 'genre') {
            // Fade all cluster suns deeply away so they don't overpower the artist & collab threads
            target = parentSunIds.has(n.id) ? 0.035 : 0.008;
            scale = 0.85;
          } else if (n.type === 'artist') {
            target = 0.012;
            scale = 0.45;
          } else if (n.type === 'track') {
            target = 0.0;
            scale = 0.0;
          }

          n.focusTarget = target;
          n.lensScale = scale;
        });

        edges.forEach(e => {
          const sId = e.source.id;
          const tId = e.target.id;
          const touchesSelectedArtist = sId === activeNode.id || tId === activeNode.id;
          const touchesArtistTrack = artistTrackIds.has(sId) || artistTrackIds.has(tId);
          const touchesCollabArtist = collabArtistIds.has(sId) || collabArtistIds.has(tId);

          if (e.type === 'artist_genre') {
            // Hide sun-spoke lines completely when inspecting an artist
            e.focusTarget = 0.0;
          } else if (touchesArtistTrack && touchesCollabArtist) {
            // Collaboration thread connecting one of the artist's songs to a collaborating artist!
            e.focusTarget = 0.96;
          } else if (touchesSelectedArtist && touchesArtistTrack) {
            // Thread connecting the selected artist to their own song moon
            e.focusTarget = 0.82;
          } else {
            e.focusTarget = 0.0;
          }
        });
      } else if (activeNode?.type === 'track') {
        // Song Focus Isolation Mode: show song moon, primary artist, and any collaborating artists
        const involvedArtistIds = new Set();
        if (activeNode.artistId) involvedArtistIds.add(activeNode.artistId);
        (activeNode.featArtistIds || []).forEach(id => involvedArtistIds.add(id));
        if (activeNode.featArtistId) involvedArtistIds.add(activeNode.featArtistId);

        nodes.forEach(n => {
          let target = 0.012;
          let scale = 1.0;
          if (n.id === activeNode.id) {
            target = 1.0;
            scale = 1.85;
          } else if (involvedArtistIds.has(n.id)) {
            target = 1.0;
            scale = 1.28;
          } else if (n.type === 'track' && n.artistId === activeNode.artistId) {
            target = 0.22;
            scale = 0.9;
          } else if (n.type === 'genre') {
            target = 0.02;
          } else if (n.type === 'track') {
            target = 0.0;
            scale = 0.0;
          } else {
            target = 0.012;
            scale = 0.45;
          }
          n.focusTarget = target;
          n.lensScale = scale;
        });

        edges.forEach(e => {
          const touchesSong = e.source.id === activeNode.id || e.target.id === activeNode.id;
          e.focusTarget = touchesSong ? 0.95 : 0.0;
        });
      } else if (activeNode?.type === 'genre') {
        // Cluster Focus Mode: highlight this cluster's sun, artists, and tracks; fade other clusters
        const lit = new Set([activeNode.id]);
        activeNode.neighbors?.forEach(id => lit.add(id));
        nodes.forEach(n => {
          if (n.type === 'artist' && n.genres?.includes(activeNode.id)) {
            n.neighbors?.forEach(id => lit.add(id));
          }
        });

        nodes.forEach(n => {
          const inCluster = lit.has(n.id);
          let target = inCluster ? 1.0 : 0.025;
          let scale = inCluster ? 1.0 : (n.type === 'track' ? 0.0 : 0.55);
          if (hasLens && inCluster && n.id !== activeNode.id) {
            const matches = lensMatch.has(n.id);
            target = matches ? 1.0 : 0.25;
            if (matches && n.type === 'track') scale = 1.45;
          }
          n.focusTarget = target;
          n.lensScale = scale;
        });

        edges.forEach(e => {
          const both = lit.has(e.source.id) && lit.has(e.target.id);
          e.focusTarget = both ? e.style.focused * 0.75 : 0.0;
        });
      } else {
        // Overview Mode (with optional Time & Memory Lens)
        nodes.forEach(n => {
          let target = 1.0;
          let scale = 1.0;
          if (hasLens) {
            if (n.type === 'genre') {
              target = lensClusterHasMatch.has(n.id) ? 0.78 : 0.14;
            } else if (lensMatch.has(n.id)) {
              target = 1.0;
              scale = n.type === 'track' ? 1.5 : 1.15;
            } else if (n.type === 'artist' && lensArtistHasMatchTrack.has(n.id)) {
              target = 0.55;
            } else {
              target = 0.08;
            }
          }
          n.focusTarget = target;
          n.lensScale = scale;
        });

        edges.forEach(e => {
          if (hasLens) {
            const matchEdge = lensMatch.has(e.source.id) || lensMatch.has(e.target.id);
            e.focusTarget = matchEdge ? e.style.focused * 0.75 : e.style.opacity * 0.15;
          } else {
            e.focusTarget = e.style.opacity;
          }
        });
      }
    }

    let trackColorsDirty = false;
    let artistInfoDirty = false;
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
      if (n.artistIndex !== undefined && this.artistInfo) {
        this.artistInfo.array[n.artistIndex * 3 + 1] = n.focusLevel;
        artistInfoDirty = true;
      }
    }
    if (trackColorsDirty) this.trackMesh.instanceColor.needsUpdate = true;
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
      const size = (sun.currentClusterRadius || sun.clusterRadius || 60) * 1.95;
      sun.nebula.scale.set(size, size, 1);
      const d = camera.position.distanceTo(sun.position);
      const fade = THREE.MathUtils.smoothstep(d, size * 0.35, size * 0.9);
      const fl = sun.focusLevel ?? 1;
      sun.nebula.material.opacity = NEBULA_OPACITY * this.glow * (fl < 0.25 ? fl * fl * 4 : fl) * fade;
    }
  }

  updateSolarShaders(time) {
    for (let i = 0; i < this.solarMaterials.length; i++) {
      this.solarMaterials[i].uniforms.uTime.value = time;
    }
  }
}
