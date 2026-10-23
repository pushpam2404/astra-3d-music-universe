// src/renderer/celestialFactory.js
import * as THREE from 'three';
import { createSolarShaderMaterial } from './shaders/solarPlasmaShader.js';
import { createPlanetMaterial, createMoonCrystalMaterial } from './shaders/planetShader.js';
import { COLOR_SPOTIFY_GREEN } from '../config/constants.js';

const FOCUS_LERP = 0.24;
const SUN_LIGHT_INTENSITY = 1.0;
const MAX_PULSES = 450;
const STARLIGHT_HEX = '#F4E9C8';

// Quiet matte levels for unselected background nodes
const DIM_PLANET_FOCUS = 0.25;
const DIM_SUN_FOCUS = 0.70;
const DIM_MOON_FOCUS = 0.0;

const EDGE_STYLE = {
  artist_genre: { opacity: 0.05, focused: 0.52 },
  artist_bridge: { opacity: 0.04, focused: 0.68 },
  track_artist: { opacity: 0.14, focused: 0.95 },
  track_collab: { opacity: 0.04, focused: 0.88 }
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

/**
 * Builds and styles the celestial meshes:
 *  - Cluster Centers (Genre Suns): solid, non-glowing 3D central planets with a crisp black
 *    border on light-colored clusters and zero radial glow/corona blowout.
 *  - Artist Planets & Song Moons: 100% OPAQUE (`transparent: false, depthWrite: true`)
 *    with a crisp black border on light-colored clusters so individual overlapping shapes
 *    are immediately recognizable.
 *  - Strict Lens & Focus Culling: when a Time/Memory Lens is active, non-matching nodes and
 *    their lines are culled so only items matching the filter appear.
 */
export class CelestialFactory {
  constructor(scene) {
    this.scene = scene;
    this.solarMaterials = [];
    this.focusKey = null;
    this.focusHighlightGroup = new THREE.Group();
    this.scene.add(this.focusHighlightGroup);
    this.dynamicCollabMarkers = [];
    this.dynamicConnectionTubes = [];
    this.mainArtistBeacon = null;
  }

  register(node, material, baseOpacity, isUniform = false) {
    node.fadeTargets = node.fadeTargets || [];
    node.fadeTargets.push({ material, baseOpacity, isUniform });
  }

  applyFade(node) {
    const fl = node.focusLevel ?? 1;
    node.fadeTargets?.forEach(({ material, baseOpacity, isUniform }) => {
      const v = baseOpacity * Math.min(1.0, fl);
      if (isUniform && material.uniforms?.uOpacity) material.uniforms.uOpacity.value = v;
      else material.opacity = v;
    });
    if (node.shaderMaterial?.uniforms?.uOpacity) {
      node.shaderMaterial.uniforms.uOpacity.value = Math.min(1, fl);
    }
    if (node.type === 'genre' && node.sphereMesh) {
      const vis = Boolean(node.meshGroup?.visible !== false);
      node.sphereMesh.visible = vis;
      node.sphereMesh.material.depthWrite = true;
      if (node.ring) node.ring.visible = vis;
    }
    if (node.light) node.light.intensity = SUN_LIGHT_INTENSITY * Math.max(0.45, Math.min(1.2, fl));
  }

  buildGenreSun(node) {
    const group = new THREE.Group();
    group.position.copy(node.position);

    // Solid cluster center: 3D central sphere with solar plasma shading
    const shaderMat = createSolarShaderMaterial(node.color, node.energy || 0.8);
    this.solarMaterials.push(shaderMat);
    const sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(node.baseRadius, 48, 48), shaderMat);
    sphereMesh.renderOrder = 0;
    sphereMesh.userData = { node };
    group.add(sphereMesh);

    const ring = createSolidOrbitLine(node.baseRadius * 1.42, node.color, 0.35, Math.PI / 2.2, Math.PI / 7.0);
    group.add(ring);
    this.register(node, ring.material, 0.35);

    node.light = new THREE.PointLight(node.color, SUN_LIGHT_INTENSITY * 1.25, (node.clusterRadius || 80) * 1.8, 1.1);
    group.add(node.light);

    node.meshGroup = group;
    node.sphereMesh = sphereMesh;
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
      const rawHash = Math.abs(parseInt(String(node.id).replace(/[^0-9a-z]/gi, '').slice(-6), 36) || (i * 137));
      const seed = (rawHash % 480) / 1000 + 0.005;
      node.artistIndex = i;
      node.seedFrac = seed;
      node.roleCode = 0;
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
    this.artistDimMesh = null;
    this.artistNodes = artistNodes;
    this.artistInfo = geometry.getAttribute('aInfo');
    this.artistDecor = decor;
    this.scene.add(mesh, decor);
  }

  updateArtistInstances(hoveredNode = null) {
    if (!this.artistMesh) return;
    const m = this._am || (this._am = new THREE.Matrix4());
    const q = this._aq || (this._aq = new THREE.Quaternion());
    const sc = this._as || (this._as = new THREE.Vector3());
    for (const node of this.artistNodes) {
      const h = node.meshGroup;
      const isHovered = Boolean(hoveredNode && hoveredNode.id === node.id);
      const scaleVal = node.lensScale ?? 1;
      const activeVisible = Boolean(h.visible) && (scaleVal > 0.01) && ((node.focusTarget ?? 1) > 0.05 || isHovered);
      const isLit = (node.focusTarget ?? 1) >= 0.65 || isHovered;
      const baseR = node.baseRadius;
      const r = activeVisible ? baseR * scaleVal : 0;
      sc.copy(h.scale).multiplyScalar(r);
      m.compose(h.position, q, sc);
      this.artistMesh.setMatrixAt(node.artistIndex, m);

      const showDecor = activeVisible && isLit;
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

  buildTrackSatellites(trackNodes) {
    const n = Math.max(1, trackNodes.length);
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    const moonInfo = new Float32Array(n * 3);

    const mesh = new THREE.InstancedMesh(geometry, createMoonCrystalMaterial(), n);
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
    this.trackDimMesh = null;
    this.trackNodes = trackNodes;
    this.trackInfo = geometry.getAttribute('aMoonInfo');
    this.scene.add(mesh);
    return mesh;
  }

  updateTrackInstances(hoveredNode = null) {
    if (!this.trackMesh) return;
    const m = this._m || (this._m = new THREE.Matrix4());
    const q = this._q || (this._q = new THREE.Quaternion());
    const euler = this._e || (this._e = new THREE.Euler());
    const sc = this._s || (this._s = new THREE.Vector3());
    const spin = performance.now() * 0.0012;

    for (const node of this.trackNodes) {
      const h = node.meshGroup;
      const isHovered = Boolean(hoveredNode && hoveredNode.id === node.id);
      const scaleVal = node.lensScale ?? 1;
      const activeVisible = Boolean(h.visible) && (scaleVal > 0.01) && ((node.focusTarget ?? 1) > 0.05 || isHovered);
      const isLit = (node.focusTarget ?? 1) >= 0.65 || isHovered;
      const baseR = node.baseRadius;
      const r = activeVisible ? baseR * scaleVal : 0;
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

  rebuildFocusHighlights(activeNode, artistTracks = [], collabArtists = []) {
    this.clearFocusHighlights();
    if (!activeNode) return;

    if (activeNode.type === 'artist') {
      const baseColor = activeNode.color || STARLIGHT_HEX;

      const beacon = new THREE.Group();
      const primaryRing = createSolidOrbitLine(activeNode.baseRadius * 1.65, STARLIGHT_HEX, 0.72, Math.PI / 2.1, 0.2);
      beacon.add(primaryRing);

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

      const collabById = new Map();
      collabArtists.forEach(cNode => {
        collabById.set(cNode.id, cNode);
        const marker = new THREE.Group();
        const r = Math.max(1.5, cNode.baseRadius * 1.15);
        const dashedRing = createDashedOrbitLoop(r * 1.55, cNode.color || baseColor, 0.38, Math.PI / 2.2, Math.PI / 6);
        marker.add(dashedRing);
        this.focusHighlightGroup.add(marker);
        this.dynamicCollabMarkers.push({ group: marker, node: cNode });
      });

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
            this.addConnectionTube(tNode, cNode, lineColor, 0.032, 0.35);
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
        const r = Math.max(1.5, cNode.baseRadius * (isPrimary ? 1.32 : 1.15));
        const ring = isPrimary
          ? createSolidOrbitLine(r * 1.55, STARLIGHT_HEX, 0.82, Math.PI / 2.2, Math.PI / 6)
          : createDashedOrbitLoop(r * 1.55, cNode.color || songColor, 0.38, Math.PI / 2.2, Math.PI / 6);
        marker.add(ring);
        this.focusHighlightGroup.add(marker);
        this.dynamicCollabMarkers.push({ group: marker, node: cNode });

        this.addConnectionTube(
          activeNode,
          cNode,
          songColor,
          isPrimary ? 0.085 : 0.032,
          isPrimary ? 0.78 : 0.35
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
      obj.geometry?.dispose();
      obj.material?.dispose();
    });
    if (this.artistDecor) {
      this.scene.remove(this.artistDecor);
      this.artistDecor.children.forEach(d => { d.geometry?.dispose(); d.material.dispose(); });
    }
    this.trackMesh = this.trackDimMesh = this.artistMesh = this.artistDimMesh = this.edgeLines = this.pulseMesh = this.artistDecor = null;
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
      blending: THREE.NormalBlending,
      depthWrite: false
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.renderOrder = -1;
    this.edgeLines = lines;

    const collabEdges = edges.filter(e => e.type === 'track_collab');
    const trackEdges = edges.filter(e => e.type === 'track_artist');
    const pulseEdges = [...collabEdges, ...trackEdges].slice(0, MAX_PULSES);

    const pulseMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.28, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
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
      const hidden =
        !e.source.meshGroup?.visible ||
        !e.target.meshGroup?.visible ||
        e.level < 0.015 ||
        (e.source.lensScale ?? 1) <= 0.01 ||
        (e.target.lensScale ?? 1) <= 0.01 ||
        (e.source.focusTarget ?? 1) < 0.65 ||
        (e.target.focusTarget ?? 1) < 0.65;
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
      if (
        p.edge.level > 0.45 &&
        (p.edge.source.lensScale ?? 1) > 0.01 &&
        (p.edge.target.lensScale ?? 1) > 0.01 &&
        (p.edge.source.focusTarget ?? 1) >= 0.65 &&
        (p.edge.target.focusTarget ?? 1) >= 0.65 &&
        p.edge.source.meshGroup?.visible &&
        p.edge.target.meshGroup?.visible
      ) {
        s = p.edge.type === 'track_collab' ? 0.65 : 0.75;
      }
      m.makeScale(s, s, s).setPosition(v);
      this.pulseMesh.setMatrixAt(i, m);
    });
    this.pulseMesh.instanceMatrix.needsUpdate = true;
  }

  updateFocus(activeNode, nodes, edges, activeLens = 'all', hoveredNode = null) {
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
            if (n.featArtistId && n.featArtistId !== activeNode.id) collabArtistIds.add(n.featArtistId);
          }
        });

        nodes.forEach(n => {
          let target = DIM_PLANET_FOCUS;
          let scale = 0.55;
          let roleCode = 0;

          if (n.id === activeNode.id) {
            target = 1.35;
            scale = 1.38;
            roleCode = 1;
          } else if (artistTrackIds.has(n.id)) {
            const isCollabSong = activeNode.collabTrackIds?.has(n.id) || (n.featArtistIds?.length > 0);
            target = 1.25;
            scale = isCollabSong ? 1.55 : 1.42;
          } else if (collabArtistIds.has(n.id)) {
            target = 0.98;
            scale = 1.05;
            roleCode = 2;
            collabArtistNodes.push(n);
          } else if (n.type === 'genre') {
            target = DIM_SUN_FOCUS;
            scale = 0.85;
          } else if (n.type === 'track') {
            target = 0.0;
            scale = 0.0;
          }

          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = roleCode;
          if (target >= 0.65 || target === 0.0) n.focusLevel = target;
        });

        this.rebuildFocusHighlights(activeNode, artistTrackNodes, collabArtistNodes);

        edges.forEach(e => {
          const sId = e.source.id;
          const tId = e.target.id;
          const touchesSelectedArtist = sId === activeNode.id || tId === activeNode.id;
          const touchesArtistTrack = artistTrackIds.has(sId) || artistTrackIds.has(tId);
          const touchesCollabArtist = collabArtistIds.has(sId) || collabArtistIds.has(tId);

          if (touchesArtistTrack && touchesCollabArtist) {
            e.focusTarget = 0.82;
          } else if (touchesSelectedArtist && touchesArtistTrack) {
            e.focusTarget = 0.95;
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
          let target = DIM_PLANET_FOCUS;
          let scale = 0.55;
          let roleCode = 0;
          if (n.id === activeNode.id) {
            target = 1.35;
            scale = 1.95;
          } else if (involvedArtistIds.has(n.id)) {
            const isPrimary = n.id === activeNode.artistId;
            target = isPrimary ? 1.3 : 0.98;
            scale = isPrimary ? 1.35 : 1.05;
            roleCode = isPrimary ? 1 : 2;
            involvedArtistNodes.push(n);
          } else if (n.type === 'genre') {
            target = DIM_SUN_FOCUS;
            scale = 0.85;
          } else if (n.type === 'track') {
            target = 0.0;
            scale = 0.0;
          }
          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = roleCode;
          if (target >= 0.65 || target === 0.0) n.focusLevel = target;
        });

        this.rebuildFocusHighlights(activeNode, [activeNode], involvedArtistNodes);

        edges.forEach(e => {
          const touchesSong = e.source.id === activeNode.id || e.target.id === activeNode.id;
          e.focusTarget = touchesSong ? 0.9 : 0.0;
        });
      } else if (activeNode?.type === 'genre') {
        this.clearFocusHighlights();
        const inClusterSet = new Set([activeNode.id]);
        activeNode.neighbors?.forEach(id => inClusterSet.add(id));
        nodes.forEach(n => {
          if (n.type === 'artist' && n.genres?.includes(activeNode.id)) {
            inClusterSet.add(n.id);
            // Only add tracks whose primary artist is in this cluster so we don't pull in foreign cluster tracks
            n.neighbors?.forEach(id => {
              const child = this.trackNodes?.find(t => t.id === id);
              if (child && child.artistId === n.id) inClusterSet.add(id);
            });
          }
        });

        nodes.forEach(n => {
          const inCluster = inClusterSet.has(n.id);
          let target = 0.0;
          let scale = 0.0;
          let roleCode = 0;

          if (n.id === activeNode.id) {
            target = 1.0;
            scale = 1.0;
          } else if (inCluster) {
            if (!hasLens) {
              target = 1.22;
              scale = n.type === 'track' ? 1.25 : 1.12;
              roleCode = n.type === 'artist' ? 1 : 0;
            } else {
              const directMatch = lensMatch.has(n.id);
              const parentOfMatch = n.type === 'artist' && lensArtistHasMatchTrack.has(n.id);
              if (directMatch || parentOfMatch) {
                target = directMatch ? 1.32 : 1.12;
                scale = n.type === 'track' ? 1.5 : (directMatch ? 1.25 : 1.05);
                roleCode = directMatch && n.type === 'artist' ? 1 : (parentOfMatch ? 2 : 0);
              } else {
                // Strictly cull non-matching artists & songs when a lens is active inside a cluster
                target = 0.0;
                scale = 0.0;
              }
            }
          } else {
            if (n.type === 'genre') {
              target = DIM_SUN_FOCUS;
              scale = 0.85;
            } else if (n.type === 'artist' && !hasLens) {
              target = DIM_PLANET_FOCUS;
              scale = 0.5;
            } else {
              target = 0.0;
              scale = 0.0;
            }
          }

          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = roleCode;
          if (target >= 0.65 || target === 0.0) n.focusLevel = target;
        });

        edges.forEach(e => {
          const bothLit = (e.source.focusTarget ?? 0) >= 0.65 && (e.target.focusTarget ?? 0) >= 0.65;
          const bothInCluster = inClusterSet.has(e.source.id) && inClusterSet.has(e.target.id);
          e.focusTarget = (bothInCluster && bothLit) ? e.style.focused : 0.0;
        });
      } else {
        this.clearFocusHighlights();
        nodes.forEach(n => {
          let target = 1.0;
          let scale = 1.0;
          let roleCode = 0;
          if (hasLens) {
            if (n.type === 'genre') {
              const hasMatch = lensClusterHasMatch.has(n.id);
              target = hasMatch ? 1.05 : DIM_SUN_FOCUS;
              scale = hasMatch ? 1.15 : 0.88;
            } else if (lensMatch.has(n.id)) {
              target = 1.32;
              scale = n.type === 'track' ? 1.55 : 1.28;
              roleCode = n.type === 'artist' ? 1 : 0;
            } else if (n.type === 'artist' && lensArtistHasMatchTrack.has(n.id)) {
              target = 1.12;
              scale = 1.08;
              roleCode = 2;
            } else {
              target = 0.0;
              scale = 0.0;
            }
          }
          n.focusTarget = target;
          n.lensScale = scale;
          n.roleCode = roleCode;
          if (target >= 0.65 || target === 0.0) n.focusLevel = target;
        });

        edges.forEach(e => {
          if (!hasLens) {
            e.focusTarget = e.style.opacity;
          } else {
            const bothLit = (e.source.focusTarget ?? 0) >= 0.65 && (e.target.focusTarget ?? 0) >= 0.65;
            const atLeastOneDirectMatch = lensMatch.has(e.source.id) || lensMatch.has(e.target.id);
            e.focusTarget = (bothLit && atLeastOneDirectMatch) ? Math.min(0.75, e.style.opacity * 2.0) : 0.0;
          }
        });
      }

      // Hard invariant: NEVER allow any edge to stay lit if either of its endpoints is dimmed (< 0.65)
      for (const e of edges) {
        if ((e.source.focusTarget ?? 1) < 0.65 || (e.target.focusTarget ?? 1) < 0.65) {
          e.focusTarget = 0.0;
          e.level = 0.0;
        }
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
      const isHovered = Boolean(hoveredNode && hoveredNode.id === n.id);
      const target = isHovered ? Math.max(1.3, n.focusTarget ?? 1) : (n.focusTarget ?? 1);
      if (Math.abs(n.focusLevel - target) < 0.003) continue;
      n.focusLevel = isHovered ? target : (n.focusLevel + (target - n.focusLevel) * FOCUS_LERP);
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

  updateSolarShaders(time) {
    for (let i = 0; i < this.solarMaterials.length; i++) {
      this.solarMaterials[i].uniforms.uTime.value = time;
    }
  }
}
