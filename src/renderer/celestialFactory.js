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

const EDGE_STYLE = {
  artist_genre: { opacity: 0.09, focused: 0.55 },
  artist_bridge: { opacity: 0.2, focused: 0.7 },
  track_artist: { opacity: 0.05, focused: 0.4 },
  track_collab: { opacity: 0.32, focused: 0.85 }
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
  }

  register(node, material, baseOpacity, isUniform = false) {
    node.fadeTargets = node.fadeTargets || [];
    node.fadeTargets.push({ material, baseOpacity, isUniform });
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

    const corona = makeSprite(getProceduralGlowTexture(node.color), node.haloRadius || node.baseRadius * 4, 0.75);
    group.add(corona);
    this.register(node, corona.material, 0.75);

    // Cluster nebula: a large soft cloud that makes the cluster's territory readable.
    const nebulaSize = (node.clusterRadius || 60) * 2.3;
    const nebula = makeSprite(getNebulaTexture(node.color), nebulaSize, 0.26);
    nebula.renderOrder = -1;
    group.add(nebula);
    this.register(node, nebula.material, 0.26);

    group.add(new THREE.PointLight(node.color, 2.2, (node.clusterRadius || 80) * 1.6, 1.2));

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

    const glow = makeSprite(getProceduralGlowTexture(node.color), node.baseRadius * 3.4, 0.4);
    group.add(glow);
    this.register(node, glow.material, 0.4);

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

  buildTrackSatellite(node) {
    const group = new THREE.Group();
    group.position.copy(node.position);

    const color = new THREE.Color(node.color || COLOR_SPOTIFY_GREEN).lerp(new THREE.Color('#FFFFFF'), 0.35);
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true
    });
    const sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(node.baseRadius, 16, 16), material);
    sphereMesh.userData = { node };
    group.add(sphereMesh);
    this.register(node, material, 1.0);

    const glow = makeSprite(getProceduralGlowTexture(`#${color.getHexString()}`), node.baseRadius * 3.2, 0.35);
    group.add(glow);
    this.register(node, glow.material, 0.35);

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
    node.sprite = glow;
    this.scene.add(group);
    return group;
  }

  buildEdgeVisuals(edges) {
    const edgeLinesGroup = new THREE.Group();
    const pulseParticles = [];
    const pulseGeo = new THREE.SphereGeometry(0.45, 8, 8);

    edges.forEach((edge, idx) => {
      // An artist's link to its secondary sun is a bridge link.
      const isBridgeLink = edge.type === 'artist_genre' && edge.source.genres?.[1] === edge.target.id;
      edge.style = EDGE_STYLE[isBridgeLink ? 'artist_bridge' : edge.type] || EDGE_STYLE.track_artist;

      const lineGeo = new THREE.BufferGeometry().setFromPoints([edge.source.position, edge.target.position]);
      const lineMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(edge.color || '#00F0FF'),
        transparent: true,
        opacity: edge.style.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const line = new THREE.Line(lineGeo, lineMat);
      edge.lineMesh = line;
      edgeLinesGroup.add(line);

      // Energy pulses only on the structural links, not on every moon tether.
      if (edge.type === 'track_artist') return;
      const pulseMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(edge.type === 'track_collab' ? '#FFB800' : (edge.color || '#FFFFFF')),
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const pulseMesh = new THREE.Mesh(pulseGeo, pulseMat);
      edgeLinesGroup.add(pulseMesh);
      edge.pulseMesh = pulseMesh;
      pulseParticles.push({
        mesh: pulseMesh,
        edge,
        progress: (idx * 0.173) % 1.0,
        speed: 0.0025 + (idx % 4) * 0.001
      });
    });

    this.scene.add(edgeLinesGroup);
    this.focusKey = null;
    return { edgeLinesGroup, pulseParticles };
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

    for (const n of nodes) {
      if (n.focusLevel === undefined) n.focusLevel = 1;
      const target = n.focusTarget ?? 1;
      if (Math.abs(n.focusLevel - target) < 0.002) continue;
      n.focusLevel += (target - n.focusLevel) * FOCUS_LERP;
      n.fadeTargets?.forEach(({ material, baseOpacity, isUniform }) => {
        if (isUniform) material.uniforms.uOpacity.value = baseOpacity * n.focusLevel;
        else material.opacity = baseOpacity * n.focusLevel;
      });
    }
    for (const e of edges) {
      if (!e.lineMesh || e.focusTarget === undefined) continue;
      const m = e.lineMesh.material;
      if (Math.abs(m.opacity - e.focusTarget) < 0.002) continue;
      m.opacity += (e.focusTarget - m.opacity) * FOCUS_LERP;
      if (e.pulseMesh) e.pulseMesh.material.opacity = Math.min(1, m.opacity * 2.2);
    }
  }

  updateSolarShaders(time) {
    for (let i = 0; i < this.solarMaterials.length; i++) {
      this.solarMaterials[i].uniforms.uTime.value = time;
    }
  }
}
