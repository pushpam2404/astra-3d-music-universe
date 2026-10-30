// src/renderer/shaders/solarPlasmaShader.js
import * as THREE from 'three';

export const SolarPlasmaVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying vec3 vLocal;
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
    vLocal = normalize(position);
    vNormal = normalize(normalMatrix * normal);

    // Subtle surface banding noise without vertex displacement so the planet silhouette & border stay razor-sharp
    float n1 = snoise(vLocal * 2.2 + vec3(uTime * 0.08));
    float n2 = 0.5 * snoise(vLocal * 4.5 - vec3(uTime * 0.12));
    vNoise = (n1 + n2);

    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vPosition = mvPos.xyz;
    gl_Position = projectionMatrix * mvPos;
    vClipPos = gl_Position;
  }
`;

export const SolarPlasmaFragmentShader = /* glsl */ `
  uniform vec3 uPrimaryColor;
  uniform vec3 uCoreColor;
  uniform float uOpacity;
  // 0 = full sun, 1 = quiet matte background sphere (eased in JS so dimming fades, not snaps).
  // The sphere stays 100% opaque either way (invariant 3.3): "fading" means losing its glow and
  // darkening toward the background, never alpha.
  uniform float uDim;
  
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying vec3 vLocal;
  varying vec4 vClipPos;
  varying float vNoise;

  void main() {

    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(-vPosition);
    float ndotv = max(0.0, dot(normal, viewDir));

    // Glowing central cluster Sun / Core: radiant stellar plasma with incandescent core
    vec3 keyLight = normalize(vec3(0.42, 0.72, 0.55));
    float diff = smoothstep(-0.25, 0.85, dot(normal, keyLight));
    vec3 halfVec = normalize(keyLight + viewDir);
    float spec = pow(max(0.0, dot(normal, halfVec)), 28.0);

    float bands = sin(vLocal.y * 7.5 + vNoise * 1.8);
    vec3 surface = uPrimaryColor * (0.92 + 0.08 * bands + 0.08 * vNoise);

    // Radiant core emission: inner incandescent stellar brightness
    float coreLuminance = pow(ndotv, 1.35);
    vec3 incandescent = mix(uPrimaryColor, uCoreColor, coreLuminance * 0.62 + 0.12 * vNoise);

    // Energetic solar limb flare
    float rim = pow(1.0 - ndotv, 2.2);
    float luma = dot(uPrimaryColor, vec3(0.299, 0.587, 0.114));

    // Everything that makes a sun glow (incandescent core, limb flare, specular) fades out as it dims
    float lit = 1.0 - uDim;
    vec3 sunColor = surface * (0.65 + 0.40 * diff)
                  + (incandescent * (0.45 + 0.45 * coreLuminance)
                     + uPrimaryColor * rim * 0.48
                     + mix(uPrimaryColor, vec3(1.0), 0.6) * spec * 0.25) * lit;

    // Dimmed (unselected / no lens match): a darker, slightly desaturated matte sphere.
    // Never pitch black, so the cluster still reads as a landmark behind the selection.
    vec3 matte = mix(vec3(luma), sunColor, 0.7) * 0.40;
    sunColor = mix(sunColor, matte, uDim);

    // Crisp black border around the silhouette (strongest on light-colored clusters so they stand out clearly)
    float maxCh = max(uPrimaryColor.r, max(uPrimaryColor.g, uPrimaryColor.b));
    float isLight = smoothstep(0.30, 0.55, max(luma, maxCh * 0.82));

    float radial = sqrt(max(0.0, 1.0 - ndotv * ndotv));
    float px = max(0.012, fwidth(radial));
    float borderWidth = mix(0.040, 0.085, isLight) + px * 1.2;
    float borderMask = smoothstep(1.0 - borderWidth - px * 0.85, 1.0 - borderWidth + px * 0.35, radial);
    vec3 borderColor = vec3(0.012, 0.014, 0.024);
    sunColor = mix(sunColor, borderColor, borderMask * mix(0.65, 0.94, isLight));

    gl_FragColor = vec4(sunColor, 1.0);
  }
`;

export function createSolarShaderMaterial(hexColor, energy = 0.8) {
  return new THREE.ShaderMaterial({
    vertexShader: SolarPlasmaVertexShader,
    fragmentShader: SolarPlasmaFragmentShader,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0.0 },
      uEnergy: { value: energy },
      uOpacity: { value: 1.0 },
      uDim: { value: 0.0 },
      uPrimaryColor: { value: new THREE.Color(hexColor) },
      uCoreColor: { value: new THREE.Color('#FFF6E0') }
    }
  });
}
