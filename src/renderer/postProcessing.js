// src/renderer/postProcessing.js
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** Scene render + bloom (suns and moons glow; panels stay crisp because they're HTML). */
export const BLOOM_STRENGTH = 0.6;

export function initPostProcessing(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    BLOOM_STRENGTH, // strength (scaled by the Glow setting)
    0.45, // radius
    0.42  // threshold: only genuinely bright things (suns) bloom
  );
  composer.addPass(bloomPass);

  window.addEventListener('resize', () => {
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  return { composer, bloomPass };
}
