// src/physics/galaxyLayout.js
/**
 * Deterministic 3D "embedding cloud" layout, like a vector-database visualization:
 *
 *  - Each cluster is a 3D cloud of artists around its sun; the most-listened artists
 *    sit near the center, the long tail toward the edge (radius ∝ cube root of rank,
 *    so density stays even through the volume).
 *  - Cluster centers sit on a sphere, ordered so related clusters are neighbours
 *    (greedy seriation on affinity, laid along a Fibonacci spiral). The sphere's radius
 *    is solved so neighbouring clouds just touch: one globe, no overlaps.
 *  - Bridge artists (strong ties to two clusters) float between both clouds.
 *  - Tracks orbit their artist as moons on inclined orbits.
 *
 * Artist positions are static; only moons move (the camera slowly orbits instead).
 */
import * as THREE from 'three';
import { LAYOUT_CONFIG } from '../config/constants.js';

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/** Evenly spread unit vectors; consecutive indices are spatial neighbours. */
function fibonacciSphere(i, n) {
  if (n === 1) return new THREE.Vector3(0, 0, 0);
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const theta = Math.PI * (3 - Math.sqrt(5)) * i;
  return new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
}

/** Deterministic, uniformly distributed direction for an id. */
function directionFor(id) {
  const u = hash01(`${id}:u`) * 2 - 1;
  const phi = hash01(`${id}:phi`) * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return new THREE.Vector3(r * Math.cos(phi), u, r * Math.sin(phi));
}

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

export class GalaxyLayoutEngine {
  constructor() {
    this.orbitMultiplier = 1.0;
    this.nodeScaleMultiplier = 1.0;
    this.time = 0;
    this.boundingRadius = 200;
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

    // Moon systems first: an artist with many tracks needs more room in its cloud.
    const tracksByArtist = new Map();
    tracks.forEach(t => {
      if (!tracksByArtist.has(t.artistId)) tracksByArtist.set(t.artistId, []);
      tracksByArtist.get(t.artistId).push(t);
    });
    artists.forEach(a => {
      const count = tracksByArtist.get(a.id)?.length || 0;
      a.systemRadius = a.baseRadius + C.moonInnerGap + (count ? C.moonSpacing * Math.sqrt(count) * 1.6 : 0);
    });

    // Partition artists: cloud members of their primary sun vs bridges.
    const members = new Map(suns.map(s => [s.id, []]));
    const bridges = [];
    artists.forEach(a => {
      const ids = (a.genres || []).filter(id => sunById.has(id));
      a.primarySunId = ids[0] || suns[0]?.id;
      a.secondarySunId = ids[1] || null;
      if (a.secondarySunId) bridges.push(a);
      else if (a.primarySunId) members.get(a.primarySunId).push(a);
    });

    // Cloud geometry per sun: offsets relative to the sun, ranked by plays.
    suns.forEach(sun => {
      const list = members.get(sun.id).sort((a, b) => b.plays - a.plays);
      const meanSystem = list.length ? list.reduce((s, a) => s + a.systemRadius, 0) / list.length : 0;
      const spacing = Math.max(C.cloudSpacing, meanSystem * 1.5);
      const core = sun.baseRadius * C.sunCoreFactor + C.cloudInnerGap;
      sun.clusterRadius = core + spacing * Math.cbrt(list.length + 1) * C.cloudDensity;
      list.forEach((a, k) => {
        const t = (k + 0.5) / list.length;
        const r = core + (sun.clusterRadius - core) * Math.cbrt(t);
        a.labelRank = k;
        a.isBridge = false;
        a.cloudOffset = directionFor(a.id).multiplyScalar(r);
      });
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

    // Cluster centers on a sphere; radius solved so no two clouds overlap.
    const order = seriate(suns, affinity);
    const dirs = order.map((_, i) => fibonacciSphere(i, order.length));
    let R = 0;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const unitDist = dirs[i].distanceTo(dirs[j]);
        R = Math.max(R, (order[i].clusterRadius + order[j].clusterRadius + C.clusterGap) / unitDist);
      }
    }
    let bounding = 0;
    order.forEach((s, i) => {
      s.anchor = dirs[i].clone().multiplyScalar(R);
      s.position.copy(s.anchor);
      bounding = Math.max(bounding, R + s.clusterRadius);
    });
    this.boundingRadius = Math.max(80, bounding);

    // Bridges: between their two suns, nearer the one they belong to more, fanned out
    // around the link so several bridges between the same pair don't stack.
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
        const dir = new THREE.Vector3().subVectors(B.anchor, A.anchor);
        const dist = dir.length() || 1;
        dir.divideScalar(dist);
        const w = Math.min(0.5, a.bridgeWeight ?? 0.5);
        const along = THREE.MathUtils.lerp(A.clusterRadius * 0.8, dist - B.clusterRadius * 0.8, w * 2);
        const perpA = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
        const perpB = new THREE.Vector3().crossVectors(dir, perpA);
        const ring = C.bridgeSpacing * Math.sqrt(i);
        const angle = i * 2.399963;
        a.isBridge = true;
        a.labelRank = i;
        a.bridgeAnchor = A.anchor.clone()
          .addScaledVector(dir, Math.max(0, along))
          .addScaledVector(perpA, Math.cos(angle) * ring)
          .addScaledVector(perpB, Math.sin(angle) * ring);
      });
    });

    // Moons: sqrt spacing keeps big moon systems compact.
    tracksByArtist.forEach((list, artistId) => {
      const parent = artistById.get(artistId);
      list.sort((x, y) => y.plays - x.plays).forEach((t, k) => {
        t.parentNode = parent || null;
        t.moonRadius = (parent?.baseRadius || 3) + C.moonInnerGap + C.moonSpacing * Math.sqrt(k) * 1.6;
        t.moonPhase = (k / list.length) * Math.PI * 2 + hash01(t.id) * 0.6;
        t.moonSpeed = C.moonSpeed / (1 + Math.sqrt(k) * 0.35);
        t.moonInclination = (hash01(`${t.id}:inc`) - 0.5) * C.moonInclinationRange;
        t.moonNode = hash01(`${t.id}:node`) * Math.PI * 2;
      });
    });

    this.time = 0;
    this.applyPositions(nodes);
  }

  step(nodes, delta = 16) {
    this.time += (Math.min(delta, 64) / 1000) * Math.max(0, this.orbitMultiplier);
    this.applyPositions(nodes);
  }

  applyPositions(nodes) {
    const t = this.time;
    const scale = this.nodeScaleMultiplier;

    // Suns first, then artists (depend on suns), then tracks (depend on artists).
    for (const n of nodes) {
      if (n.type !== 'genre' || !n.anchor) continue;
      n.position.copy(n.anchor);
      if (n.meshGroup) n.meshGroup.position.copy(n.position);
    }

    for (const n of nodes) {
      if (n.type !== 'artist') continue;
      if (n.isBridge && n.bridgeAnchor) {
        n.position.copy(n.bridgeAnchor);
      } else {
        const s = this._sunOf(n, nodes);
        if (!s || !n.cloudOffset) continue;
        // Gentle breathing so the cloud feels alive without anything drifting off.
        const breathe = 1 + Math.sin(t * 0.5 + n.labelRank * 0.7) * 0.012;
        n.position.copy(s.position).addScaledVector(n.cloudOffset, (0.85 + 0.15 * scale) * breathe);
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
}
