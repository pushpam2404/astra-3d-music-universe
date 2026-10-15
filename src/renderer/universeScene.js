// src/renderer/universeScene.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createUniverseScene(canvasContainer) {
  // 1. Scene
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x040409, 0.0012);

  // 2. Camera
  const camera = new THREE.PerspectiveCamera(
    52,
    window.innerWidth / window.innerHeight,
    0.1,
    3000
  );
  camera.position.set(0, 160, 320);

  // 3. WebGLRenderer
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: false
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  canvasContainer.appendChild(renderer.domElement);

  // 4. Orbit Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 15;
  controls.maxDistance = 850;
  controls.maxPolarAngle = Math.PI / 1.85;

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    const radius = 600 + Math.random() * 900;
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
    size: 2.2,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true
  });

  return new THREE.Points(geometry, material);
}
