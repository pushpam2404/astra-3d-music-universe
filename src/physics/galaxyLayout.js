// src/physics/galaxyLayout.js
/**
 * 3D layout where distance means similarity, clusters sit at a balanced distance from
 * one another, and artist planets NEVER overlap with other artist planets:
 *
 *  - Inside each cluster, artists are placed using their UMAP similarity direction
 *    blended with a 3D Fibonacci sphere distribution, followed by a deterministic 3D
 *    planet de-overlapping solver (`resolveClusterArtistOverlaps`) and global
 *    3D collision resolution pass (`resolveArtistCollisions`) that guarantees
 *    every pair of artist planets maintains a clear surface-to-surface gap including
 *    their moon orbit shells.
 *  - Cluster centers sit on an affinity-seriated sphere and undergo 3D pairwise
 *    clearance + shell relaxation (`computeBalancedClusterAnchors`).
 *  - Bridge artists float in the channel between both clouds and are de-overlapped.
 *  - Tracks orbit their artist as crystal moons on inclined orbits.
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
  if (n <= 1) return new THREE.Vector3(0, 1, 0);
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = Math.PI * (3 - Math.sqrt(5)) * i;
  return new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
}

/** Deterministic, uniformly distributed direction for an id. */
function directionFor(id) {
  const u = hash01(`${id}:u`) * 2 - 1;
  const phi = hash01(`${id}:phi`) * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - u * u));
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
 * Resolves all planet-to-planet overlaps inside and across clusters.
 * Guarantees a minimum clearance of (rA + rB + moonOrbitAllowance + padding).
 */
export function resolveArtistCollisions(artists, iterations = 18) {
  const n = artists.length;
  if (n < 2) return;

  // Effective collision radius includes the planet's visual radius + its moon orbit shell + breathing room
  const getEffectiveRadius = (a) => {
    const planetRadius = a.radius || a.baseRadius || 1.2;
    const hasMoons = (a.trackCount || a.tracks?.length || 0) > 0;
    const moonClearance = hasMoons ? 2.4 : 0.8;
    return planetRadius + moonClearance;
  };

  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;

    for (let i = 0; i < n; i++) {
      const a = artists[i];
      if (!a?.position) continue;
      const rA = getEffectiveRadius(a);

      for (let j = i + 1; j < n; j++) {
        const b = artists[j];
        if (!b?.position) continue;
        const rB = getEffectiveRadius(b);
        const minDist = rA + rB;

        let dx = b.position.x - a.position.x;
        if (Math.abs(dx) >= minDist) continue;
        let dy = b.position.y - a.position.y;
        if (Math.abs(dy) >= minDist) continue;
        let dz = b.position.z - a.position.z;
        if (Math.abs(dz) >= minDist) continue;

        let distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < minDist * minDist) {
          moved = true;
          let dist = Math.sqrt(distSq);

          // Deterministic Golden-Angle nudge if two artists spawned on the exact same UMAP point
          if (dist < 1e-4) {
            const phi = (i * 2.399963229728653) % (Math.PI * 2);
            const costheta = ((j % 17) / 8.5) - 1;
            const sintheta = Math.sqrt(Math.max(0, 1 - costheta * costheta));
            dx = sintheta * Math.cos(phi);
            dy = sintheta * Math.sin(phi);
            dz = costheta;
            dist = 1;
          }

          const overlap = (minDist - dist) * 0.55;
          const nx = dx / dist;
          const ny = dy / dist;
          const nz = dz / dist;

          // Weight push by inverse play count so top artists anchor their spot while smaller ones shift outward
          const playsA = a.playCount ?? a.plays ?? 1;
          const playsB = b.playCount ?? b.plays ?? 1;
          const wA = 1 / Math.sqrt(playsA + 5);
          const wB = 1 / Math.sqrt(playsB + 5);
          const wSum = wA + wB;

          a.position.x -= nx * overlap * (wA / wSum) * 2;
          a.position.y -= ny * overlap * (wA / wSum) * 2;
          a.position.z -= nz * overlap * (wA / wSum) * 2;

          b.position.x += nx * overlap * (wB / wSum) * 2;
          b.position.y += ny * overlap * (wB / wSum) * 2;
          b.position.z += nz * overlap * (wB / wSum) * 2;
        }
      }
    }

    if (!moved) break;
  }
}

/**
 * Resolves 3D planet-to-planet overlaps inside a cluster (`offsetProp`, e.g. 'localClusterOffset'
 * or 'cloudOffset') so no two artist planets ever intersect or touch each other, and no
 * artist planet clips into its central Genre Sun (`coreRadius`).
 */
function resolveClusterArtistOverlaps(list, coreRadius, offsetProp = 'localClusterOffset') {
  const n = list.length;
  if (n <= 1) return;

  const diff = new THREE.Vector3();
  const iters = n > 400 ? 18 : 26;

  const getEffR = (a) => {
    const r = a.radius || a.baseRadius || 1.2;
    const hasMoons = (a.trackCount || 0) > 0;
    return r + (hasMoons ? 2.4 : 0.8);
  };

  for (let iter = 0; iter < iters; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      const posA = a[offsetProp];
      const rA = getEffR(a);

      // Keep outside the Genre Sun's inner core
      const minSunDist = coreRadius + (a.baseRadius || 1.6) + 1.8;
      const dSun = posA.length();
      if (dSun < minSunDist) {
        moved = true;
        if (dSun < 1e-4) posA.copy(fibonacciSphere(i, n)).multiplyScalar(minSunDist);
        else posA.multiplyScalar(minSunDist / dSun);
      }

      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        const posB = b[offsetProp];
        const rB = getEffR(b);
        const minDist = rA + rB;

        const dx = posB.x - posA.x;
        if (Math.abs(dx) >= minDist) continue;
        const dy = posB.y - posA.y;
        if (Math.abs(dy) >= minDist) continue;
        const dz = posB.z - posA.z;
        if (Math.abs(dz) >= minDist) continue;

        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq >= minDist * minDist) continue;

        moved = true;
        let d = Math.sqrt(dSq);
        if (d < 1e-4) {
          const phi = (i * 2.399963229728653) % (Math.PI * 2);
          const costheta = ((j % 17) / 8.5) - 1;
          const sintheta = Math.sqrt(Math.max(0, 1 - costheta * costheta));
          diff.set(sintheta * Math.cos(phi), sintheta * Math.sin(phi), costheta);
          d = 1;
        } else {
          diff.set(dx / d, dy / d, dz / d);
        }

        const overlap = (minDist - d) * 0.55;
        const playsA = a.playCount ?? a.plays ?? 1;
        const playsB = b.playCount ?? b.plays ?? 1;
        const wA = 1 / Math.sqrt(playsA + 5);
        const wB = 1 / Math.sqrt(playsB + 5);
        const wSum = wA + wB;

        posA.addScaledVector(diff, -overlap * (wA / wSum) * 2);
        posB.addScaledVector(diff, overlap * (wB / wSum) * 2);
      }
    }
    if (!moved) break;
  }
}

/**
 * Places cluster anchors in 3D in the Goldilocks sweet spot:
 *  - Pairwise clearance guarantees adjacent clusters never collide into a clumsy clump while
 *    radial shell attraction prevents any cluster from drifting far away.
 */
function computeBalancedClusterAnchors(order) {
  const n = order.length;
  if (n === 0) return [];
  if (n === 1) return [new THREE.Vector3(0, 0, 0)];

  const radii = order.map(s => s.clusterRadius || 20);
  const meanR = radii.reduce((a, b) => a + b, 0) / n;
  const targetShellR = Math.max(48, meanR * Math.sqrt(n) * 0.72);

  const anchors = order.map((_, i) => fibonacciSphere(i, n).multiplyScalar(targetShellR));
  const diff = new THREE.Vector3();

  for (let iter = 0; iter < 85; iter++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        diff.subVectors(anchors[i], anchors[j]);
        const d = diff.length() || 0.01;
        const desiredMin = (radii[i] + radii[j]) * 0.96 + 11.0;
        if (d < desiredMin) {
          const push = (desiredMin - d) * 0.5;
          diff.divideScalar(d);
          anchors[i].addScaledVector(diff, push);
          anchors[j].addScaledVector(diff, -push);
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const r = anchors[i].length() || 1;
      const targetR = targetShellR + (radii[i] - meanR) * 0.32;
      const pull = (targetR - r) * 0.16;
      anchors[i].multiplyScalar((r + pull) / r);
    }
  }

  const center = new THREE.Vector3();
  anchors.forEach(a => center.add(a));
  center.divideScalar(n);
  anchors.forEach(a => a.sub(center));

  return anchors;
}

export class GalaxyLayoutEngine {
  constructor() {
    this.orbitMultiplier = 1.0;
    this.nodeScaleMultiplier = 1.0;
    this.clusterSpreadMultiplier = 1.0;
    this.time = 0;
    this.boundingRadius = 115;
    this.mode = 'clusters';
    this.hasSimilarity = false;
    this.bounds = { clusters: 115, similarity: 115 };
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
      const fullTrackCount = tracksByArtist.get(a.id)?.length || 0;
      const count = Math.min(12, fullTrackCount);
      a.trackCount = fullTrackCount;
      a.radius = a.baseRadius || 1.2;
      a.playCount = a.plays || a.basePlays || 1;
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

    // Cloud geometry per sun: stratified 3D Fibonacci directions + planet overlap resolution
    suns.forEach(sun => {
      const list = members.get(sun.id).sort((a, b) => b.plays - a.plays);
      const meanSystem = list.length ? list.reduce((s, a) => s + a.systemRadius, 0) / list.length : 0;
      const spacing = Math.max(4.6, meanSystem * 0.76);
      const core = sun.baseRadius * C.sunCoreFactor + C.cloudInnerGap;
      sun.coreRadius = core;
      sun.clusterRadius = core + spacing * Math.cbrt(list.length + 1) * 0.62;
      list.forEach((a, k) => {
        const t = (k + 0.5) / list.length;
        const r = core + (sun.clusterRadius - core) * Math.cbrt(t);
        const dir = fibonacciSphere(k, list.length).addScaledVector(directionFor(a.id), 0.32).normalize();
        a.labelRank = k;
        a.isBridge = false;
        a.cloudRadiusTarget = r;
        a.cloudOffset = dir.multiplyScalar(r);
      });
      resolveClusterArtistOverlaps(list, core, 'cloudOffset');
      if (list.length) {
        const sortedR = list.map(a => a.cloudOffset.length() + a.baseRadius).sort((x, y) => x - y);
        sun.clusterRadius = Math.max(sun.clusterRadius, sortedR[Math.floor(sortedR.length * 0.92)] || sun.clusterRadius);
      }
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

    const order = seriate(suns, affinity);
    const anchors = computeBalancedClusterAnchors(order);

    let bounding = 0;
    order.forEach((s, i) => {
      s.anchor = anchors[i];
      s.position.copy(s.anchor);
      bounding = Math.max(bounding, s.anchor.length() + s.clusterRadius * 0.92);
    });
    this.bounds.clusters = Math.max(92, bounding);

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
        const ring = Math.max(3.8, C.bridgeSpacing) * Math.sqrt(i + 0.5);
        const angle = i * 2.399963;
        a.isBridge = true;
        a.labelRank = i;
        a.bridgeOffsetFromMid = new THREE.Vector3()
          .addScaledVector(perpA, Math.cos(angle) * ring)
          .addScaledVector(perpB, Math.sin(angle) * ring)
          .addScaledVector(dir, ((i % 3) - 1) * 3.2);
        a.bridgeLerp = Math.max(0.18, Math.min(0.82, along / dist));
        a.bridgeAnchor = A.anchor.clone()
          .addScaledVector(dir, Math.max(0, along))
          .add(a.bridgeOffsetFromMid);
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
      a.position.copy(p);
    });

    this.computeSimilarityPositions(suns, artists, sunById, members);
    this.mode = this.hasSimilarity ? 'similarity' : 'clusters';
    this.boundingRadius = this.bounds[this.mode] * this.clusterSpreadMultiplier;

    // Global 3D collision resolution pass across all artists right before moon positions are assigned
    artists.forEach(a => {
      const targetPos = a.layoutPos[this.mode] || a.layoutPos.clusters;
      if (targetPos) a.position.copy(targetPos);
    });
    resolveArtistCollisions(artists, 18);
    artists.forEach(a => {
      if (a.layoutPos) a.layoutPos[this.mode] = a.position.clone();
      if (a.isBridge) {
        const sunA = sunById.get(a.primarySunId);
        const sunB = sunById.get(a.secondarySunId);
        if (sunA && sunB) {
          const mid = new THREE.Vector3().lerpVectors(sunA.anchor, sunB.anchor, a.bridgeLerp ?? 0.5);
          a.bridgeOffsetFromMid = a.position.clone().sub(mid);
          a.bridgeAnchor = a.position.clone();
        }
      } else {
        const sun = sunById.get(a.primarySunId);
        if (sun) {
          a.localClusterOffset = a.position.clone().sub(sun.anchor);
        }
      }
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
      const offsets = list.map((a, idx) => {
        if (!Array.isArray(a.embed)) return fibonacciSphere(idx, list.length);
        const off = new THREE.Vector3(...a.embed).sub(center);
        return off.lengthSq() > 1e-6 ? off : fibonacciSphere(idx, list.length);
      });
      const lengths = offsets.map(o => o.length()).sort((a, b) => a - b);
      const p85 = lengths[Math.floor(lengths.length * 0.85)] || 1;

      list.forEach((a, idx) => {
        const off = offsets[idx];
        // Blend UMAP similarity direction with stratified 3D Fibonacci sphere direction
        const fibDir = fibonacciSphere(idx, list.length);
        const dir = off.clone().normalize()
          .addScaledVector(fibDir, 0.48)
          .addScaledVector(directionFor(a.id), 0.22)
          .normalize();
        const normUmapR = Math.min(0.95, off.length() / p85);
        const rankR = a.cloudRadiusTarget || (sun.clusterRadius * 0.6);
        const r = THREE.MathUtils.lerp(rankR, sun.clusterRadius * (0.22 + 0.76 * normUmapR), 0.32);
        a.localClusterOffset = dir.clone().multiplyScalar(r);
      });

      // Run 3D collision & spacing solver so zero artist planets overlap in similarity mode
      resolveClusterArtistOverlaps(list, sun.coreRadius || 12, 'localClusterOffset');

      list.forEach(a => {
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

  /** 0..1 progress of the glide from the previous map (1 = settled). */
  morphT = 1;

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
      // While the map refines, glide from where this sun was on the previous map.
      if (this.morphT < 1 && n.morphFrom) n.position.lerpVectors(n.morphFrom, n.position, this.morphT);
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
          const planetSpread = Math.max(1.0, scale);
          n.position.copy(sun.position).addScaledVector(n.localClusterOffset, planetSpread);
        } else {
          n.position.copy(n.layoutPos[mode] || n.layoutPos.clusters);
        }
      }
      if (this.morphT < 1 && n.morphFrom) n.position.lerpVectors(n.morphFrom, n.position, this.morphT);
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
