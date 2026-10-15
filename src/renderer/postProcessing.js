// src/renderer/postProcessing.js
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const HyperspaceWarpShader = {
  uniforms: {
    tDiffuse: { value: null },
    uWarpIntensity: { value: 0.0 }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uWarpIntensity;
    varying vec2 vUv;

    void main() {
      vec2 dir = vUv - vec2(0.5);
      float dist = length(dir);
      float offset = dist * 0.045 * uWarpIntensity;

      float r = texture2D(tDiffuse, vUv + dir * offset).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - dir * offset).b;

      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `
};

export function initPostProcessing(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // HDR Cosmic Bloom
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.25, // strength
    0.45, // radius
    0.18  // threshold
  );
  composer.addPass(bloomPass);

  // Hyperspace Chromatic Aberration Warp Pass
  const warpPass = new ShaderPass(HyperspaceWarpShader);
  composer.addPass(warpPass);

  return { composer, bloomPass, warpPass };
}
