// src/renderer/shaders/planetShader.js
import * as THREE from 'three';

/**
 * Artist Planet Material (InstancedMesh over SphereGeometry(1, 32, 32)):
 * Per instance:
 *  - instanceColor: cluster color
 *  - aInfo.x: normalized listening score (0..1)
 *  - aInfo.y: focus / emissive intensity level (0 = hidden/culled, 1 = normal, 2.8 = main selected artist HDR glow)
 *  - aInfo.z: floor(aInfo.z) encodes role (0 = default, 1 = selected main artist, 2 = collaborator artist),
 *             fract(aInfo.z) is deterministic band seed (0..1).
 *
 * When aInfo.y < 0.06, fragments are discarded so out-of-focus planets never write to the
 * depth buffer or cross the camera's field of vision.
 */
export function createPlanetMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aInfo;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vLocal;
      varying vec3 vColor;
      varying vec3 vInfo;

      void main() {
        vLocal = normalize(position);
        vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        vColor = instanceColor;
        vInfo = aInfo;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vLocal;
      varying vec3 vColor;
      varying vec3 vInfo;

      void main() {
        float focus = vInfo.y;
        // Completely discard out-of-focus planets so they never block or cross the view
        if (focus < 0.06) discard;

        float role = floor(vInfo.z + 0.05);
        float seed = fract(vInfo.z) * 6.2831;

        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        float ndotv = max(0.0, dot(normal, viewDir));
        float rim = pow(1.0 - ndotv, 2.6);
        vec3 lightDir = normalize(vec3(0.45, 0.75, 0.55));
        float diff = smoothstep(-0.25, 1.0, dot(normal, lightDir));

        // Atmospheric gas-giant bands to visually distinguish artist planets from song crystals
        float bands = sin(vLocal.y * 10.5 + seed + sin(vLocal.x * 4.5 + seed) * 0.65);
        vec3 surface = vColor * (1.0 + bands * 0.2);
        vec3 rimColor = mix(vColor, vec3(1.0), 0.5);

        float listenBoost = 0.48 + 0.52 * vInfo.x;
        float lit = min(1.35, focus) * listenBoost;
        vec3 color = surface * (0.26 + 0.74 * diff) * lit + rimColor * rim * 0.65 * lit;

        if (role > 0.5 && role < 1.5) {
          // Role 1: Main selected artist — emissiveIntensity = 2.8 HDR core + golden/white solar rim for bloom
          float emissiveBoost = max(1.8, focus * 0.62);
          vec3 hdrCore = mix(vColor, vec3(1.0, 0.96, 0.86), 0.52);
          float coreGlow = pow(ndotv, 1.35) * 0.95;
          color = surface * (0.6 + 0.75 * diff) * emissiveBoost
                + hdrCore * coreGlow
                + mix(vColor, vec3(1.0, 0.95, 0.82), 0.72) * pow(1.0 - ndotv, 1.75) * 2.25;
        } else if (role >= 1.5) {
          // Role 2: Collaborator artist — distinct cyan (#38bdf8 / #7dd3fc) rim & equatorial band
          vec3 collabCyan = vec3(0.22, 0.74, 0.97);
          float eqStripe = smoothstep(0.2, 0.0, abs(vLocal.y));
          float sharpRim = pow(1.0 - ndotv, 2.0);
          color = mix(color, surface * 0.95 + collabCyan * 0.32, 0.45)
                + collabCyan * eqStripe * 0.58
                + collabCyan * sharpRim * 1.55;
        }

        gl_FragColor = vec4(color, 1.0);
      }
    `
  });
}

/**
 * Song Moon Crystal Material (InstancedMesh over IcosahedronGeometry(1, 0)):
 * Visually differentiates songs from artist planets by rendering songs as faceted,
 * flat-shaded crystalline polyhedra. When an artist or song is selected, their moons
 * boost to emissiveIntensity = 2.2+ while unrelated moons discard completely.
 */
export function createMoonCrystalMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aMoonInfo;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vColor;
      varying vec3 vMoonInfo;

      void main() {
        vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        vColor = instanceColor;
        vMoonInfo = aMoonInfo;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vColor;
      varying vec3 vMoonInfo;

      void main() {
        float focus = vMoonInfo.x;
        // Completely discard unselected moons so they never write to depth or cross the view
        if (focus < 0.06) discard;

        float isSpecial = vMoonInfo.y; // 1.0 = collab song, 0.5 = past fav, 0.0 = regular

        // Compute geometric face normal via screen-space derivatives for crisp flatShading: true crystal facets
        vec3 fdx = dFdx(vViewPosition);
        vec3 fdy = dFdy(vViewPosition);
        vec3 faceNormal = normalize(cross(fdx, fdy));
        vec3 normal = normalize(mix(vNormal, faceNormal, 0.85));

        vec3 viewDir = normalize(vViewPosition);
        vec3 lightDir = normalize(vec3(0.5, 0.8, 0.6));

        float facetDiff = max(0.22, dot(normal, lightDir));
        vec3 halfVec = normalize(lightDir + viewDir);
        float spec = pow(max(0.0, dot(normal, halfVec)), 16.0);
        float rim = pow(1.0 - max(0.0, dot(normal, viewDir)), 2.0);

        vec3 crystalTint = isSpecial > 0.75
          ? mix(vColor, vec3(0.22, 0.74, 0.97), 0.52)
          : mix(vColor, vec3(0.92, 0.96, 1.0), 0.38);

        float baseFocus = min(1.3, focus);
        vec3 color = crystalTint * (0.48 + 0.78 * facetDiff) * baseFocus
                   + vec3(1.0, 0.99, 0.92) * spec * 1.05 * baseFocus
                   + crystalTint * rim * 0.88 * baseFocus;

        // When the parent artist is selected (focus >= 2.0, emissiveIntensity = 2.2), light up like a glowing diamond crystal
        if (focus > 1.15) {
          float emissiveFactor = clamp((focus - 1.0) / 1.25, 0.35, 1.45);
          vec3 glowTint = isSpecial > 0.75
            ? vec3(0.49, 0.83, 0.99)
            : mix(vColor, vec3(1.0, 0.98, 0.9), 0.6);
          color = color * (1.25 + 0.35 * emissiveFactor) + glowTint * (0.55 + rim * 1.25) * emissiveFactor;
        }

        gl_FragColor = vec4(color, 1.0);
      }
    `
  });
}
