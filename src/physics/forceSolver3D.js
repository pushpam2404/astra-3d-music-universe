// src/physics/forceSolver3D.js
import * as THREE from 'three';
import { PHYSICS_CONFIG } from '../config/constants.js';

export class ForceDirectedPhysicsEngine {
  constructor() {
    this.orbitMultiplier = 1.0;
    this.nodeScaleMultiplier = 1.0;
    this.layoutMode = 'force'; // 'force' | 'rings'

    this.tempVec1 = new THREE.Vector3();
    this.tempVec2 = new THREE.Vector3();
    this.forceSpring = new THREE.Vector3();
    this.forceRep = new THREE.Vector3();
    this.forceSwirl = new THREE.Vector3();
  }

  initializeNodePositions(nodes) {
    const genreNodes = nodes.filter(n => n.type === 'genre');
    const artistNodes = nodes.filter(n => n.type === 'artist');
    const trackNodes = nodes.filter(n => n.type === 'track');

    // 1. Position Genre Suns evenly along the galactic perimeter
    genreNodes.forEach((genre, idx) => {
      const angle = (idx / Math.max(1, genreNodes.length)) * Math.PI * 2;
      const center = genre.galaxyCenter || { x: 0, y: 0, z: 0 };
      const r = PHYSICS_CONFIG.genreOrbitRadius;

      genre.orbitAngle = angle;
      genre.orbitSpeed = PHYSICS_CONFIG.genreOrbitSpeed;
      genre.initialY = ((idx % 3) - 1) * 8.0;

      genre.position = new THREE.Vector3(
        center.x + Math.cos(angle) * r,
        center.y + genre.initialY,
        center.z + Math.sin(angle) * r
      );
      genre.velocity = new THREE.Vector3();
    });

    // 2. Position Artist Planets clustered near their primary genres
    artistNodes.forEach((artist, idx) => {
      const center = artist.galaxyCenter || { x: 0, y: 0, z: 0 };
      const angle = (idx / Math.max(1, artistNodes.length)) * Math.PI * 2;
      const spread = 24.0 + (idx % 5) * 6.0;

      artist.position = new THREE.Vector3(
        center.x + Math.cos(angle) * (PHYSICS_CONFIG.genreOrbitRadius * 0.75 + spread),
        center.y + ((idx % 4) - 1.5) * 9.0,
        center.z + Math.sin(angle) * (PHYSICS_CONFIG.genreOrbitRadius * 0.75 + spread)
      );
      artist.velocity = new THREE.Vector3();
      artist.orbitAngle = angle;
    });

    // 3. Position Track Satellites in orbits around their parent artists
    trackNodes.forEach((track, idx) => {
      const moonR = 14.0 + (idx % 4) * 3.5;
      track.moonRadius = moonR;
      track.moonAngle = Math.random() * Math.PI * 2;
      track.moonSpeed = PHYSICS_CONFIG.satelliteOrbitSpeedMin + (idx % 5) * 0.002;

      track.position = new THREE.Vector3();
      track.velocity = new THREE.Vector3();
    });
  }

  step(nodes, delta = 16) {
    const genreNodes = nodes.filter(n => n.type === 'genre');
    const artistNodes = nodes.filter(n => n.type === 'artist');
    const trackNodes = nodes.filter(n => n.type === 'track');

    const dt = Math.min(1.0, delta / 16.67);
    const orbitScale = Math.max(0.0, this.orbitMultiplier);

    if (this.layoutMode === 'rings') {
      this.stepConcentricRings(genreNodes, artistNodes, trackNodes, dt, orbitScale);
      return;
    }

    // A. Update Genre Galactic Suns
    genreNodes.forEach(genre => {
      genre.orbitAngle += genre.orbitSpeed * orbitScale * dt;
      const center = genre.galaxyCenter || { x: 0, y: 0, z: 0 };
      const r = PHYSICS_CONFIG.genreOrbitRadius;

      const targetX = center.x + Math.cos(genre.orbitAngle) * r;
      const targetZ = center.z + Math.sin(genre.orbitAngle) * r;
      const targetY = center.y + (genre.initialY || 0);

      genre.position.x += (targetX - genre.position.x) * 0.05 * dt;
      genre.position.y += (targetY - genre.position.y) * 0.05 * dt;
      genre.position.z += (targetZ - genre.position.z) * 0.05 * dt;

      if (genre.meshGroup) {
        genre.meshGroup.position.copy(genre.position);
      }
    });

    // B. Update Artist Planets (Spring + Repulsion + Swirl)
    for (let i = 0; i < artistNodes.length; i++) {
      const a = artistNodes[i];
      this.forceSpring.set(0, 0, 0);
      this.forceRep.set(0, 0, 0);
      this.forceSwirl.set(0, 0, 0);

      // 1. Hooke's Law Spring to connected genre suns
      const genreCount = a.genres ? a.genres.length : 1;
      const restLength = genreCount > 1 ? PHYSICS_CONFIG.restLengthBridgeGenre : PHYSICS_CONFIG.restLengthSingleGenre;
      const effectiveRestLength = a.idealOrbitDist || restLength;

      if (Array.isArray(a.genres)) {
        a.genres.forEach(genreId => {
          const gNode = genreNodes.find(g => g.id === genreId);
          if (gNode) {
            this.tempVec1.subVectors(gNode.position, a.position);
            const dist = this.tempVec1.length();
            if (dist > 0.001) {
              const deltaDist = dist - effectiveRestLength;
              this.tempVec1.normalize().multiplyScalar(deltaDist * PHYSICS_CONFIG.springK);
              this.forceSpring.add(this.tempVec1);

              // Orbital tangential swirl around primary genre
              const dx = a.position.x - gNode.position.x;
              const dz = a.position.z - gNode.position.z;
              const horizLen = Math.sqrt(dx * dx + dz * dz);
              if (horizLen > 0.001) {
                const swirlMagnitude = PHYSICS_CONFIG.swirlK * orbitScale;
                this.forceSwirl.x += (-dz / horizLen) * swirlMagnitude;
                this.forceSwirl.z += (dx / horizLen) * swirlMagnitude;
              }
            }
          }
        });
      }

      // If Lagrange bridge node in collision mode, add pull toward origin (0, 0, 0)
      if (a.isWormholeBridge) {
        this.tempVec1.set(0, 0, 0).sub(a.position);
        const distToCenter = this.tempVec1.length();
        this.forceSpring.add(this.tempVec1.normalize().multiplyScalar(distToCenter * 0.015));
      }

      // 2. Pairwise Coulomb Electrostatic Repulsion against other artists
      for (let j = 0; j < artistNodes.length; j++) {
        if (i === j) continue;
        const b = artistNodes[j];
        this.tempVec2.subVectors(a.position, b.position);
        const distSq = this.tempVec2.lengthSq() + PHYSICS_CONFIG.repulsionEpsilon;
        const dist = Math.sqrt(distSq);
        if (dist > 0.001) {
          const repMag = PHYSICS_CONFIG.repulsionK / distSq;
          this.tempVec2.normalize().multiplyScalar(repMag);
          this.forceRep.add(this.tempVec2);
        }
      }

      // Euler integration
      const invMass = 1.0 / (a.mass || 10.0);
      a.velocity.x += (this.forceSpring.x + this.forceRep.x + this.forceSwirl.x) * invMass * dt;
      a.velocity.y += (this.forceSpring.y + this.forceRep.y + this.forceSwirl.y) * invMass * dt;
      a.velocity.z += (this.forceSpring.z + this.forceRep.z + this.forceSwirl.z) * invMass * dt;

      a.velocity.multiplyScalar(Math.pow(PHYSICS_CONFIG.damping, dt));

      a.position.addScaledVector(a.velocity, dt);

      if (a.meshGroup) {
        a.meshGroup.position.copy(a.position);
      }
    }

    // C. Update Track Satellites (Keplerian Lunar Orbits)
    trackNodes.forEach(track => {
      const parentArtist = artistNodes.find(a => a.id === track.artistId) || artistNodes[0];
      if (!parentArtist) return;

      track.moonAngle += track.moonSpeed * orbitScale * dt;
      const r = track.moonRadius;

      // Desired orbit around parent artist
      const targetPos = new THREE.Vector3(
        parentArtist.position.x + Math.cos(track.moonAngle) * r,
        parentArtist.position.y + Math.sin(track.moonAngle * 1.7) * 5.5,
        parentArtist.position.z + Math.sin(track.moonAngle) * r
      );

      // Collab blending if featuring second artist
      if (track.featArtistId) {
        const featArtist = artistNodes.find(a => a.id === track.featArtistId);
        if (featArtist) {
          targetPos.lerp(featArtist.position, 0.28);
        }
      }

      track.position.lerp(targetPos, 0.12 * dt);

      if (track.meshGroup) {
        track.meshGroup.position.copy(track.position);
      }
    });
  }

  stepConcentricRings(genreNodes, artistNodes, trackNodes, dt, orbitScale) {
    // Elegant concentric astronomical shells
    const now = performance.now() * 0.0003 * orbitScale;

    genreNodes.forEach((g, idx) => {
      const angle = (idx / Math.max(1, genreNodes.length)) * Math.PI * 2 + now * 0.4;
      g.position.set(Math.cos(angle) * 70, 0, Math.sin(angle) * 70);
      if (g.meshGroup) g.meshGroup.position.copy(g.position);
    });

    artistNodes.forEach((a, idx) => {
      const angle = (idx / Math.max(1, artistNodes.length)) * Math.PI * 2 + now * 0.7;
      a.position.set(Math.cos(angle) * 140, Math.sin(angle * 2.0) * 8.0, Math.sin(angle) * 140);
      if (a.meshGroup) a.meshGroup.position.copy(a.position);
    });

    trackNodes.forEach((t, idx) => {
      const angle = (idx / Math.max(1, trackNodes.length)) * Math.PI * 2 + now * 1.1;
      t.position.set(Math.cos(angle) * 210, Math.cos(angle * 3.0) * 12.0, Math.sin(angle) * 210);
      if (t.meshGroup) t.meshGroup.position.copy(t.position);
    });
  }

  updateEdgeLines(edges) {
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (edge.lineMesh && edge.source && edge.target) {
        const positions = edge.lineMesh.geometry.attributes.position.array;
        positions[0] = edge.source.position.x;
        positions[1] = edge.source.position.y;
        positions[2] = edge.source.position.z;
        positions[3] = edge.target.position.x;
        positions[4] = edge.target.position.y;
        positions[5] = edge.target.position.z;
        edge.lineMesh.geometry.attributes.position.needsUpdate = true;
      }
    }
  }

  updateSynapticPulses(pulseParticles, orbitSpeed) {
    const speedScale = Math.max(0.2, orbitSpeed);
    for (let i = 0; i < pulseParticles.length; i++) {
      const p = pulseParticles[i];
      p.progress = (p.progress + p.speed * speedScale) % 1.0;
      p.mesh.position.lerpVectors(
        p.edge.source.position,
        p.edge.target.position,
        p.progress
      );
    }
  }
}
