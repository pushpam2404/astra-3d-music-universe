// src/physics/galaxyLayout.js
/**
 * Deterministic galaxy layout (replaces the old spring/repulsion simulation, which
 * never settled and let clusters bleed into each other).
 *
 *  - Suns (clusters) sit on a ring, ordered so that related clusters are neighbours
 *    (greedy seriation on cluster affinity). The ring radius is solved so neighbouring
 *    cluster discs never overlap.
 *  - Each cluster's artists form a phyllotaxis (sunflower) disc around its sun, most
 *    listened closest. The disc rotates rigidly, so planets never collide.
 *  - Bridge artists (strong ties to two clusters) sit in the gap between both suns.
 *  - Tracks orbit their artist as moons on inclined orbits.
 *
 * Positions are a pure function of (layout, time): nothing drifts or explodes.
 */
import * as THREE from 'three';
import { LAYOUT_CONFIG } from '../config/constants.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

const centerKey = (c) => (c ? `${c.x},${c.y},${c.z}` : '0,0,0');

/** Orders suns so that consecutive ones have high affinity. */
function seriate(suns, affinity) {
  if (suns.length <= 2) return suns.slice();
  const remaining = suns.slice().sort((a, b) => b.plays - a.plays);
  const order = [remaining.shift()];
  while (remaining.length) {
    const last = order[order.length - 1];
    let bestIdx = 0;
    let best = -1;
    remaining.forEach((s, i) => {
      const a = affinity(last, s);
      if (a > best + 1e-9) { best = a; bestIdx = i; }
    });
    order.push(remaining.splice(bestIdx, 1)[0]);
  }
  return order;
}

/** Ring radius at which consecutive chord lengths `d` exactly close the circle. */
function solveRingRadius(d) {
  if (d.length === 1) return 0;
  if (d.length === 2) return Math.max(d[0], d[1]) / 2;
  const total = (R) => d.reduce((s, di) => s + 2 * Math.asin(Math.min(1, di / (2 * R))), 0);
  let lo = Math.max(...d) / 2;
  let hi = d.reduce((s, x) => s + x, 0);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) > Math.PI * 2) lo = mid; else hi = mid;
  }
  return hi;
}

export class GalaxyLayoutEngine {
  constructor() {
    this.orbitMultiplier = 1.0;
    this.nodeScaleMultiplier = 1.0;
    this.layoutMode = 'force'; // 'force' (galaxy) | 'rings'
    this.time = 0;
    this.boundingRadius = 200;
    this._tmp = new THREE.Vector3();
  }

  initializeNodePositions(nodes) {
    const C = LAYOUT_CONFIG;
    const suns = nodes.filter(n => n.type === 'genre');
    const artists = nodes.filter(n => n.type === 'artist');
    const tracks = nodes.filter(n => n.type === 'track');
    const sunById = new Map(suns.map(s => [s.id, s]));
    const artistById = new Map(artists.map(a => [a.id, a]));

    nodes.forEach(n => {
      n.position = n.position || new THREE.Vector3();
      n.velocity = n.velocity || new THREE.Vector3();
    });

    // Partition artists: disc members of their primary sun vs bridges.
    const discMembers = new Map(suns.map(s => [s.id, []]));
    const bridges = [];
    artists.forEach(a => {
      const ids = (a.genres || []).filter(id => sunById.has(id));
      a.primarySunId = ids[0] || suns[0]?.id;
      a.secondarySunId = ids[1] || null;
      if (a.secondarySunId) bridges.push(a);
      else if (a.primarySunId) discMembers.get(a.primarySunId).push(a);
    });

    // Cluster affinity: server-provided matrix, else shared bridge artists.
    const sharedCount = new Map();
    bridges.forEach(a => {
      const k = [a.primarySunId, a.secondarySunId].sort().join('|');
      sharedCount.set(k, (sharedCount.get(k) || 0) + 1);
    });
    const affinity = (s, t) => {
      if (s.affinity && t.id in s.affinity) return s.affinity[t.id];
      return sharedCount.get([s.id, t.id].sort().join('|')) || 0;
    };

    // Disc geometry per sun.
    suns.forEach(sun => {
      const members = discMembers.get(sun.id).sort((a, b) => b.plays - a.plays);
      const bridgeCount = bridges.filter(b => b.primarySunId === sun.id || b.secondarySunId === sun.id).length;
      const core = sun.baseRadius * C.sunCoreFactor + C.discInnerGap;
      sun.discCore = core;
      sun.clusterRadius = core + C.discSpacing * Math.sqrt(members.length + 0.5) + C.discMargin;
      sun.clusterSize = members.length + bridgeCount;
      sun.discTilt = (hash01(sun.id) - 0.5) * C.discTiltRange;
      sun.discSpin = (hash01(`${sun.id}:spin`) > 0.5 ? 1 : -1);
      members.forEach((a, k) => {
        a.labelRank = k;
        a.discRadius = core + C.discSpacing * Math.sqrt(k + 0.5);
        a.discAngle = k * GOLDEN_ANGLE;
        a.discHeight = (hash01(`${a.id}:h`) - 0.5) * C.discThickness;
        a.isBridge = false;
      });
    });

    // Place suns: one ring per galaxy center (collision mode has two galaxies + a bridge).
    const groups = new Map();
    suns.forEach(s => {
      const k = centerKey(s.galaxyCenter);
      if (!groups.has(k)) groups.set(k, { center: s.galaxyCenter || { x: 0, y: 0, z: 0 }, suns: [] });
      groups.get(k).suns.push(s);
    });

    let bounding = 0;
    groups.forEach(({ center, suns: groupSuns }) => {
      const order = seriate(groupSuns, affinity);
      const d = order.map((s, i) => s.clusterRadius + order[(i + 1) % order.length].clusterRadius + C.clusterGap);
      const R = solveRingRadius(d);
      let theta = 0;
      order.forEach((s, i) => {
        s.ringAngle = theta;
        s.anchor = new THREE.Vector3(
          center.x + Math.cos(theta) * R,
          center.y + (i % 2 ? 1 : -1) * C.sunHeightJitter,
          center.z + Math.sin(theta) * R
        );
        s.position.copy(s.anchor);
        if (order.length > 1) theta += 2 * Math.asin(Math.min(1, d[i] / (2 * R)));
        bounding = Math.max(bounding, Math.hypot(center.x, center.z) + R + s.clusterRadius);
      });
    });
    this.boundingRadius = Math.max(120, bounding);

    // Bridges: in the gap between their two suns, fanned out perpendicular to the link.
    const bridgeSlots = new Map();
    bridges.forEach(a => {
      const k = [a.primarySunId, a.secondarySunId].sort().join('|');
      if (!bridgeSlots.has(k)) bridgeSlots.set(k, []);
      bridgeSlots.get(k).push(a);
    });
    bridgeSlots.forEach(list => {
      list.sort((x, y) => y.plays - x.plays).forEach((a, i) => {
        const A = sunById.get(a.primarySunId);
        const B = sunById.get(a.secondarySunId);
        const dir = this._tmp.subVectors(B.anchor, A.anchor);
        const dist = dir.length() || 1;
        dir.divideScalar(dist);
        // Lean toward the sun the artist is closer to (bridgeWeight = pull of the secondary).
        const w = Math.min(0.5, a.bridgeWeight ?? 0.5);
        const along = THREE.MathUtils.lerp(A.clusterRadius + C.clusterGap * 0.5, dist - B.clusterRadius - C.clusterGap * 0.5, w * 2);
        const perp = new THREE.Vector3(-dir.z, 0, dir.x);
        const offset = (i - (list.length - 1) / 2) * C.bridgeSpacing;
        a.isBridge = true;
        a.labelRank = i;
        a.bridgeAnchor = A.anchor.clone()
          .addScaledVector(dir, Math.max(0, along))
          .addScaledVector(perp, offset)
          .add(new THREE.Vector3(0, (i % 2 ? 1 : -1) * C.bridgeSpacing * 0.35, 0));
      });
    });

    // Moons.
    const tracksByArtist = new Map();
    tracks.forEach(t => {
      if (!tracksByArtist.has(t.artistId)) tracksByArtist.set(t.artistId, []);
      tracksByArtist.get(t.artistId).push(t);
    });
    tracksByArtist.forEach((list, artistId) => {
      const parent = artistById.get(artistId);
      list.sort((x, y) => y.plays - x.plays).forEach((t, k) => {
        t.parentNode = parent || null;
        t.moonRadius = (parent?.baseRadius || 3) + C.moonInnerGap + k * C.moonSpacing;
        t.moonPhase = (k / list.length) * Math.PI * 2 + hash01(t.id) * 0.6;
        t.moonSpeed = C.moonSpeed / (1 + k * 0.18);
        t.moonInclination = (hash01(`${t.id}:inc`) - 0.5) * C.moonInclinationRange;
        t.moonNode = hash01(`${t.id}:node`) * Math.PI * 2;
      });
    });

    this.time = 0;
    this.applyPositions(nodes);
  }

  step(nodes, delta = 16) {
    this.time += (Math.min(delta, 64) / 1000) * Math.max(0, this.orbitMultiplier);
    if (this.layoutMode === 'rings') {
      this.stepConcentricRings(nodes);
      return;
    }
    this.applyPositions(nodes);
  }

  applyPositions(nodes) {
    const C = LAYOUT_CONFIG;
    const t = this.time;
    const scale = this.nodeScaleMultiplier;

    // Suns first, then artists (depend on suns), then tracks (depend on artists).
    for (const n of nodes) {
      if (n.type !== 'genre' || !n.anchor) continue;
      n.position.set(n.anchor.x, n.anchor.y + Math.sin(t * 0.4 + n.ringAngle * 3) * 1.2, n.anchor.z);
      if (n.meshGroup) n.meshGroup.position.copy(n.position);
    }

    for (const n of nodes) {
      if (n.type !== 'artist') continue;
      if (n.isBridge && n.bridgeAnchor) {
        n.position.copy(n.bridgeAnchor);
        n.position.y += Math.sin(t * 0.8 + n.labelRank) * 1.5;
      } else {
        const s = this._sunOf(n, nodes);
        if (!s) continue;
        const angle = n.discAngle + t * C.discSpinSpeed * s.discSpin;
        const r = n.discRadius * (0.85 + 0.15 * scale);
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        // Tilt the disc around the x axis.
        const cosT = Math.cos(s.discTilt), sinT = Math.sin(s.discTilt);
        n.position.set(
          s.position.x + x,
          s.position.y + n.discHeight + z * sinT,
          s.position.z + z * cosT
        );
      }
      if (n.meshGroup) n.meshGroup.position.copy(n.position);
    }

    for (const n of nodes) {
      if (n.type !== 'track' || !n.parentNode) continue;
      const p = n.parentNode.position;
      const a = n.moonPhase + t * n.moonSpeed;
      const r = n.moonRadius * scale;
      // Circle in the xz plane, inclined around x, then rotated around y by its node angle.
      const lx = Math.cos(a) * r;
      const lz0 = Math.sin(a) * r;
      const ly = lz0 * Math.sin(n.moonInclination);
      const lz = lz0 * Math.cos(n.moonInclination);
      const cn = Math.cos(n.moonNode), sn = Math.sin(n.moonNode);
      n.position.set(p.x + lx * cn - lz * sn, p.y + ly, p.z + lx * sn + lz * cn);
      if (n.meshGroup) n.meshGroup.position.copy(n.position);
    }
  }

  _sunOf(artist, nodes) {
    if (artist._sun && artist._sun.id === artist.primarySunId) return artist._sun;
    artist._sun = nodes.find(n => n.id === artist.primarySunId) || null;
    return artist._sun;
  }

  stepConcentricRings(nodes) {
    // Ordered shells: suns inner, artists middle, tracks outer.
    const t = this.time * 0.35;
    const tiers = { genre: [], artist: [], track: [] };
    nodes.forEach(n => tiers[n.type]?.push(n));
    const shells = { genre: [70, 0.4, 0], artist: [150, 0.7, 8], track: [225, 1.1, 12] };
    Object.entries(tiers).forEach(([type, list]) => {
      const [radius, speed, wobble] = shells[type];
      list.forEach((n, idx) => {
        const angle = (idx / Math.max(1, list.length)) * Math.PI * 2 + t * speed;
        n.position.set(Math.cos(angle) * radius, Math.sin(angle * 2) * wobble, Math.sin(angle) * radius);
        if (n.meshGroup) n.meshGroup.position.copy(n.position);
      });
    });
  }

  updateEdgeLines(edges) {
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (!edge.lineMesh) continue;
      const positions = edge.lineMesh.geometry.attributes.position.array;
      const s = edge.source.position, d = edge.target.position;
      positions[0] = s.x; positions[1] = s.y; positions[2] = s.z;
      positions[3] = d.x; positions[4] = d.y; positions[5] = d.z;
      edge.lineMesh.geometry.attributes.position.needsUpdate = true;
    }
  }

  updateSynapticPulses(pulseParticles, orbitSpeed) {
    const speedScale = Math.max(0.2, orbitSpeed);
    for (let i = 0; i < pulseParticles.length; i++) {
      const p = pulseParticles[i];
      p.progress = (p.progress + p.speed * speedScale) % 1.0;
      p.mesh.position.lerpVectors(p.edge.source.position, p.edge.target.position, p.progress);
    }
  }
}
