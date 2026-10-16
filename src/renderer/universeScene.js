// src/renderer/universeScene.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createUniverseScene(canvasContainer) {
  // 1. Scene
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x040409, 0.0006);

  // 2. Camera
  const camera = new THREE.PerspectiveCamera(
    52,
    window.innerWidth / window.innerHeight,
    0.1,
    6000
  );
  camera.position.set(0, 160, 320);

  // 3. WebGLRenderer
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: false
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(maxPixelRatio());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  canvasContainer.appendChild(renderer.domElement);

  // 4. Orbit Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 6;
  controls.maxDistance = 850;
  // Full rotation: the universe is a 3D cloud, so every side is worth seeing.
  controls.zoomToCursor = true;
  // A slow turn makes the depth readable; the Motion slider controls its speed.
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  // 5. Ambient & Directional Lighting
  const ambientLight = new THREE.AmbientLight(0x222238, 1.2);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(120, 150, 100);
  scene.add(keyLight);

  // 6. Volumetric Deep-Space Starfield
  const starfield = createStarfield();
  scene.add(starfield);

  // Handle Resize
  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    renderer.setPixelRatio(maxPixelRatio());
  });

  return { scene, camera, renderer, controls, starfield };
}

function createStarfield() {
  const starCount = 3800;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);

  const starHues = [
    new THREE.Color('#FFFFFF'),
    new THREE.Color('#00F0FF'),
    new THREE.Color('#FF007F'),
    new THREE.Color('#FFB800'),
    new THREE.Color('#7928CA')
  ];

  for (let i = 0; i < starCount; i++) {
    const i3 = i * 3;
    // Distribute in huge sphere shell
    const radius = 1600 + Math.random() * 1600;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i3 + 2] = radius * Math.cos(phi);

    const chosenColor = starHues[Math.floor(Math.random() * starHues.length)];
    colors[i3] = chosenColor.r;
    colors[i3 + 1] = chosenColor.g;
    colors[i3 + 2] = chosenColor.b;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 3.2,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
    fog: false
  });

  return new THREE.Points(geometry, material);
}

/** Phones have very dense screens and small GPUs: 1.5× looks the same and keeps it smooth. */
function maxPixelRatio() {
  return Math.min(window.devicePixelRatio, window.matchMedia('(pointer: coarse)').matches ? 1.5 : 2);
}
