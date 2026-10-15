// src/renderer/celestialFactory.js
import * as THREE from 'three';
import { createSolarShaderMaterial } from './shaders/solarPlasmaShader.js';
import { createFresnelPlanetMaterial } from './shaders/fresnelPlanetShader.js';
import { COLOR_SPOTIFY_GREEN } from '../config/constants.js';

const glowTextureCache = new Map();

/**
 * Procedural Additive Corona Texture Generator
 * Prevents CORS texture loading issues by rendering radial glow onto offscreen canvas.
 */
export function getProceduralGlowTexture(hexColor) {
  if (glowTextureCache.has(hexColor)) {
    return glowTextureCache.get(hexColor);
  }

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const color = new THREE.Color(hexColor);
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);

  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 2,
    size / 2, size / 2, size / 2
  );
  gradient.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  gradient.addColorStop(0.18, `rgba(${r}, ${g}, ${b}, 0.9)`);
  gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.28)`);
  gradient.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  glowTextureCache.set(hexColor, texture);
  return texture;
}

/**
 * Creates Saturn-like concentric planetary rings
 */
function createPlanetaryRings(radius, colorHex) {
  const innerR = radius * 1.45;
  const outerR = radius * 2.2;
  const ringGeo = new THREE.RingGeometry(innerR, outerR, 48);
  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colorHex),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.rotation.x = Math.PI / 2.3;
  ringMesh.rotation.y = Math.PI / 6.0;
  return ringMesh;
}

/**
 * Factory for building celestial 3D representations
 */
export class CelestialFactory {
  constructor(scene) {
    this.scene = scene;
    this.solarMaterials = [];
  }

  buildGenreSun(node) {
    const group = new THREE.Group();
    group.position.copy(node.position);

    // 1. Solar Plasma Sphere Mesh
    const sphereGeo = new THREE.SphereGeometry(node.baseRadius, 32, 32);
    const shaderMat = createSolarShaderMaterial(node.color, node.energy || 0.8);
    this.solarMaterials.push(shaderMat);

    const sphereMesh = new THREE.Mesh(sphereGeo, shaderMat);
    sphereMesh.userData = { node };
    group.add(sphereMesh);

    // 2. Saturn rings
    const rings = createPlanetaryRings(node.baseRadius, node.color);
    group.add(rings);

    // 3. Additive Corona Glow Sprite
    const glowTex = getProceduralGlowTexture(node.color);
    const spriteMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(spriteMat);
    const spriteSize = node.haloRadius || (node.baseRadius * 4.2);
    sprite.scale.set(spriteSize, spriteSize, 1.0);
    group.add(sprite);

    // 4. Emissive Point Light
    const pointLight = new THREE.PointLight(node.color, 1.8, 160);
    group.add(pointLight);

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
    node.sprite = sprite;
    node.shaderMaterial = shaderMat;

    this.scene.add(group);
    return group;
  }

  buildArtistPlanet(node) {
    const group = new THREE.Group();
    group.position.copy(node.position);

    // 1. Fresnel Atmosphere Planet Sphere
    const sphereGeo = new THREE.SphereGeometry(node.baseRadius, 24, 24);
    const fresnelMat = createFresnelPlanetMaterial(node.color, node.valence || 0.6);
    const sphereMesh = new THREE.Mesh(sphereGeo, fresnelMat);
    sphereMesh.userData = { node };
    group.add(sphereMesh);

    // 2. Additive Corona Glow Sprite
    const glowTex = getProceduralGlowTexture(node.color);
    const spriteMat = new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(spriteMat);
    const spriteSize = node.haloRadius || (node.baseRadius * 3.2);
    sprite.scale.set(spriteSize, spriteSize, 1.0);
    group.add(sprite);

    // 3. Mini ring for high-popularity artists
    if (node.basePlays > 1800) {
      const miniRing = createPlanetaryRings(node.baseRadius * 0.9, node.color);
      group.add(miniRing);
    }

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
    node.sprite = sprite;

    this.scene.add(group);
    return group;
  }

  buildTrackSatellite(node) {
    const group = new THREE.Group();
    group.position.copy(node.position);

    // 1. Satellite Sphere Mesh
    const sphereGeo = new THREE.SphereGeometry(node.baseRadius, 16, 16);
    const trackColor = node.color || COLOR_SPOTIFY_GREEN;
    const material = new THREE.MeshStandardMaterial({
      color: trackColor,
      emissive: trackColor,
      emissiveIntensity: 0.65,
      roughness: 0.3,
      metalness: 0.2
    });
    const sphereMesh = new THREE.Mesh(sphereGeo, material);
    sphereMesh.userData = { node };
    group.add(sphereMesh);

    // 2. Satellite Halo Sprite
    const glowTex = getProceduralGlowTexture(trackColor);
    const spriteMat = new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(spriteMat);
    const spriteSize = node.haloRadius || (node.baseRadius * 2.6);
    sprite.scale.set(spriteSize, spriteSize, 1.0);
    group.add(sprite);

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
    node.sprite = sprite;

    this.scene.add(group);
    return group;
  }

  buildEdgeVisuals(edges) {
    const edgeLinesGroup = new THREE.Group();
    const pulseParticles = [];

    const pulseGeo = new THREE.SphereGeometry(0.55, 8, 8);

    edges.forEach((edge, idx) => {
      // Line
      const points = [edge.source.position, edge.target.position];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const isCollab = edge.type === 'track_collab';
      const isArtistGenre = edge.type === 'artist_genre';

      const lineMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(edge.color || '#00F0FF'),
        transparent: true,
        opacity: isArtistGenre ? 0.38 : (isCollab ? 0.55 : 0.22),
        blending: THREE.AdditiveBlending
      });

      const line = new THREE.Line(lineGeo, lineMat);
      edge.lineMesh = line;
      edgeLinesGroup.add(line);

      // Synaptic Energy Pulse
      const pulseMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(isCollab ? '#FFB800' : (edge.color || '#FFFFFF')),
        blending: THREE.AdditiveBlending
      });
      const pulseMesh = new THREE.Mesh(pulseGeo, pulseMat);
      edgeLinesGroup.add(pulseMesh);

      pulseParticles.push({
        mesh: pulseMesh,
        edge,
        progress: (idx * 0.17) % 1.0,
        speed: 0.0035 + (idx % 4) * 0.0015
      });
    });

    this.scene.add(edgeLinesGroup);
    return { edgeLinesGroup, pulseParticles };
  }

  updateSolarShaders(time) {
    for (let i = 0; i < this.solarMaterials.length; i++) {
      this.solarMaterials[i].uniforms.uTime.value = time;
    }
  }
}
