// src/renderer/shaders/solarPlasmaShader.js
import * as THREE from 'three';

export const SolarPlasmaVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying vec4 vClipPos;
  varying float vNoise;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    vNormal = normalize(normalMatrix * normal);
    
    float n1 = snoise(position * 0.45 + vec3(uTime * 0.35));
    float n2 = 0.5 * snoise(position * 0.9 - vec3(uTime * 0.6));
    vNoise = (n1 + n2);

    float displacement = vNoise * (0.04 + 0.07 * uEnergy);
    vec3 newPosition = position + normal * displacement;
    vPosition = (modelViewMatrix * vec4(newPosition, 1.0)).xyz;

    gl_Position = projectionMatrix * vec4(vPosition, 1.0);
    vClipPos = gl_Position;
  }
`;

export const SolarPlasmaFragmentShader = /* glsl */ `
  uniform vec3 uPrimaryColor;
  uniform vec3 uCoreColor;
  uniform float uOpacity;
  
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying vec4 vClipPos;
  varying float vNoise;

  void main() {
    vec3 viewDir = normalize(-vPosition);
    float ndotv = max(0.0, dot(vNormal, viewDir));

    // Radial star glow: warm luminous core that feathers smoothly toward the edge
    // so cluster centers shine like stars without ever forming a hard-edged opaque blocker!
    float coreShine = pow(ndotv, 1.85);
    float softHalo = pow(ndotv, 0.85);
    float heat = smoothstep(-0.4, 0.85, vNoise) * 0.38;

    vec3 starColor = mix(uPrimaryColor, uCoreColor, coreShine * 0.52 + heat * 0.25);

    float camDist = length(vPosition);
    float nearFade = smoothstep(8.0, 48.0, camDist);
    float alpha = softHalo * clamp(uOpacity, 0.12, 0.88) * nearFade;

    gl_FragColor = vec4(starColor * (0.75 + 0.55 * coreShine), alpha);
  }
`;

export function createSolarShaderMaterial(hexColor, energy = 0.8) {
  return new THREE.ShaderMaterial({
    vertexShader: SolarPlasmaVertexShader,
    fragmentShader: SolarPlasmaFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0.0 },
      uEnergy: { value: energy },
      uOpacity: { value: 1.0 },
      uPrimaryColor: { value: new THREE.Color(hexColor) },
      uCoreColor: { value: new THREE.Color('#FFF6E0') }
    }
  });
}
