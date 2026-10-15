// src/renderer/shaders/fresnelPlanetShader.js
import * as THREE from 'three';

/**
 * Solid planet with soft terminator lighting, procedural latitude bands and a thin
 * atmospheric rim. uOpacity drives focus dimming by darkening (planets stay opaque;
 * translucent planets read as soap bubbles).
 */
/**
 * @param {number} listen  0..1 how much you listen (normScore); heavily played planets shine brighter.
 */
export function createFresnelPlanetMaterial(hexColor, valence = 0.65, seed = 0, listen = 1) {
  const base = new THREE.Color(hexColor);
  const rimColor = base.clone().lerp(new THREE.Color('#FFFFFF'), 0.45);

  return new THREE.ShaderMaterial({
    uniforms: {
      uBaseColor: { value: base },
      uRimColor: { value: rimColor },
      uBandShift: { value: seed * 6.2831 },
      uBandStrength: { value: 0.12 + valence * 0.12 },
      uOpacity: { value: 1.0 },
      uListen: { value: listen }
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vLocal;

      void main() {
        vLocal = normalize(position);
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uBaseColor;
      uniform vec3 uRimColor;
      uniform float uBandShift;
      uniform float uBandStrength;
      uniform float uOpacity;
      uniform float uListen;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vLocal;

      void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        float rim = pow(1.0 - max(0.0, dot(normal, viewDir)), 3.0);

        vec3 lightDir = normalize(vec3(0.45, 0.75, 0.55));
        float diff = smoothstep(-0.25, 1.0, dot(normal, lightDir));

        float bands = sin(vLocal.y * 9.0 + uBandShift + sin(vLocal.x * 4.0 + uBandShift) * 0.6);
        vec3 surface = uBaseColor * (1.0 + bands * uBandStrength);

        // Long-tail artists are dimmer; favourites glow at full strength.
        float lit = max(uOpacity, 0.16) * (0.45 + 0.55 * uListen);
        vec3 color = surface * (0.22 + 0.78 * diff) * lit + uRimColor * rim * 0.55 * lit * lit;
        gl_FragColor = vec4(color, 1.0);
      }
    `
  });
}
