// src/renderer/shaders/planetShader.js
import * as THREE from 'three';

/**
 * Artist Planet Material (InstancedMesh over SphereGeometry(1, 32, 32)):
 * Per instance:
 *  - instanceColor: cluster color
 *  - aInfo.x: normalized listening score (0..1)
 *  - aInfo.y: focus level (< 0.6 = dimmed background planet, 1.0 = normal, > 1.0 = focused artist)
 *  - aInfo.z: floor(aInfo.z + 0.001) encodes role (0 = default, 1 = selected main artist, 2 = collaborator artist),
 *             fract(aInfo.z) is deterministic band seed in [0.005 .. 0.485] so it NEVER overflows into role 1.
 *
 * Renders crisp, non-glowing 3D spheres in their refined cluster colors.
 */
export function createPlanetMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    vertexShader: /* glsl */ `
      attribute vec3 aInfo;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vLocal;
      varying vec3 vColor;
      varying vec3 vInfo;
      varying vec4 vClipPos;

      void main() {
        vLocal = normalize(position);
        vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        vColor = instanceColor;
        vInfo = aInfo;
        gl_Position = projectionMatrix * mvPosition;
        vClipPos = gl_Position;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vLocal;
      varying vec3 vColor;
      varying vec3 vInfo;
      varying vec4 vClipPos;

      void main() {
        float focus = vInfo.y;
        // seedFrac is strictly in [0.005, 0.485], so floor(vInfo.z + 0.001) is exact role (0, 1, or 2)
        float role = floor(vInfo.z + 0.001);
        float seed = fract(vInfo.z) * 12.566;

        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        float ndotv = max(0.0, dot(normal, viewDir));
        float rim = pow(1.0 - ndotv, 2.6);
        vec3 lightDir = normalize(vec3(0.45, 0.75, 0.55));
        float diff = smoothstep(-0.25, 1.0, dot(normal, lightDir));

        // Subtle planetary bands
        float bands = sin(vLocal.y * 10.5 + seed + sin(vLocal.x * 4.5 + seed) * 0.65);
        vec3 surface = vColor * (0.92 + bands * 0.10);

        float listenBoost = 0.68 + 0.32 * vInfo.x;
        vec3 baseShaded = (surface * (0.40 + 0.60 * diff) + vColor * rim * 0.32) * listenBoost;

        float camDist = length(vViewPosition);
        vec2 ndc = vClipPos.xy / max(0.001, vClipPos.w);
        float centerDist = length(ndc);
        vec3 color = baseShaded;
        float alpha = 1.0;

        if (role > 0.5 && role < 1.5) {
          // Role 1: Main selected artist — crisp, rich true color with a subtle warm starlight rim
          color = surface * (0.45 + 0.62 * diff) + mix(vColor, vec3(0.98, 0.94, 0.84), 0.32) * rim * 0.45;
          alpha = 1.0;
        } else if (role >= 1.5) {
          // Role 2: Collaborator artist — keeps its natural cluster color with a subtle warm rim (no blue tint)
          color = surface * (0.42 + 0.60 * diff) + mix(vColor, vec3(0.96, 0.91, 0.78), 0.25) * rim * 0.40;
          alpha = 1.0;
        } else if (focus < 0.75) {
          // Unselected / dimmed planet: keep RGB color intact and dim via alpha so it stays softly visible and see-through
          color = baseShaded * 0.78;
          float baseAlpha = clamp(focus * 1.45, 0.22, 0.68);
          float lineOfSightFade = mix(0.38, 1.0, smoothstep(0.0, 0.42, centerDist));
          float nearCameraFade = smoothstep(6.0, 36.0, camDist);
          alpha = clamp(baseAlpha * lineOfSightFade * nearCameraFade, 0.08, 0.68);
        } else {
          alpha = smoothstep(4.0, 16.0, camDist);
        }

        gl_FragColor = vec4(color, alpha);
      }
    `
  });
}

/**
 * Song Moon Crystal Material (InstancedMesh over IcosahedronGeometry(1, 0)):
 * Visually differentiates songs from artist planets by rendering songs as crisp,
 * flat-shaded faceted crystals in their parent artist's exact color (vColor) without any glow.
 */
export function createMoonCrystalMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    vertexShader: /* glsl */ `
      attribute vec3 aMoonInfo;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vColor;
      varying vec3 vMoonInfo;
      varying vec4 vClipPos;

      void main() {
        vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        vColor = instanceColor;
        vMoonInfo = aMoonInfo;
        gl_Position = projectionMatrix * mvPosition;
        vClipPos = gl_Position;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vColor;
      varying vec3 vMoonInfo;
      varying vec4 vClipPos;

      void main() {
        float focus = vMoonInfo.x;

        // Compute geometric face normal via screen-space derivatives for crisp flat-shaded crystal facets
        vec3 fdx = dFdx(vViewPosition);
        vec3 fdy = dFdy(vViewPosition);
        vec3 faceNormal = normalize(cross(fdx, fdy));
        vec3 normal = normalize(mix(vNormal, faceNormal, 0.9));

        vec3 viewDir = normalize(vViewPosition);
        vec3 lightDir = normalize(vec3(0.5, 0.8, 0.6));

        float facetDiff = max(0.25, dot(normal, lightDir));
        vec3 halfVec = normalize(lightDir + viewDir);
        float spec = pow(max(0.0, dot(normal, halfVec)), 22.0);
        float rim = pow(1.0 - max(0.0, dot(normal, viewDir)), 2.4);

        vec3 baseShaded = vColor * (0.42 + 0.65 * facetDiff)
                        + mix(vColor, vec3(1.0), 0.35) * spec * 0.45
                        + vColor * rim * 0.35;

        float camDist = length(vViewPosition);
        vec2 ndc = vClipPos.xy / max(0.001, vClipPos.w);
        float centerDist = length(ndc);
        vec3 color = baseShaded;
        float alpha = 1.0;

        if (focus > 1.05) {
          // Focused artist's song moons: crisp, saturated parent-artist color with sharp crystal facets
          color = vColor * (0.48 + 0.65 * facetDiff) + mix(vColor, vec3(1.0), 0.28) * spec * 0.5;
          alpha = 1.0;
        } else if (focus < 0.75) {
          // Unselected moon: keep RGB color intact and dim via alpha so it stays faintly visible
          color = baseShaded * 0.75;
          float baseAlpha = clamp(focus * 1.35, 0.18, 0.55);
          float lineOfSightFade = mix(0.35, 1.0, smoothstep(0.0, 0.42, centerDist));
          float nearCameraFade = smoothstep(5.0, 30.0, camDist);
          alpha = clamp(baseAlpha * lineOfSightFade * nearCameraFade, 0.06, 0.55);
        } else {
          alpha = smoothstep(3.0, 14.0, camDist);
        }

        gl_FragColor = vec4(color, alpha);
      }
    `
  });
}
