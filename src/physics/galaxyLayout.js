// src/physics/galaxyLayout.js
/**
 * 3D layout where distance means similarity AND clusters sit at a balanced, breathable
 * distance from one another (never overlapping into a cluttered blob, and never flung
 * into distant corners):
 *
 *  - Cluster centers sit on an affinity-seriated, radius-relaxed sphere (`sun.anchor`),
 *    with a compact ~50% tighter inter-cluster distance (`(r_i + r_j) * 0.72 + 4` separation).
 *  - Inside each cluster, artists are placed using their server UMAP similarity
 *    direction (`artist.embed`) blended with cube-root rank radius so top artists sit
 *    near the sun, musically similar artists sit together, and every cluster keeps a
 *    clean spherical boundary.
 *  - Bridge artists (strong ties to two clusters) float in the channel between both clouds.
 *  - Tracks orbit their artist as moons on inclined orbits.
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

/**
 * Relaxes unit vectors on the sphere so larger clusters naturally get wider angular
 * separation from their neighbours instead of crowding smaller clusters.
 */
function relaxSphereDirections(dirs, radii) {
  if (dirs.length <= 2) return dirs;
  const out = dirs.map(d => d.clone());
  const push = new THREE.Vector3();
  const diff = new THREE.Vector3();
  for (let iter = 0; iter < 18; iter++) {
    for (let i = 0; i < out.length; i++) {
      push.set(0, 0, 0);
      for (let j = 0; j < out.length; j++) {
        if (i === j) continue;
        diff.subVectors(out[i], out[j]);
        const d = Math.max(0.15, diff.length());
        const weight = (radii[i] + radii[j]) / 100;
        push.addScaledVector(diff.normalize(), (weight / (d * d)) * 0.045);
      }
      out[i].add(push).normalize();
    }
  }
  return out;
}

export class GalaxyLayoutEngine {
  constructor() {
    this.orbitMultiplier = 1.0;
    this.nodeScaleMultiplier = 1.0;
    this.clusterSpreadMultiplier = 1.0;
    this.time = 0;
    this.boundingRadius = 140;
    this.mode = 'clusters';
    this.hasSimilarity = false;
    this.bounds = { clusters: 140, similarity: 140 };
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

    const tracksByArtist = new Map();
    tracks.forEach(t => {
      if (!tracksByArtist.has(t.artistId)) tracksByArtist.set(t.artistId, []);
      tracksByArtist.get(t.artistId).push(t);
    });
    artists.forEach(a => {
      const count = Math.min(12, tracksByArtist.get(a.id)?.length || 0);
      a.systemRadius = a.baseRadius + C.moonInnerGap + (count ? C.moonSpacing * Math.sqrt(count) * 1.05 : 0);
    });

    artists.slice().sort((a, b) => b.plays - a.plays).forEach((a, i) => { a.globalRank = i; });

    const members = new Map(suns.map(s => [s.id, []]));
    const bridges = [];
    artists.forEach(a => {
      const ids = (a.genres || []).filter(id => sunById.has(id));
      a.primarySunId = ids[0] || suns[0]?.id;
      a.secondarySunId = ids[1] || null;
      if (a.secondarySunId) bridges.push(a);
      else if (a.primarySunId) members.get(a.primarySunId).push(a);
    });

    // Cloud geometry per sun: compact, well-contained 3D clouds around each sun.
    suns.forEach(sun => {
      const list = members.get(sun.id).sort((a, b) => b.plays - a.plays);
      const meanSystem = list.length ? list.reduce((s, a) => s + a.systemRadius, 0) / list.length : 0;
      const spacing = Math.max(4.2, meanSystem * 0.72);
      const core = sun.baseRadius * C.sunCoreFactor + C.cloudInnerGap;
      sun.clusterRadius = core + spacing * Math.cbrt(list.length + 1) * 0.54;
      list.forEach((a, k) => {
        const t = (k + 0.5) / list.length;
        const r = core + (sun.clusterRadius - core) * Math.cbrt(t);
        a.labelRank = k;
        a.isBridge = false;
        a.cloudRadiusTarget = r;
        a.cloudOffset = directionFor(a.id).multiplyScalar(r);
      });
    });

    const sharedCount = new Map();
    bridges.forEach(a => {
      const k = [a.primarySunId, a.secondarySunId].sort().join('|');
      sharedCount.set(k, (sharedCount.get(k) || 0) + 1);
    });
    const affinity = (s, t) => {
      if (s.affinity && t.id in s.affinity) return s.affinity[t.id];
      return sharedCount.get([s.id, t.id].sort().join('|')) || 0;
    };

    // Cluster centers on a radius-relaxed Fibonacci sphere, ~50% closer together.
    const order = seriate(suns, affinity);
    const initialDirs = order.map((_, i) => fibonacciSphere(i, order.length));
    const dirs = relaxSphereDirections(initialDirs, order.map(s => s.clusterRadius));

    let R = 0;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const unitDist = dirs[i].distanceTo(dirs[j]);
        const ri = order[i].clusterRadius;
        const rj = order[j].clusterRadius;
        const minCenterDist = (ri + rj) * 0.72 + 4.0;
        R = Math.max(R, minCenterDist / unitDist);
      }
    }
    let bounding = 0;
    order.forEach((s, i) => {
      s.anchor = dirs[i].clone().multiplyScalar(R);
      s.position.copy(s.anchor);
      bounding = Math.max(bounding, R + s.clusterRadius * 0.9);
    });
    this.bounds.clusters = Math.max(85, bounding);

    // Bridges sit in the channel between their two suns.
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
        const along = THREE.MathUtils.lerp(A.clusterRadius * 0.85, dist - B.clusterRadius * 0.85, 0.25 + w);
        const perpA = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
        const perpB = new THREE.Vector3().crossVectors(dir, perpA);
        const ring = C.bridgeSpacing * Math.sqrt(i);
        const angle = i * 2.399963;
        a.isBridge = true;
        a.labelRank = i;
        a.bridgeOffsetFromMid = new THREE.Vector3()
          .addScaledVector(perpA, Math.cos(angle) * ring)
          .addScaledVector(perpB, Math.sin(angle) * ring);
        a.bridgeLerp = Math.max(0.15, Math.min(0.85, along / dist));
        a.bridgeAnchor = A.anchor.clone()
          .addScaledVector(dir, Math.max(0, along))
          .add(a.bridgeOffsetFromMid);
      });
    });

    tracksByArtist.forEach((list, artistId) => {
      const parent = artistById.get(artistId);
      list.sort((x, y) => y.plays - x.plays).forEach((t, k) => {
        t.parentNode = parent || null;
        t.moonRadius = (parent?.baseRadius || 3) + C.moonInnerGap + C.moonSpacing * Math.sqrt(k) * 1.35;
        t.moonPhase = (k / list.length) * Math.PI * 2 + hash01(t.id) * 0.6;
        t.moonSpeed = C.moonSpeed / (1 + Math.sqrt(k) * 0.35);
        t.moonInclination = (hash01(`${t.id}:inc`) - 0.5) * C.moonInclinationRange;
        t.moonNode = hash01(`${t.id}:node`) * Math.PI * 2;
      });
    });

    suns.forEach(sun => {
      sun.layoutPos = { clusters: sun.anchor.clone() };
      sun.layoutRadius = { clusters: sun.clusterRadius };
    });
    artists.forEach(a => {
      const sun = sunById.get(a.primarySunId);
      const p = a.isBridge && a.bridgeAnchor ? a.bridgeAnchor.clone()
        : (sun && a.cloudOffset ? sun.anchor.clone().add(a.cloudOffset) : new THREE.Vector3());
      a.layoutPos = { clusters: p };
      a.localClusterOffset = a.cloudOffset ? a.cloudOffset.clone() : new THREE.Vector3();
    });

    this.computeSimilarityPositions(suns, artists, sunById, members);
    this.mode = this.hasSimilarity ? 'similarity' : 'clusters';
    this.boundingRadius = this.bounds[this.mode] * this.clusterSpreadMultiplier;

    this.time = 0;
    this.applyPositions(nodes);
  }

  computeSimilarityPositions(suns, artists, sunById, members) {
    const withEmbed = artists.filter(a => Array.isArray(a.embed) && a.embed.length === 3);
    this.hasSimilarity = artists.length >= 8 && withEmbed.length >= artists.length * 0.9;
    if (!this.hasSimilarity) return;

    const umapCenter = new Map();
    suns.forEach(sun => {
      const list = (members.get(sun.id) || []).filter(a => Array.isArray(a.embed));
      if (!list.length) {
        umapCenter.set(sun.id, new THREE.Vector3());
        return;
      }
      const c = new THREE.Vector3();
      list.forEach(a => c.add(new THREE.Vector3(...a.embed)));
      c.divideScalar(list.length);
      umapCenter.set(sun.id, c);
    });

    suns.forEach(sun => {
      sun.layoutPos.similarity = sun.anchor.clone();
      sun.layoutRadius.similarity = sun.clusterRadius;

      const list = members.get(sun.id) || [];
      if (!list.length) return;
      const center = umapCenter.get(sun.id) || new THREE.Vector3();
      const offsets = list.map(a => {
        if (!Array.isArray(a.embed)) return directionFor(a.id);
        const off = new THREE.Vector3(...a.embed).sub(center);
        return off.lengthSq() > 1e-6 ? off : directionFor(a.id);
      });
      const lengths = offsets.map(o => o.length()).sort((a, b) => a - b);
      const p85 = lengths[Math.floor(lengths.length * 0.85)] || 1;

      list.forEach((a, idx) => {
        const off = offsets[idx];
        const dir = off.clone().normalize().addScaledVector(directionFor(a.id), 0.28).normalize();
        const normUmapR = Math.min(0.95, off.length() / p85);
        const rankR = a.cloudRadiusTarget || (sun.clusterRadius * 0.6);
        const r = THREE.MathUtils.lerp(rankR, sun.clusterRadius * (0.18 + 0.78 * normUmapR), 0.35);
        a.localClusterOffset = dir.clone().multiplyScalar(r);
        a.layoutPos.similarity = sun.anchor.clone().add(a.localClusterOffset);
      });
    });

    artists.forEach(a => {
      if (a.isBridge && a.bridgeAnchor) {
        a.layoutPos.similarity = a.bridgeAnchor.clone();
      } else if (!a.layoutPos.similarity) {
        const sun = sunById.get(a.primarySunId);
        a.layoutPos.similarity = (sun?.anchor || new THREE.Vector3()).clone().add(a.cloudOffset || new THREE.Vector3());
      }
    });

    this.bounds.similarity = this.bounds.clusters;
  }

  step(nodes, delta = 16) {
    this.time += (Math.min(delta, 64) / 1000) * Math.max(0, this.orbitMultiplier);
    this.applyPositions(nodes);
  }

  applyPositions(nodes) {
    const t = this.time;
    const scale = this.nodeScaleMultiplier;
    const spread = this.clusterSpreadMultiplier || 1.0;
    const mode = this.mode;

    for (const n of nodes) {
      if (n.type !== 'genre' || !n.layoutPos) continue;
      const baseAnchor = n.layoutPos[mode] || n.layoutPos.clusters;
      n.position.copy(baseAnchor).multiplyScalar(spread);
      n.currentClusterRadius = n.layoutRadius[mode] || n.layoutRadius.clusters;
      if (n.meshGroup) n.meshGroup.position.copy(n.position);
    }

    for (const n of nodes) {
      if (n.type !== 'artist' || !n.layoutPos) continue;
      if (n.isBridge) {
        const sunA = n._sunA || (n._sunA = nodes.find(x => x.id === n.primarySunId));
        const sunB = n._sunB || (n._sunB = nodes.find(x => x.id === n.secondarySunId));
        if (sunA && sunB) {
          n.position.lerpVectors(sunA.position, sunB.position, n.bridgeLerp ?? 0.5);
          if (n.bridgeOffsetFromMid) n.position.add(n.bridgeOffsetFromMid);
        } else {
          n.position.copy(n.layoutPos[mode] || n.layoutPos.clusters).multiplyScalar(spread);
        }
      } else {
        const sun = n._sun || (n._sun = nodes.find(x => x.id === n.primarySunId));
        if (sun && n.localClusterOffset) {
          const planetSpread = 0.85 + 0.15 * scale;
          n.position.copy(sun.position).addScaledVector(n.localClusterOffset, planetSpread);
        } else {
          n.position.copy(n.layoutPos[mode] || n.layoutPos.clusters);
        }
      }
      if (n.meshGroup) n.meshGroup.position.copy(n.position);
    }

    for (const n of nodes) {
      if (n.type !== 'track' || !n.parentNode) continue;
      const p = n.parentNode.position;
      const a = n.moonPhase + t * n.moonSpeed;
      const r = n.moonRadius * scale;
      const lx = Math.cos(a) * r;
      const lz0 = Math.sin(a) * r;
      const ly = lz0 * Math.sin(n.moonInclination);
      const lz = lz0 * Math.cos(n.moonInclination);
      const cn = Math.cos(n.moonNode), sn = Math.sin(n.moonNode);
      n.position.set(p.x + lx * cn - lz * sn, p.y + ly, p.z + lx * sn + lz * cn);
      if (n.meshGroup) n.meshGroup.position.copy(n.position);
    }
  }
}
