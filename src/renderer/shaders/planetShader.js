// src/renderer/shaders/planetShader.js
import * as THREE from 'three';

/**
 * One material for every artist planet, drawn as a single InstancedMesh.
 * Per instance: color (instanceColor) and aInfo = (listen 0..1, focus 0..1, band seed).
 * Solid planet with soft lighting, latitude bands and a thin rim. Long-tail artists
 * are dimmer; out-of-focus planets go dark (never see-through).
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
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        float rim = pow(1.0 - max(0.0, dot(normal, viewDir)), 3.0);
        vec3 lightDir = normalize(vec3(0.45, 0.75, 0.55));
        float diff = smoothstep(-0.25, 1.0, dot(normal, lightDir));

        float seed = vInfo.z * 6.2831;
        float bands = sin(vLocal.y * 9.0 + seed + sin(vLocal.x * 4.0 + seed) * 0.6);
        vec3 surface = vColor * (1.0 + bands * 0.18);
        vec3 rimColor = mix(vColor, vec3(1.0), 0.45);

        float lit = max(vInfo.y, 0.16) * (0.45 + 0.55 * vInfo.x);
        vec3 color = surface * (0.22 + 0.78 * diff) * lit + rimColor * rim * 0.55 * lit * lit;
        gl_FragColor = vec4(color, 1.0);
      }
    `
  });
}
