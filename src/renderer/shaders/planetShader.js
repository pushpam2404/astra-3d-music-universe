// src/renderer/shaders/planetShader.js
import * as THREE from 'three';

/**
 * Artist Planet Material (InstancedMesh over SphereGeometry(1, 32, 32)):
 * 100% OPAQUE (`transparent: false, depthWrite: true`) so planets are solid 3D bodies
 * and never look like see-through bubbles.
 *
 * Includes a crisp black silhouette border on light-colored clusters so individual
 * overlapping spheres are immediately recognizable.
 */
export function createPlanetMaterial() {
  return new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    depthTest: true,
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
        if (focus < 0.05) {
          discard;
        }

        float role = floor(vInfo.z + 0.001);
        float seed = fract(vInfo.z) * 12.566;

        float camDist = length(vViewPosition);
        vec2 ndc = vClipPos.xy / max(0.001, vClipPos.w);
        float centerDist = length(ndc);

        // If an unselected/dimmed planet revolves directly in front of the camera lens,
        // step it out of the way so it never blocks the focused artist behind it.
        if (focus < 0.65 && camDist < 28.0 && centerDist < 0.38) {
          discard;
        }

        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        float ndotv = max(0.0, dot(normal, viewDir));

        // Solid 3D sphere lighting: key light + fill light + limb darkening (no soap-bubble bright rim!)
        vec3 keyLight = normalize(vec3(0.42, 0.72, 0.55));
        float diff = smoothstep(-0.15, 0.95, dot(normal, keyLight));
        vec3 halfVec = normalize(keyLight + viewDir);
        float spec = pow(max(0.0, dot(normal, halfVec)), 28.0);

        float limb = 0.60 + 0.40 * pow(ndotv, 0.52);

        float bands = sin(vLocal.y * 10.0 + seed + sin(vLocal.x * 4.0 + seed) * 0.55);
        vec3 surface = vColor * (0.95 + bands * 0.06);

        float listenBoost = 0.84 + 0.16 * vInfo.x;
        vec3 solidColor = surface * (0.50 + 0.55 * diff) * limb * listenBoost
                        + mix(vColor, vec3(1.0), 0.45) * spec * 0.20;

        vec3 color = solidColor;

        if (role > 0.5 && role < 1.5) {
          // Role 1: Selected artist or Lens-matched artist — bright, saturated, solid 3D sphere
          color = surface * (0.58 + 0.54 * diff) * (0.68 + 0.32 * pow(ndotv, 0.5))
                + mix(vColor, vec3(1.0, 0.98, 0.92), 0.5) * spec * 0.28;
        } else if (role >= 1.5) {
          // Role 2: Collaborator / connected artist — vivid solid 3D sphere
          color = surface * (0.54 + 0.52 * diff) * (0.65 + 0.35 * pow(ndotv, 0.5))
                + mix(vColor, vec3(1.0), 0.45) * spec * 0.24;
        } else if (focus < 0.65) {
          // Unselected background planet: solid dark-matte sphere so foreground planets pop out against it
          color = surface * (0.20 + 0.28 * diff) * limb * 0.42;
        }

        // Crisp black border around each sphere silhouette so light-colored clusters are easy to distinguish
        float luma = dot(vColor, vec3(0.299, 0.587, 0.114));
        float maxCh = max(vColor.r, max(vColor.g, vColor.b));
        float isLight = smoothstep(0.30, 0.55, max(luma, maxCh * 0.82));

        float radial = sqrt(max(0.0, 1.0 - ndotv * ndotv));
        float px = max(0.015, fwidth(radial));
        float borderWidth = mix(0.05, 0.115, isLight) + px * 1.45;
        float borderMask = smoothstep(1.0 - borderWidth - px * 0.85, 1.0 - borderWidth + px * 0.35, radial);
        vec3 borderColor = vec3(0.012, 0.015, 0.025);
        color = mix(color, borderColor, borderMask * mix(0.70, 0.96, isLight));

        gl_FragColor = vec4(color, 1.0);
      }
    `
  });
}

/**
 * Song Moon Crystal Material (InstancedMesh over IcosahedronGeometry(1, 0)):
 * 100% OPAQUE (`transparent: false, depthWrite: true`) faceted 3D crystals in their
 * parent artist's exact color (`vColor`), with a crisp black border on light-colored
 * clusters so individual crystal moons stand out clearly against overlapping nodes.
 */
export function createMoonCrystalMaterial() {
  return new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    depthTest: true,
    vertexShader: /* glsl */ `
      attribute vec3 aMoonInfo;
      varying vec3 vNormal;
      varying vec3 vRadialNormal;
      varying vec3 vViewPosition;
      varying vec3 vColor;
      varying vec3 vMoonInfo;
      varying vec4 vClipPos;

      void main() {
        mat3 instMat3 = mat3(instanceMatrix);
        vNormal = normalize(normalMatrix * instMat3 * normal);
        vRadialNormal = normalize(normalMatrix * instMat3 * normalize(position));
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
      varying vec3 vRadialNormal;
      varying vec3 vViewPosition;
      varying vec3 vColor;
      varying vec3 vMoonInfo;
      varying vec4 vClipPos;

      void main() {
        float focus = vMoonInfo.x;
        if (focus < 0.05) {
          discard;
        }

        float camDist = length(vViewPosition);
        vec2 ndc = vClipPos.xy / max(0.001, vClipPos.w);
        if (focus < 0.65 && camDist < 24.0 && length(ndc) < 0.35) {
          discard;
        }

        vec3 fdx = dFdx(vViewPosition);
        vec3 fdy = dFdy(vViewPosition);
        vec3 faceNormal = normalize(cross(fdx, fdy));
        vec3 normal = normalize(mix(vNormal, faceNormal, 0.92));

        vec3 viewDir = normalize(vViewPosition);
        vec3 lightDir = normalize(vec3(0.45, 0.78, 0.58));

        float facetDiff = max(0.32, dot(normal, lightDir));
        vec3 halfVec = normalize(lightDir + viewDir);
        float spec = pow(max(0.0, dot(normal, halfVec)), 22.0);

        vec3 color = vColor * (0.52 + 0.62 * facetDiff)
                   + mix(vColor, vec3(1.0), 0.42) * spec * 0.36;

        if (focus > 1.05) {
          color = vColor * (0.60 + 0.60 * facetDiff)
                + mix(vColor, vec3(1.0), 0.45) * spec * 0.42;
        } else if (focus < 0.65) {
          color = vColor * (0.22 + 0.28 * facetDiff) * 0.42;
        }

        // Crisp black silhouette border on light-colored clusters so crystal moons are distinct
        float luma = dot(vColor, vec3(0.299, 0.587, 0.114));
        float maxCh = max(vColor.r, max(vColor.g, vColor.b));
        float isLight = smoothstep(0.30, 0.55, max(luma, maxCh * 0.82));

        float ndotvRadial = max(0.0, dot(normalize(vRadialNormal), viewDir));
        float radial = sqrt(max(0.0, 1.0 - ndotvRadial * ndotvRadial));
        float px = max(0.02, fwidth(radial));
        float borderWidth = mix(0.06, 0.14, isLight) + px * 1.4;
        float borderMask = smoothstep(1.0 - borderWidth - px * 0.85, 1.0 - borderWidth + px * 0.35, radial);
        vec3 borderColor = vec3(0.012, 0.015, 0.025);
        color = mix(color, borderColor, borderMask * mix(0.68, 0.95, isLight));

        gl_FragColor = vec4(color, 1.0);
      }
    `
  });
}
