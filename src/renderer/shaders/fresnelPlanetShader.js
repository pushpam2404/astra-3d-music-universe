// src/renderer/shaders/fresnelPlanetShader.js
import * as THREE from 'three';

export function createFresnelPlanetMaterial(hexColor, valence = 0.65) {
  const rimColor = new THREE.Color('#00F0FF').lerp(new THREE.Color('#FF007F'), valence);

  return new THREE.ShaderMaterial({
    uniforms: {
      uBaseColor: { value: new THREE.Color(hexColor) },
      uRimColor: { value: rimColor },
      uRimPower: { value: 2.6 }
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewPosition;

      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uBaseColor;
      uniform vec3 uRimColor;
      uniform float uRimPower;
      varying vec3 vNormal;
      varying vec3 vViewPosition;

      void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        float rim = 1.0 - max(0.0, dot(normal, viewDir));
        float fresnel = pow(rim, uRimPower);

        // Directional key light simulation
        vec3 lightDir = normalize(vec3(0.5, 0.8, 0.6));
        float diff = max(0.2, dot(normal, lightDir));

        vec3 bodyColor = uBaseColor * diff;
        vec3 atmosphere = uRimColor * fresnel * 1.5;

        gl_FragColor = vec4(bodyColor + atmosphere, 1.0);
      }
    `
  });
}
