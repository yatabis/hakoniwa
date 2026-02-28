import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { toIndex } from '../core/grid';

const MAX_CANOPY_TREES = 6_800;
const MAX_SHRUBS = 9_600;
const MAX_GRASS_PATCHES = 14_000;
const TAU = Math.PI * 2;
const SKY_DAY = new THREE.Color('#bccbc4');
const SKY_DAWN = new THREE.Color('#c6aa8d');
const SKY_DUSK = new THREE.Color('#c59d7f');
const SKY_NIGHT = new THREE.Color('#2f4353');
const SKY_STORM = new THREE.Color('#7e8f91');
const FOG_DAY = new THREE.Color('#d4ddd2');
const FOG_DAWN = new THREE.Color('#ccbba2');
const FOG_NIGHT = new THREE.Color('#3b4e59');
const FOG_STORM = new THREE.Color('#8b9b97');
const HEMI_GROUND_DAY = new THREE.Color('#5f725f');
const PHOTO_FOV_MIN = 30;
const PHOTO_FOV_MAX = 78;
const PHOTO_DOF_MIN = 0;
const PHOTO_DOF_MAX = 1;
const RAIN_PARTICLE_COUNT = 2_400;
const RAIN_AREA_RADIUS = 82;
const RAIN_TOP_OFFSET = 54;
const RAIN_BOTTOM_OFFSET = -14;
const WATER_RAIN_SPLASH_SCALE = 0.33;

type VegetationMaterialLook = {
  toneDark: string;
  toneLight: string;
  emissive: number;
};

type VegetationRenderCounts = {
  canopy: number;
  shrub: number;
  grass: number;
  total: number;
};

type WindVegetationMaterial = THREE.MeshStandardMaterial & {
  userData: {
    shader?: {
      uniforms: Record<string, THREE.IUniform<unknown>>;
    };
    windStrength: number;
    windSpeed: number;
    windBend: number;
    look: VegetationMaterialLook;
  };
};

type WindDiagnostics = {
  atmosphereWindStrength: number;
  atmosphereWindDirection: number;
  atmosphereWindGustiness: number;
  appliedUniformStrength: number;
  appliedUniformSpeed: number;
  appliedUniformGustiness: number;
  rainVisible: boolean;
  rainDriftX: number;
  rainDriftZ: number;
};

function hash2D(x: number, y: number, seed: number): number {
  const value = Math.sin((x + seed * 0.001) * 12.9898 + (y - seed * 0.001) * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function phaseWeight(phase: number, center: number, width: number): number {
  const wrapped = phase - Math.floor(phase);
  const distance = Math.abs(((wrapped - center + 0.5) % 1) - 0.5);
  const normalized = THREE.MathUtils.clamp(1 - distance / Math.max(width, 0.0001), 0, 1);
  return normalized * normalized;
}

function setWeightedColor(
  target: THREE.Color,
  a: THREE.Color,
  wa: number,
  b: THREE.Color,
  wb: number,
  c: THREE.Color,
  wc: number,
  d: THREE.Color,
  wd: number
): THREE.Color {
  target.setRGB(
    a.r * wa + b.r * wb + c.r * wc + d.r * wd,
    a.g * wa + b.g * wb + c.g * wc + d.g * wd,
    a.b * wa + b.b * wb + c.b * wc + d.b * wd
  );
  return target;
}

function createGridGeometry(size: number, withColors = false): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertexCount = size * size;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = withColors ? new Float32Array(vertexCount * 3) : undefined;
  const half = (size - 1) * 0.5;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = toIndex(size, x, y);
      const positionOffset = index * 3;
      const uvOffset = index * 2;

      positions[positionOffset] = x - half;
      positions[positionOffset + 1] = 0;
      positions[positionOffset + 2] = y - half;

      uvs[uvOffset] = x / (size - 1);
      uvs[uvOffset + 1] = y / (size - 1);

      if (colors) {
        colors[positionOffset] = 0.6;
        colors[positionOffset + 1] = 0.58;
        colors[positionOffset + 2] = 0.52;
      }
    }
  }

  const indexCount = (size - 1) * (size - 1) * 6;
  const indices = new Uint32Array(indexCount);
  let writeHead = 0;

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const a = toIndex(size, x, y);
      const b = toIndex(size, x + 1, y);
      const c = toIndex(size, x, y + 1);
      const d = toIndex(size, x + 1, y + 1);

      indices[writeHead] = a;
      indices[writeHead + 1] = c;
      indices[writeHead + 2] = b;
      indices[writeHead + 3] = b;
      indices[writeHead + 4] = c;
      indices[writeHead + 5] = d;
      writeHead += 6;
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (colors) {
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function updateTerrainColors(geometry: THREE.BufferGeometry, terrain: Float32Array): void {
  const colorAttr = geometry.getAttribute('color');
  if (!(colorAttr instanceof THREE.BufferAttribute)) {
    return;
  }

  const colors = colorAttr.array as Float32Array;
  const low = new THREE.Color('#6f8d58');
  const mid = new THREE.Color('#9ebc73');
  const high = new THREE.Color('#d9c79a');
  const mixed = new THREE.Color();
  for (let index = 0; index < terrain.length; index += 1) {
    const colorOffset = index * 3;
    const height = terrain[index];
    const normalized = THREE.MathUtils.clamp((height + 10) / 30, 0, 1);
    if (normalized < 0.45) {
      mixed.copy(low).lerp(mid, normalized / 0.45);
    } else {
      mixed.copy(mid).lerp(high, (normalized - 0.45) / 0.55);
    }

    colors[colorOffset] = mixed.r;
    colors[colorOffset + 1] = mixed.g;
    colors[colorOffset + 2] = mixed.b;
  }

  colorAttr.needsUpdate = true;
}

function computeSlope(terrain: Float32Array, size: number, x: number, y: number): number {
  const left = terrain[toIndex(size, Math.max(0, x - 1), y)];
  const right = terrain[toIndex(size, Math.min(size - 1, x + 1), y)];
  const down = terrain[toIndex(size, x, Math.max(0, y - 1))];
  const up = terrain[toIndex(size, x, Math.min(size - 1, y + 1))];
  const dx = (right - left) * 0.5;
  const dy = (up - down) * 0.5;
  return Math.sqrt(dx * dx + dy * dy);
}

function createWindVegetationMaterial(
  color: string,
  roughness: number,
  metalness: number,
  windStrength: number,
  windSpeed: number,
  windBend: number,
  look: VegetationMaterialLook
): WindVegetationMaterial {
  const baseColor = new THREE.Color(color);
  const toneDark = new THREE.Color(look.toneDark);
  const toneLight = new THREE.Color(look.toneLight);
  const leafColor = baseColor.clone().lerp(toneLight, 0.34);
  const emissiveColor = toneDark.clone().lerp(toneLight, 0.24);
  const material = new THREE.MeshStandardMaterial({
    color: leafColor,
    roughness,
    metalness,
    flatShading: false,
    vertexColors: false,
    emissive: emissiveColor,
    emissiveIntensity: THREE.MathUtils.clamp(look.emissive, 0, 1)
  }) as WindVegetationMaterial;

  material.userData.windStrength = windStrength;
  material.userData.windSpeed = windSpeed;
  material.userData.windBend = windBend;
  material.userData.look = look;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = { value: 0 };
    shader.uniforms.uWindStrength = { value: material.userData.windStrength };
    shader.uniforms.uWindSpeed = { value: material.userData.windSpeed };
    shader.uniforms.uWindBend = { value: material.userData.windBend };
    shader.uniforms.uWindDirection = { value: new THREE.Vector2(1, 0) };
    shader.uniforms.uWindGustiness = { value: 0.35 };
    shader.vertexShader = `
      uniform float uWindTime;
      uniform float uWindStrength;
      uniform float uWindSpeed;
      uniform float uWindBend;
      uniform vec2 uWindDirection;
      uniform float uWindGustiness;
    ${shader.vertexShader}
    `;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      float windHeight = smoothstep(-0.35, 0.95, position.y);
      float windFlex = windHeight * windHeight;
      float windPhase = instanceMatrix[3].x * 0.23 + instanceMatrix[3].z * 0.19;
      float swayA = sin(windPhase + uWindTime * uWindSpeed);
      float swayB = sin(windPhase * 1.61 - uWindTime * (uWindSpeed * 0.74));
      float swayC = cos(windPhase * 2.07 + uWindTime * (uWindSpeed * 1.36));
      float gustPulse = sin(windPhase * 2.11 + uWindTime * (uWindSpeed * 1.9));
      float gustScale = mix(0.84, 1.34, gustPulse * 0.5 + 0.5);
      float primarySwing = (swayA * 0.62 + swayB * 0.38) * windFlex * uWindStrength;
      float secondarySwing = swayC * windFlex * uWindStrength * 0.64;
      float leafFlutter = sin((windPhase + position.y * 3.2) * 2.4 + uWindTime * (uWindSpeed * 2.8));
      float flutterSwing = leafFlutter * windHeight * uWindStrength * 0.22;
      float dirLength = max(length(uWindDirection), 0.0001);
      vec2 windDir = uWindDirection / dirLength;
      vec2 crossDir = vec2(-windDir.y, windDir.x);
      float gustMix = mix(1.0, gustScale, uWindGustiness);
      float alongSwing = (primarySwing * 1.28 + flutterSwing) * gustMix;
      float crossSwing = secondarySwing * mix(0.68, 1.14, uWindGustiness);
      vec2 windOffset = windDir * alongSwing + crossDir * crossSwing;
      transformed.x += windOffset.x * (uWindBend * 2.35);
      transformed.z += windOffset.y * (uWindBend * 2.16);
      transformed.y -= (abs(alongSwing) + abs(crossSwing)) * uWindBend * 0.15 * windFlex;
      `
    );
    material.userData.shader = shader;
  };

  return material;
}

function createWaterMaterial(): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform<unknown>> = {
    uTime: { value: 0 },
    uDaylight: { value: 1 },
    uCloudiness: { value: 0 },
    uRainIntensity: { value: 0 },
    uRainSplashScale: { value: WATER_RAIN_SPLASH_SCALE },
    uDeepColor: { value: new THREE.Color('#3f7896') },
    uShallowColor: { value: new THREE.Color('#82b7cf') },
    uFoamColor: { value: new THREE.Color('#d9eef8') }
  };

  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: true,
    vertexShader: `
      attribute vec2 flow;
      attribute vec3 waterData;
      varying vec2 vUv;
      varying vec2 vFlow;
      varying vec3 vWaterData;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      void main() {
        vUv = uv;
        vFlow = flow;
        vWaterData = waterData;

        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPosition.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uDaylight;
      uniform float uCloudiness;
      uniform float uRainIntensity;
      uniform float uRainSplashScale;
      uniform vec3 uDeepColor;
      uniform vec3 uShallowColor;
      uniform vec3 uFoamColor;
      varying vec2 vUv;
      varying vec2 vFlow;
      varying vec3 vWaterData;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float ripplePattern(vec2 p) {
        float waveA = sin(p.x * 6.28318 + sin(p.y * 2.7));
        float waveB = sin((p.x + p.y) * 4.9 + cos(p.x * 1.9));
        float grain = hash(floor(p * 0.7) + floor(p * 2.3));
        return (waveA * 0.5 + waveB * 0.5) * 0.25 + 0.5 + (grain - 0.5) * 0.18;
      }

      float rainSplashLayer(vec2 p, float time, float cellScale, float speedScale) {
        vec2 scaled = p * cellScale;
        vec2 cell = floor(scaled);
        vec2 local = fract(scaled) - 0.5;
        float cellSeed = hash(cell + vec2(19.3, 43.7));
        float cycle = fract(time * speedScale + cellSeed * 7.13);
        float radius = cycle * 0.44;
        float ring = smoothstep(0.055, 0.0, abs(length(local) - radius));
        float pulse = (1.0 - cycle) * (0.55 + cellSeed * 0.45);
        return ring * pulse;
      }

      void main() {
        float depth = clamp(vWaterData.x, 0.0, 1.0);
        float flowStrength = clamp(vWaterData.y, 0.0, 1.0);
        float rapidness = clamp(vWaterData.z, 0.0, 1.0);
        float storminess = clamp(uCloudiness * 0.65 + uRainIntensity * 0.8, 0.0, 1.0);

        vec2 flowDir = length(vFlow) > 0.0001 ? normalize(vFlow) : vec2(0.0);
        float speed = mix(0.08, 0.85, flowStrength) * (1.0 + uRainIntensity * 0.45 + rapidness * 0.28);
        vec2 baseUv = vUv * mix(15.0, 22.0, storminess);

        vec2 uvA = baseUv + flowDir * (uTime * speed) + vec2(uTime * 0.02, -uTime * 0.015);
        vec2 uvB = baseUv * 1.73 + vec2(-flowDir.y, flowDir.x) * (uTime * speed * 0.8);

        float ripA = ripplePattern(uvA);
        float ripB = ripplePattern(uvB + ripA * 0.45);
        float ripple = mix(ripA, ripB, 0.5);
        float rapidPulse = ripplePattern(baseUv * 2.35 + vec2(uTime * 1.35, -uTime * 1.1));
        float rainMask = smoothstep(0.12, 1.0, uRainIntensity);
        float rainSplashA = rainSplashLayer(vWorldPos.xz + vec2(uTime * 0.23, -uTime * 0.29), uTime, 0.9, 1.2);
        float rainSplashB = rainSplashLayer(vWorldPos.xz + vec2(-uTime * 0.18, uTime * 0.15), uTime * 0.93, 1.45, 0.9);
        float rainSplash = (rainSplashA + rainSplashB) * rainMask * uRainSplashScale;

        float foam = smoothstep(0.42, 1.0, flowStrength) * (0.28 + ripple * 0.72);
        float rapidFoam = smoothstep(0.1, 1.0, rapidness) * (0.36 + rapidPulse * 0.64);
        foam = max(foam, rapidFoam);
        foam *= (1.0 + uRainIntensity * 0.65);
        float turbidity = clamp((1.0 - depth) * 0.6 + flowStrength * 0.55 + storminess * 0.35 + rapidness * 0.3, 0.0, 1.0);

        vec3 normalDir = normalize(vWorldNormal);
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float fresnel = pow(1.0 - max(dot(normalDir, viewDir), 0.0), 2.6);

        vec3 baseColor = mix(uShallowColor, uDeepColor, depth);
        baseColor = mix(baseColor, vec3(0.53, 0.62, 0.58), turbidity * 0.22);
        baseColor = mix(baseColor, vec3(0.74, 0.82, 0.85), rapidness * 0.14);
        baseColor *= mix(0.72, 1.08, uDaylight);
        vec3 color = baseColor;
        color += vec3(ripple * (0.06 + flowStrength * 0.09));
        color += uFoamColor * foam * (0.22 + flowStrength * 0.38 + rapidness * 0.3);
        color += vec3(rapidPulse * rapidness * 0.07);
        color += uFoamColor * (rainSplash * (0.24 + (1.0 - depth) * 0.32));
        color += vec3(fresnel * (0.08 + uDaylight * 0.08));
        color = mix(color, color * vec3(0.92, 0.95, 1.03), storminess * 0.25);

        float alpha = clamp(depth * 0.64 + flowStrength * 0.3 + rapidness * 0.1 + fresnel * 0.1 + storminess * 0.08 + rainSplash * 0.08, 0.0, 0.9);
        if (alpha < 0.03) {
          discard;
        }

        gl_FragColor = vec4(color, alpha);
      }
    `
  });
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;

  private readonly container: HTMLElement;
  private readonly size: number;
  private readonly renderPass: RenderPass;
  private readonly bokehPass: BokehPass;
  private readonly outputPass: OutputPass;
  private readonly terrainGeometry: THREE.BufferGeometry;
  private readonly waterGeometry: THREE.BufferGeometry;
  private readonly terrainMesh: THREE.Mesh;
  private readonly waterMesh: THREE.Mesh;
  private readonly waterMaterial: THREE.ShaderMaterial;
  private readonly riverGuideGeometry: THREE.BufferGeometry;
  private readonly riverGuideMesh: THREE.LineSegments;
  private readonly maxRiverGuideSegments: number;
  private readonly riverGuidePositions: Float32Array;
  private readonly riverGuideColors: Float32Array;
  private readonly riverGuidePositionAttr: THREE.BufferAttribute;
  private readonly riverGuideColorAttr: THREE.BufferAttribute;
  private readonly rainGeometry: THREE.BufferGeometry;
  private readonly rainMesh: THREE.LineSegments;
  private readonly rainMaterial: THREE.LineBasicMaterial;
  private readonly rainPositions: Float32Array;
  private readonly rainPositionAttr: THREE.BufferAttribute;
  private readonly rainOffsets: Float32Array;
  private readonly rainHeights: Float32Array;
  private readonly rainSpeeds: Float32Array;
  private readonly rainLengths: Float32Array;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly moonLight: THREE.DirectionalLight;
  private readonly canopyConiferLeafMesh: THREE.InstancedMesh;
  private readonly canopyBroadleafLeafMesh: THREE.InstancedMesh;
  private readonly canopyTrunkMesh: THREE.InstancedMesh;
  private readonly shrubRoundLeafMesh: THREE.InstancedMesh;
  private readonly shrubTuftLeafMesh: THREE.InstancedMesh;
  private readonly shrubTrunkMesh: THREE.InstancedMesh;
  private readonly grassMesh: THREE.InstancedMesh;
  private readonly canopyConiferMaterial: WindVegetationMaterial;
  private readonly canopyBroadleafMaterial: WindVegetationMaterial;
  private readonly canopyTrunkMaterial: THREE.MeshStandardMaterial;
  private readonly shrubRoundMaterial: WindVegetationMaterial;
  private readonly shrubTuftMaterial: WindVegetationMaterial;
  private readonly shrubTrunkMaterial: THREE.MeshStandardMaterial;
  private readonly grassMaterial: WindVegetationMaterial;
  private readonly windVegetationMaterials: WindVegetationMaterial[];
  private readonly staticVegetationMaterials: THREE.MeshStandardMaterial[];
  private readonly vegetationDummy: THREE.Object3D;
  private readonly vegetationColor: THREE.Color;
  private readonly tempColorA: THREE.Color;
  private readonly tempColorB: THREE.Color;
  private readonly tempColorC: THREE.Color;
  private vegetationCounts: VegetationRenderCounts;
  private atmosphereRainIntensity: number;
  private atmosphereWindStrength: number;
  private atmosphereWindDirection: number;
  private atmosphereWindGustiness: number;
  private readonly windDirectionVector: THREE.Vector2;
  private previousFrameTime: number;
  private readonly onResizeBound: () => void;

  constructor(container: HTMLElement, size: number) {
    this.container = container;
    this.size = size;
    this.vegetationDummy = new THREE.Object3D();
    this.vegetationColor = new THREE.Color();
    this.tempColorA = new THREE.Color();
    this.tempColorB = new THREE.Color();
    this.tempColorC = new THREE.Color();
    this.vegetationCounts = { canopy: 0, shrub: 0, grass: 0, total: 0 };
    this.atmosphereRainIntensity = 0;
    this.atmosphereWindStrength = 0.35;
    this.atmosphereWindDirection = 0;
    this.atmosphereWindGustiness = 0.3;
    this.windDirectionVector = new THREE.Vector2(1, 0);
    this.previousFrameTime = performance.now() * 0.001;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#b9b6a6');
    this.scene.fog = new THREE.Fog('#c4cbc0', 120, 340);

    this.camera = new THREE.PerspectiveCamera(
      52,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      300
    );
    this.camera.position.set(34, 32, 40);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bokehPass = new BokehPass(this.scene, this.camera, {
      focus: 30,
      aperture: 0.00008,
      maxblur: 0.0035
    });
    this.bokehPass.enabled = false;
    this.composer.addPass(this.bokehPass);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 8;
    this.controls.maxDistance = 110;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;

    this.hemiLight = new THREE.HemisphereLight('#f3dcc0', '#55635a', 0.64);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight('#f4ead0', 0.74);
    this.sunLight.position.set(45, 70, 25);
    this.scene.add(this.sunLight);

    this.moonLight = new THREE.DirectionalLight('#8db2d4', 0.2);
    this.moonLight.position.set(-40, 44, -24);
    this.scene.add(this.moonLight);

    this.terrainGeometry = createGridGeometry(size, true);
    const terrainMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.9,
      metalness: 0.02
    });
    this.terrainMesh = new THREE.Mesh(this.terrainGeometry, terrainMaterial);
    this.terrainMesh.frustumCulled = false;
    this.scene.add(this.terrainMesh);

    this.waterGeometry = createGridGeometry(size);
    const vertexCount = size * size;
    this.waterGeometry.setAttribute(
      'flow',
      new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2)
    );
    this.waterGeometry.setAttribute(
      'waterData',
      new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3)
    );
    this.waterMaterial = createWaterMaterial();
    this.waterMesh = new THREE.Mesh(this.waterGeometry, this.waterMaterial);
    this.waterMesh.frustumCulled = false;
    this.waterMesh.renderOrder = 2;
    this.scene.add(this.waterMesh);

    this.riverGuideGeometry = new THREE.BufferGeometry();
    this.maxRiverGuideSegments = Math.ceil(((size - 2) * (size - 2)) / 2);
    const riverGuideFloatSize = this.maxRiverGuideSegments * 6;
    this.riverGuidePositions = new Float32Array(riverGuideFloatSize);
    this.riverGuideColors = new Float32Array(riverGuideFloatSize);
    this.riverGuidePositionAttr = new THREE.BufferAttribute(this.riverGuidePositions, 3);
    this.riverGuideColorAttr = new THREE.BufferAttribute(this.riverGuideColors, 3);
    this.riverGuidePositionAttr.setUsage(THREE.DynamicDrawUsage);
    this.riverGuideColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.riverGuideGeometry.setAttribute('position', this.riverGuidePositionAttr);
    this.riverGuideGeometry.setAttribute('color', this.riverGuideColorAttr);
    this.riverGuideGeometry.setDrawRange(0, 0);
    const riverGuideMaterial = new THREE.LineBasicMaterial({
      color: '#8bd4eb',
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      vertexColors: true
    });
    this.riverGuideMesh = new THREE.LineSegments(this.riverGuideGeometry, riverGuideMaterial);
    this.riverGuideMesh.renderOrder = 4;
    this.riverGuideMesh.frustumCulled = false;
    this.scene.add(this.riverGuideMesh);

    this.rainGeometry = new THREE.BufferGeometry();
    this.rainPositions = new Float32Array(RAIN_PARTICLE_COUNT * 6);
    this.rainPositionAttr = new THREE.BufferAttribute(this.rainPositions, 3);
    this.rainPositionAttr.setUsage(THREE.DynamicDrawUsage);
    this.rainGeometry.setAttribute('position', this.rainPositionAttr);
    this.rainOffsets = new Float32Array(RAIN_PARTICLE_COUNT * 2);
    this.rainHeights = new Float32Array(RAIN_PARTICLE_COUNT);
    this.rainSpeeds = new Float32Array(RAIN_PARTICLE_COUNT);
    this.rainLengths = new Float32Array(RAIN_PARTICLE_COUNT);
    for (let index = 0; index < RAIN_PARTICLE_COUNT; index += 1) {
      const offsetIndex = index * 2;
      this.rainOffsets[offsetIndex] = (Math.random() - 0.5) * RAIN_AREA_RADIUS * 2;
      this.rainOffsets[offsetIndex + 1] = (Math.random() - 0.5) * RAIN_AREA_RADIUS * 2;
      this.rainHeights[index] =
        RAIN_BOTTOM_OFFSET + Math.random() * (RAIN_TOP_OFFSET - RAIN_BOTTOM_OFFSET);
      this.rainSpeeds[index] = 17 + Math.random() * 24;
      this.rainLengths[index] = 0.5 + Math.random() * 1.05;
    }
    this.rainMaterial = new THREE.LineBasicMaterial({
      color: '#c0dcef',
      transparent: true,
      opacity: 0,
      depthWrite: false
    });
    this.rainMesh = new THREE.LineSegments(this.rainGeometry, this.rainMaterial);
    this.rainMesh.renderOrder = 6;
    this.rainMesh.frustumCulled = false;
    this.rainMesh.visible = false;
    this.scene.add(this.rainMesh);

    const canopyConiferGeometry = new THREE.ConeGeometry(0.48, 1.85, 7);
    const canopyBroadleafGeometry = new THREE.IcosahedronGeometry(0.86, 0);
    const canopyTrunkGeometry = new THREE.CylinderGeometry(0.07, 0.11, 1.14, 6);
    const shrubRoundGeometry = new THREE.IcosahedronGeometry(0.48, 0);
    const shrubTuftGeometry = new THREE.ConeGeometry(0.5, 0.84, 7);
    const shrubTrunkGeometry = new THREE.CylinderGeometry(0.05, 0.08, 0.46, 6);
    const grassGeometry = new THREE.ConeGeometry(0.2, 0.55, 4);

    this.canopyConiferMaterial = createWindVegetationMaterial(
      '#477347',
      0.82,
      0.03,
      0.46,
      0.88,
      0.22,
      {
        toneDark: '#355f37',
        toneLight: '#80b06e',
        emissive: 0.22
      }
    );
    this.canopyBroadleafMaterial = createWindVegetationMaterial(
      '#4f7b4d',
      0.8,
      0.03,
      0.54,
      1.05,
      0.26,
      {
        toneDark: '#40603e',
        toneLight: '#8dbd76',
        emissive: 0.24
      }
    );
    this.canopyTrunkMaterial = new THREE.MeshStandardMaterial({
      color: '#644f3b',
      roughness: 0.95,
      metalness: 0.01,
      flatShading: true,
      vertexColors: true
    });
    this.shrubRoundMaterial = createWindVegetationMaterial(
      '#63834d',
      0.87,
      0.02,
      0.42,
      1.18,
      0.18,
      {
        toneDark: '#4e703f',
        toneLight: '#9cbf75',
        emissive: 0.2
      }
    );
    this.shrubTuftMaterial = createWindVegetationMaterial('#5f7f4d', 0.88, 0.02, 0.39, 1.34, 0.17, {
      toneDark: '#4a6a3b',
      toneLight: '#90b26e',
      emissive: 0.19
    });
    this.shrubTrunkMaterial = new THREE.MeshStandardMaterial({
      color: '#5f4733',
      roughness: 0.94,
      metalness: 0.01,
      flatShading: true,
      vertexColors: true
    });
    this.grassMaterial = createWindVegetationMaterial('#7c9357', 0.93, 0.02, 0.5, 1.42, 0.18, {
      toneDark: '#5c7f44',
      toneLight: '#a8be7d',
      emissive: 0.16
    });
    this.windVegetationMaterials = [
      this.canopyConiferMaterial,
      this.canopyBroadleafMaterial,
      this.shrubRoundMaterial,
      this.shrubTuftMaterial,
      this.grassMaterial
    ];
    this.staticVegetationMaterials = [this.canopyTrunkMaterial, this.shrubTrunkMaterial];

    const setupInstancedMesh = (mesh: THREE.InstancedMesh, maxCount: number): void => {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      this.scene.add(mesh);
    };

    this.canopyConiferLeafMesh = new THREE.InstancedMesh(
      canopyConiferGeometry,
      this.canopyConiferMaterial,
      MAX_CANOPY_TREES
    );
    setupInstancedMesh(this.canopyConiferLeafMesh, MAX_CANOPY_TREES);

    this.canopyBroadleafLeafMesh = new THREE.InstancedMesh(
      canopyBroadleafGeometry,
      this.canopyBroadleafMaterial,
      MAX_CANOPY_TREES
    );
    setupInstancedMesh(this.canopyBroadleafLeafMesh, MAX_CANOPY_TREES);

    this.canopyTrunkMesh = new THREE.InstancedMesh(
      canopyTrunkGeometry,
      this.canopyTrunkMaterial,
      MAX_CANOPY_TREES
    );
    setupInstancedMesh(this.canopyTrunkMesh, MAX_CANOPY_TREES);

    this.shrubRoundLeafMesh = new THREE.InstancedMesh(
      shrubRoundGeometry,
      this.shrubRoundMaterial,
      MAX_SHRUBS
    );
    setupInstancedMesh(this.shrubRoundLeafMesh, MAX_SHRUBS);

    this.shrubTuftLeafMesh = new THREE.InstancedMesh(
      shrubTuftGeometry,
      this.shrubTuftMaterial,
      MAX_SHRUBS
    );
    setupInstancedMesh(this.shrubTuftLeafMesh, MAX_SHRUBS);

    this.shrubTrunkMesh = new THREE.InstancedMesh(
      shrubTrunkGeometry,
      this.shrubTrunkMaterial,
      MAX_SHRUBS
    );
    setupInstancedMesh(this.shrubTrunkMesh, MAX_SHRUBS);

    this.grassMesh = new THREE.InstancedMesh(grassGeometry, this.grassMaterial, MAX_GRASS_PATCHES);
    setupInstancedMesh(this.grassMesh, MAX_GRASS_PATCHES);

    this.onResizeBound = this.onResize.bind(this);
    window.addEventListener('resize', this.onResizeBound);
  }

  getTerrainMesh(): THREE.Mesh {
    return this.terrainMesh;
  }

  getVegetationCounts(): VegetationRenderCounts {
    return { ...this.vegetationCounts };
  }

  getWindDiagnostics(): WindDiagnostics {
    let appliedUniformStrength = 0;
    let appliedUniformSpeed = 0;
    let appliedUniformGustiness = 0;

    for (const material of this.windVegetationMaterials) {
      const shader = material.userData.shader;
      if (!shader) {
        continue;
      }

      const strengthUniform = shader.uniforms.uWindStrength as THREE.IUniform<number> | undefined;
      const speedUniform = shader.uniforms.uWindSpeed as THREE.IUniform<number> | undefined;
      const gustUniform = shader.uniforms.uWindGustiness as THREE.IUniform<number> | undefined;

      appliedUniformStrength = strengthUniform?.value ?? 0;
      appliedUniformSpeed = speedUniform?.value ?? 0;
      appliedUniformGustiness = gustUniform?.value ?? 0;
      break;
    }

    const rainDriftX =
      this.rainPositions.length >= 6 ? this.rainPositions[3] - this.rainPositions[0] : 0;
    const rainDriftZ =
      this.rainPositions.length >= 6 ? this.rainPositions[5] - this.rainPositions[2] : 0;

    return {
      atmosphereWindStrength: this.atmosphereWindStrength,
      atmosphereWindDirection: this.atmosphereWindDirection,
      atmosphereWindGustiness: this.atmosphereWindGustiness,
      appliedUniformStrength,
      appliedUniformSpeed,
      appliedUniformGustiness,
      rainVisible: this.rainMesh.visible,
      rainDriftX,
      rainDriftZ
    };
  }

  setPhotoMode(enabled: boolean): void {
    this.bokehPass.enabled = enabled;
  }

  setPhotoFov(value: number): number {
    const fov = THREE.MathUtils.clamp(value, PHOTO_FOV_MIN, PHOTO_FOV_MAX);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    return fov;
  }

  setPhotoDepthBlur(value: number): number {
    const dof = THREE.MathUtils.clamp(value, PHOTO_DOF_MIN, PHOTO_DOF_MAX);
    const uniforms = this.bokehPass.uniforms as Record<string, { value: number }>;
    uniforms.focus.value = THREE.MathUtils.lerp(18, 70, 1 - dof);
    uniforms.aperture.value = THREE.MathUtils.lerp(0.00001, 0.00016, dof);
    uniforms.maxblur.value = THREE.MathUtils.lerp(0.0012, 0.008, dof);
    return dof;
  }

  captureScreenshot(type = 'image/png', quality?: number): string {
    this.render();
    return this.renderer.domElement.toDataURL(type, quality);
  }

  setRiverGuideVisible(visible: boolean): void {
    this.riverGuideMesh.visible = visible;
  }

  updateRiverGuide(terrain: Float32Array): void {
    const half = (this.size - 1) * 0.5;
    let segmentCount = 0;

    for (let y = 1; y < this.size - 1; y += 1) {
      for (let x = 1; x < this.size - 1; x += 1) {
        if ((x + y) % 2 !== 0) {
          continue;
        }

        const index = toIndex(this.size, x, y);
        const current = terrain[index];
        const right = terrain[toIndex(this.size, x + 1, y)];
        const left = terrain[toIndex(this.size, x - 1, y)];
        const up = terrain[toIndex(this.size, x, y + 1)];
        const down = terrain[toIndex(this.size, x, y - 1)];

        let targetX = x;
        let targetY = y;
        let targetHeight = current;

        if (right < targetHeight) {
          targetX = x + 1;
          targetY = y;
          targetHeight = right;
        }
        if (left < targetHeight) {
          targetX = x - 1;
          targetY = y;
          targetHeight = left;
        }
        if (up < targetHeight) {
          targetX = x;
          targetY = y + 1;
          targetHeight = up;
        }
        if (down < targetHeight) {
          targetX = x;
          targetY = y - 1;
          targetHeight = down;
        }

        const downhill = current - targetHeight;
        if (downhill < 0.1 || current < -8) {
          continue;
        }

        const strength = THREE.MathUtils.clamp((downhill - 0.1) / 1.4, 0, 1);
        const startX = x - half;
        const startY = current + 0.15;
        const startZ = y - half;
        const dirX = targetX - x;
        const dirZ = targetY - y;
        const endX = startX + dirX * 0.46;
        const endZ = startZ + dirZ * 0.46;
        const endY = targetHeight + 0.12;

        if (segmentCount >= this.maxRiverGuideSegments) {
          continue;
        }

        const writeOffset = segmentCount * 6;
        this.riverGuidePositions[writeOffset] = startX;
        this.riverGuidePositions[writeOffset + 1] = startY;
        this.riverGuidePositions[writeOffset + 2] = startZ;
        this.riverGuidePositions[writeOffset + 3] = endX;
        this.riverGuidePositions[writeOffset + 4] = endY;
        this.riverGuidePositions[writeOffset + 5] = endZ;

        const hueShift = THREE.MathUtils.lerp(0.34, 0.52, strength);
        const red = 0.42 + hueShift * 0.2;
        const green = 0.64 + strength * 0.28;
        const blue = 0.65 + strength * 0.26;
        this.riverGuideColors[writeOffset] = red;
        this.riverGuideColors[writeOffset + 1] = green;
        this.riverGuideColors[writeOffset + 2] = blue;
        this.riverGuideColors[writeOffset + 3] = red;
        this.riverGuideColors[writeOffset + 4] = green;
        this.riverGuideColors[writeOffset + 5] = blue;
        segmentCount += 1;
      }
    }

    this.riverGuideGeometry.setDrawRange(0, segmentCount * 2);
    this.riverGuidePositionAttr.needsUpdate = true;
    this.riverGuideColorAttr.needsUpdate = true;
  }

  updateTerrain(terrain: Float32Array): void {
    const position = this.terrainGeometry.getAttribute('position');
    if (!(position instanceof THREE.BufferAttribute)) {
      return;
    }

    const positions = position.array as Float32Array;
    for (let index = 0; index < terrain.length; index += 1) {
      positions[index * 3 + 1] = terrain[index];
    }

    position.needsUpdate = true;
    this.terrainGeometry.computeVertexNormals();
    updateTerrainColors(this.terrainGeometry, terrain);
  }

  updateWater(terrain: Float32Array, water: Float32Array): void {
    const position = this.waterGeometry.getAttribute('position');
    const flow = this.waterGeometry.getAttribute('flow');
    const waterData = this.waterGeometry.getAttribute('waterData');
    if (
      !(position instanceof THREE.BufferAttribute) ||
      !(flow instanceof THREE.BufferAttribute) ||
      !(waterData instanceof THREE.BufferAttribute)
    ) {
      return;
    }

    const positions = position.array as Float32Array;
    const flows = flow.array as Float32Array;
    const waterStats = waterData.array as Float32Array;
    let hasVisibleWater = false;
    const visibleThreshold = 0.008;
    const drySink = 0.08;

    for (let index = 0; index < water.length; index += 1) {
      const x = index % this.size;
      const y = (index - x) / this.size;
      const level = water[index];
      const visible = level > visibleThreshold;
      const flowOffset = index * 2;
      const statOffset = index * 3;
      if (visible) {
        hasVisibleWater = true;
      } else {
        positions[index * 3 + 1] = terrain[index] - drySink;
        flows[flowOffset] = 0;
        flows[flowOffset + 1] = 0;
        waterStats[statOffset] = 0;
        waterStats[statOffset + 1] = 0;
        waterStats[statOffset + 2] = 0;
        continue;
      }

      const total = terrain[index] + level;
      const rightTotal = x + 1 < this.size ? terrain[index + 1] + water[index + 1] : total;
      const leftTotal = x - 1 >= 0 ? terrain[index - 1] + water[index - 1] : total;
      const upTotal =
        y + 1 < this.size ? terrain[index + this.size] + water[index + this.size] : total;
      const downTotal = y - 1 >= 0 ? terrain[index - this.size] + water[index - this.size] : total;
      const lowestNeighborTotal = Math.min(rightTotal, leftTotal, upTotal, downTotal);

      const gradientX = rightTotal - leftTotal;
      const gradientY = upTotal - downTotal;
      let flowX = -gradientX;
      let flowY = -gradientY;
      const flowLength = Math.hypot(flowX, flowY);
      const gradientStrength = THREE.MathUtils.clamp(flowLength * 0.55, 0, 1);
      const flowStrength = THREE.MathUtils.clamp(gradientStrength * 0.82 + level * 0.75, 0, 1);
      const localDrop = Math.max(0, total - lowestNeighborTotal);
      const rawRapidness =
        THREE.MathUtils.clamp(
          (localDrop - 0.035) * 2.4 +
            gradientStrength * 0.9 +
            Math.max(0, flowStrength - 0.55) * 0.25,
          0,
          1
        ) * THREE.MathUtils.clamp(level * 2.6, 0, 1);
      const rapidness = Math.pow(rawRapidness, 1.65);
      if (flowLength > 0.00001) {
        flowX /= flowLength;
        flowY /= flowLength;
      } else {
        flowX = 0;
        flowY = 0;
      }

      positions[index * 3 + 1] = terrain[index] + 0.02 + level * 0.78;
      flows[flowOffset] = flowX * flowStrength;
      flows[flowOffset + 1] = flowY * flowStrength;
      waterStats[statOffset] = THREE.MathUtils.clamp(level * 2.8, 0, 1);
      waterStats[statOffset + 1] = flowStrength;
      waterStats[statOffset + 2] = rapidness;
    }

    position.needsUpdate = true;
    flow.needsUpdate = true;
    waterData.needsUpdate = true;
    this.waterGeometry.computeVertexNormals();
    this.waterMesh.visible = hasVisibleWater;
  }

  updateVegetation(
    terrain: Float32Array,
    water: Float32Array,
    humidity: Float32Array,
    seed: number,
    vitality: number
  ): void {
    const half = (this.size - 1) * 0.5;
    let canopyCount = 0;
    let canopyConiferCount = 0;
    let canopyBroadleafCount = 0;
    let canopyTrunkCount = 0;
    let shrubCount = 0;
    let shrubRoundCount = 0;
    let shrubTuftCount = 0;
    let shrubTrunkCount = 0;
    let grassCount = 0;
    const clampedVitality = THREE.MathUtils.clamp(vitality, 0, 1);

    for (let y = 1; y < this.size - 1; y += 1) {
      for (let x = 1; x < this.size - 1; x += 1) {
        const index = toIndex(this.size, x, y);
        const height = terrain[index];
        const wetness = water[index];
        const moisture = humidity[index] ?? 0;
        if (height < -7.5 || height > 14 || wetness > 0.62) {
          continue;
        }
        if (moisture < 0.06) {
          continue;
        }

        const slope = computeSlope(terrain, this.size, x, y);
        if (slope > 1.2) {
          continue;
        }

        const left = terrain[toIndex(this.size, x - 1, y)];
        const right = terrain[toIndex(this.size, x + 1, y)];
        const up = terrain[toIndex(this.size, x, y + 1)];
        const down = terrain[toIndex(this.size, x, y - 1)];
        const neighborAvg = (left + right + up + down) * 0.25;
        const valley = THREE.MathUtils.clamp((neighborAvg - height + 0.08) / 1.6, 0, 1);
        const ridge = THREE.MathUtils.clamp((height - neighborAvg - 0.12) / 1.5, 0, 1);
        const nearbyWetness = Math.max(
          wetness,
          water[toIndex(this.size, x - 1, y)],
          water[toIndex(this.size, x + 1, y)],
          water[toIndex(this.size, x, y - 1)],
          water[toIndex(this.size, x, y + 1)]
        );
        const riparian = THREE.MathUtils.clamp(nearbyWetness * 4.2, 0, 1);
        const altitude01 = THREE.MathUtils.clamp((height + 8) / 23, 0, 1);
        const fertility = THREE.MathUtils.clamp(
          moisture * 0.44 +
            riparian * 0.3 +
            valley * 0.24 +
            clampedVitality * 0.2 -
            slope * 0.37 -
            ridge * 0.22,
          0,
          1
        );
        if (fertility < 0.08) {
          continue;
        }

        const densityNoise = hash2D(x + 17, y - 13, seed + 11);
        if (densityNoise > fertility * 0.95) {
          continue;
        }

        const tallSuitability =
          THREE.MathUtils.clamp(
            (1 - Math.abs(altitude01 - 0.42) * 1.9) *
              (1 - slope * 0.85) *
              (0.5 + moisture * 0.5) *
              (0.62 + valley * 0.3),
            0,
            1
          ) * fertility;
        const shrubSuitability =
          THREE.MathUtils.clamp(
            (0.7 + valley * 0.2 + ridge * 0.16) *
              (1 - slope * 0.55) *
              (0.45 + moisture * 0.45 + riparian * 0.2) *
              (1 - Math.max(0, altitude01 - 0.82) * 1.3),
            0,
            1
          ) * fertility;
        const grassSuitability =
          THREE.MathUtils.clamp(
            (0.65 + altitude01 * 0.5 + ridge * 0.24) *
              (1 - slope * 0.32) *
              (0.38 + moisture * 0.4 + clampedVitality * 0.22),
            0,
            1
          ) * fertility;

        const tallWeight = tallSuitability * 0.92;
        const shrubWeight = shrubSuitability * 1.08;
        const grassWeight = grassSuitability * 1.35;
        const totalWeight = tallWeight + shrubWeight + grassWeight;
        if (totalWeight < 0.04) {
          continue;
        }

        const pickNoise = hash2D(x - 31, y + 47, seed + 211);
        let selected: 'canopy' | 'shrub' | 'grass';
        const pick = pickNoise * totalWeight;
        if (pick < tallWeight) {
          selected = 'canopy';
        } else if (pick < tallWeight + shrubWeight) {
          selected = 'shrub';
        } else {
          selected = 'grass';
        }

        if (selected === 'canopy' && canopyCount >= MAX_CANOPY_TREES) {
          selected = shrubWeight >= grassWeight ? 'shrub' : 'grass';
        } else if (selected === 'shrub' && shrubCount >= MAX_SHRUBS) {
          selected = tallWeight >= grassWeight ? 'canopy' : 'grass';
        } else if (selected === 'grass' && grassCount >= MAX_GRASS_PATCHES) {
          selected = tallWeight >= shrubWeight ? 'canopy' : 'shrub';
        }

        if (
          (selected === 'canopy' && canopyCount >= MAX_CANOPY_TREES) ||
          (selected === 'shrub' && shrubCount >= MAX_SHRUBS) ||
          (selected === 'grass' && grassCount >= MAX_GRASS_PATCHES)
        ) {
          continue;
        }

        const sizeNoise = hash2D(x + 13, y + 23, seed);
        const hueNoise = hash2D(x - 71, y + 5, seed);
        const rotNoise = hash2D(x + 31, y - 17, seed);
        const rotation = rotNoise * Math.PI * 2;
        const originX = x - half;
        const originZ = y - half;

        if (selected === 'canopy') {
          const speciesNoise = hash2D(x + 91, y - 27, seed + 313);
          const coniferThreshold = THREE.MathUtils.clamp(
            0.52 + ridge * 0.1 - valley * 0.08,
            0.2,
            0.85
          );
          const isConifer = speciesNoise < coniferThreshold;

          const canopyScale =
            (0.62 + sizeNoise * 1.02) * (0.74 + fertility * 0.34 + clampedVitality * 0.18);
          const trunkHeight = canopyScale * (isConifer ? 0.96 : 0.82);
          const trunkRadius = canopyScale * (isConifer ? 0.1 : 0.13);

          this.vegetationDummy.position.set(originX, height + trunkHeight * 0.5 + 0.03, originZ);
          this.vegetationDummy.rotation.set(0, rotation, 0);
          this.vegetationDummy.scale.set(trunkRadius, trunkHeight, trunkRadius);
          this.vegetationDummy.updateMatrix();
          this.canopyTrunkMesh.setMatrixAt(canopyTrunkCount, this.vegetationDummy.matrix);
          const trunkHue = 0.08 + hueNoise * 0.03;
          const trunkSat = THREE.MathUtils.clamp(0.28 + fertility * 0.08, 0, 1);
          const trunkLight = THREE.MathUtils.clamp(0.2 + fertility * 0.08 + sizeNoise * 0.04, 0, 1);
          this.vegetationColor.setHSL(trunkHue, trunkSat, trunkLight);
          this.canopyTrunkMesh.setColorAt(canopyTrunkCount, this.vegetationColor);
          canopyTrunkCount += 1;

          const hue = 0.22 + moisture * 0.06 + clampedVitality * 0.03 + hueNoise * 0.02;
          const saturation = THREE.MathUtils.clamp(
            (isConifer ? 0.14 : 0.18) + moisture * 0.24 + wetness * 0.08,
            0,
            1
          );
          const lightness = THREE.MathUtils.clamp(
            (isConifer ? 0.38 : 0.42) +
              fertility * 0.18 +
              clampedVitality * 0.08 +
              sizeNoise * 0.04,
            0,
            1
          );

          this.vegetationDummy.position.set(originX, height + trunkHeight + 0.08, originZ);
          this.vegetationDummy.rotation.set(0, rotation, 0);
          if (isConifer) {
            this.vegetationDummy.scale.set(
              canopyScale * 0.72,
              canopyScale * 1.24,
              canopyScale * 0.72
            );
          } else {
            this.vegetationDummy.scale.set(
              canopyScale * 0.92,
              canopyScale * 0.94,
              canopyScale * 0.92
            );
          }
          this.vegetationDummy.updateMatrix();
          this.vegetationColor.setHSL(hue, saturation, lightness);
          if (isConifer) {
            this.canopyConiferLeafMesh.setMatrixAt(canopyConiferCount, this.vegetationDummy.matrix);
            this.canopyConiferLeafMesh.setColorAt(canopyConiferCount, this.vegetationColor);
            canopyConiferCount += 1;
          } else {
            this.canopyBroadleafLeafMesh.setMatrixAt(
              canopyBroadleafCount,
              this.vegetationDummy.matrix
            );
            this.canopyBroadleafLeafMesh.setColorAt(canopyBroadleafCount, this.vegetationColor);
            canopyBroadleafCount += 1;
          }
          canopyCount += 1;
        } else if (selected === 'shrub') {
          const speciesNoise = hash2D(x - 49, y + 37, seed + 503);
          const isRoundShrub = speciesNoise < 0.56;
          const shrubScale = (0.4 + sizeNoise * 0.74) * (0.74 + fertility * 0.28);
          const trunkHeight = shrubScale * 0.34;
          const trunkRadius = shrubScale * 0.12;

          this.vegetationDummy.position.set(originX, height + trunkHeight * 0.5 + 0.01, originZ);
          this.vegetationDummy.rotation.set(0, rotation, 0);
          this.vegetationDummy.scale.set(trunkRadius, trunkHeight, trunkRadius);
          this.vegetationDummy.updateMatrix();
          this.shrubTrunkMesh.setMatrixAt(shrubTrunkCount, this.vegetationDummy.matrix);
          const trunkHue = 0.08 + hueNoise * 0.03;
          const trunkSat = THREE.MathUtils.clamp(0.26 + fertility * 0.08, 0, 1);
          const trunkLight = THREE.MathUtils.clamp(
            0.21 + fertility * 0.07 + sizeNoise * 0.04,
            0,
            1
          );
          this.vegetationColor.setHSL(trunkHue, trunkSat, trunkLight);
          this.shrubTrunkMesh.setColorAt(shrubTrunkCount, this.vegetationColor);
          shrubTrunkCount += 1;

          const hue = 0.2 + moisture * 0.04 + hueNoise * 0.03;
          const saturation = THREE.MathUtils.clamp(
            (isRoundShrub ? 0.18 : 0.15) + moisture * 0.2 + fertility * 0.12,
            0,
            1
          );
          const lightness = THREE.MathUtils.clamp(
            (isRoundShrub ? 0.4 : 0.37) + fertility * 0.16 + sizeNoise * 0.04,
            0,
            1
          );

          this.vegetationDummy.position.set(originX, height + trunkHeight + 0.05, originZ);
          this.vegetationDummy.rotation.set(0, rotation, 0);
          if (isRoundShrub) {
            this.vegetationDummy.scale.set(shrubScale * 0.86, shrubScale * 0.8, shrubScale * 0.86);
          } else {
            this.vegetationDummy.scale.set(shrubScale * 0.78, shrubScale * 0.92, shrubScale * 0.78);
          }
          this.vegetationDummy.updateMatrix();
          this.vegetationColor.setHSL(hue, saturation, lightness);
          if (isRoundShrub) {
            this.shrubRoundLeafMesh.setMatrixAt(shrubRoundCount, this.vegetationDummy.matrix);
            this.shrubRoundLeafMesh.setColorAt(shrubRoundCount, this.vegetationColor);
            shrubRoundCount += 1;
          } else {
            this.shrubTuftLeafMesh.setMatrixAt(shrubTuftCount, this.vegetationDummy.matrix);
            this.shrubTuftLeafMesh.setColorAt(shrubTuftCount, this.vegetationColor);
            shrubTuftCount += 1;
          }
          shrubCount += 1;
        } else {
          const scale =
            (0.27 + sizeNoise * 0.58) * (0.82 + fertility * 0.24 + clampedVitality * 0.14);
          this.vegetationDummy.position.set(originX, height + 0.03, originZ);
          this.vegetationDummy.rotation.set(0, rotation, 0);
          this.vegetationDummy.scale.set(scale * 0.54, scale * 0.86, scale * 0.54);
          this.vegetationDummy.updateMatrix();
          this.grassMesh.setMatrixAt(grassCount, this.vegetationDummy.matrix);

          const hue = 0.24 + altitude01 * 0.03 + hueNoise * 0.03;
          const saturation = THREE.MathUtils.clamp(0.14 + fertility * 0.16 + moisture * 0.1, 0, 1);
          const lightness = THREE.MathUtils.clamp(
            0.34 + fertility * 0.2 + clampedVitality * 0.08,
            0,
            1
          );
          this.vegetationColor.setHSL(hue, saturation, lightness);
          this.grassMesh.setColorAt(grassCount, this.vegetationColor);
          grassCount += 1;
        }
      }
    }

    this.canopyConiferLeafMesh.count = canopyConiferCount;
    this.canopyBroadleafLeafMesh.count = canopyBroadleafCount;
    this.canopyTrunkMesh.count = canopyTrunkCount;
    this.shrubRoundLeafMesh.count = shrubRoundCount;
    this.shrubTuftLeafMesh.count = shrubTuftCount;
    this.shrubTrunkMesh.count = shrubTrunkCount;
    this.grassMesh.count = grassCount;
    this.vegetationCounts = {
      canopy: canopyCount,
      shrub: shrubCount,
      grass: grassCount,
      total: canopyCount + shrubCount + grassCount
    };

    this.canopyConiferLeafMesh.instanceMatrix.needsUpdate = true;
    this.canopyBroadleafLeafMesh.instanceMatrix.needsUpdate = true;
    this.canopyTrunkMesh.instanceMatrix.needsUpdate = true;
    this.shrubRoundLeafMesh.instanceMatrix.needsUpdate = true;
    this.shrubTuftLeafMesh.instanceMatrix.needsUpdate = true;
    this.shrubTrunkMesh.instanceMatrix.needsUpdate = true;
    this.grassMesh.instanceMatrix.needsUpdate = true;

    if (this.canopyConiferLeafMesh.instanceColor) {
      this.canopyConiferLeafMesh.instanceColor.needsUpdate = true;
    }
    if (this.canopyBroadleafLeafMesh.instanceColor) {
      this.canopyBroadleafLeafMesh.instanceColor.needsUpdate = true;
    }
    if (this.canopyTrunkMesh.instanceColor) {
      this.canopyTrunkMesh.instanceColor.needsUpdate = true;
    }
    if (this.shrubRoundLeafMesh.instanceColor) {
      this.shrubRoundLeafMesh.instanceColor.needsUpdate = true;
    }
    if (this.shrubTuftLeafMesh.instanceColor) {
      this.shrubTuftLeafMesh.instanceColor.needsUpdate = true;
    }
    if (this.shrubTrunkMesh.instanceColor) {
      this.shrubTrunkMesh.instanceColor.needsUpdate = true;
    }
    if (this.grassMesh.instanceColor) {
      this.grassMesh.instanceColor.needsUpdate = true;
    }
  }

  updateAtmosphere(state: {
    dayPhase: number;
    daylight: number;
    cloudiness: number;
    rainIntensity: number;
    windStrength: number;
    windDirection: number;
    windGustiness: number;
  }): void {
    const dayPhase = state.dayPhase - Math.floor(state.dayPhase);
    const daylight = THREE.MathUtils.clamp(state.daylight, 0, 1);
    const cloudiness = THREE.MathUtils.clamp(state.cloudiness, 0, 1);
    const rainIntensity = THREE.MathUtils.clamp(state.rainIntensity, 0, 1);
    const windStrength = THREE.MathUtils.clamp(state.windStrength, 0, 1);
    const windDirection = state.windDirection;
    const windGustiness = THREE.MathUtils.clamp(state.windGustiness, 0, 1);

    const sunAngle = (dayPhase - 0.25) * TAU;
    const sunHeight = Math.sin(sunAngle);
    const dawnWeight = phaseWeight(dayPhase, 0.25, 0.13);
    const dayWeight = phaseWeight(dayPhase, 0.5, 0.25);
    const duskWeight = phaseWeight(dayPhase, 0.75, 0.14);
    const nightWeight = phaseWeight(dayPhase, 0.0, 0.32);
    const weightTotal = dawnWeight + dayWeight + duskWeight + nightWeight + 0.0001;
    const dawnMix = dawnWeight / weightTotal;
    const dayMix = dayWeight / weightTotal;
    const duskMix = duskWeight / weightTotal;
    const nightMix = nightWeight / weightTotal;
    const warmBand = THREE.MathUtils.clamp((dawnMix + duskMix) * 1.45 + dayMix * 0.15, 0, 1);
    const stormBlend = THREE.MathUtils.clamp(cloudiness * 0.42 + rainIntensity * 0.6, 0, 1);

    setWeightedColor(
      this.tempColorA,
      SKY_DAWN,
      dawnMix,
      SKY_DAY,
      dayMix,
      SKY_DUSK,
      duskMix,
      SKY_NIGHT,
      nightMix
    ).lerp(SKY_DAY, daylight * 0.12);
    const background = this.scene.background;
    if (background instanceof THREE.Color) {
      background
        .copy(this.tempColorA)
        .lerp(SKY_DUSK, warmBand * 0.28)
        .lerp(SKY_STORM, stormBlend);
    }

    setWeightedColor(
      this.tempColorB,
      FOG_DAWN,
      dawnMix,
      FOG_DAY,
      dayMix,
      FOG_DAWN,
      duskMix * 0.9,
      FOG_NIGHT,
      nightMix
    ).lerp(FOG_STORM, stormBlend * 0.85);
    const fog = this.scene.fog;
    if (fog instanceof THREE.Fog) {
      fog.color.copy(this.tempColorB);
      fog.near = 120 + cloudiness * 28 + rainIntensity * 22;
      fog.far = 395 - cloudiness * 24 - rainIntensity * 26;
    }

    const sunIntensity =
      (0.1 + Math.max(0, sunHeight) * 1.02 + duskMix * 0.16 + dawnMix * 0.1) *
      (1 - cloudiness * 0.4) *
      (1 - rainIntensity * 0.24);
    this.sunLight.intensity = sunIntensity;
    this.sunLight.position.set(
      Math.cos(sunAngle) * 52,
      30 + sunHeight * 56,
      Math.sin(sunAngle) * 34
    );
    this.tempColorA.setRGB(1.0, 0.86, 0.66);
    this.tempColorB.setRGB(0.95, 0.97, 1.0);
    this.tempColorC.copy(this.tempColorA).lerp(this.tempColorB, dayMix * 0.95 + dawnMix * 0.25);
    this.sunLight.color.copy(this.tempColorC);

    const moonIntensity = (0.06 + nightMix * 0.58 + duskMix * 0.12) * (1 - cloudiness * 0.3);
    this.moonLight.intensity = moonIntensity;
    this.moonLight.position.set(
      -Math.cos(sunAngle) * 48,
      32 + Math.max(0, -sunHeight) * 46,
      -Math.sin(sunAngle) * 30
    );
    this.tempColorA.setRGB(0.54, 0.66, 0.84);
    this.tempColorB.setRGB(0.62, 0.7, 0.84);
    this.moonLight.color.copy(this.tempColorA).lerp(this.tempColorB, cloudiness * 0.45);

    const hemiIntensity =
      0.24 + daylight * 0.4 + dawnMix * 0.12 + duskMix * 0.18 + cloudiness * 0.08;
    this.hemiLight.intensity = hemiIntensity;
    this.tempColorA.setRGB(1.0, 0.93, 0.8);
    this.tempColorB.setRGB(0.64, 0.74, 0.8);
    this.hemiLight.color
      .copy(this.tempColorA)
      .lerp(this.tempColorB, cloudiness * 0.64 + rainIntensity * 0.32 + nightMix * 0.35);
    this.tempColorC.setRGB(0.3, 0.36, 0.36);
    this.hemiLight.groundColor
      .copy(this.tempColorC)
      .lerp(HEMI_GROUND_DAY, dayMix * 0.9 + dawnMix * 0.4);

    this.renderer.toneMappingExposure =
      0.58 + dayMix * 0.34 + (dawnMix + duskMix) * 0.34 + nightMix * 0.1 - rainIntensity * 0.04;
    this.waterMaterial.uniforms.uDaylight.value = daylight;
    this.waterMaterial.uniforms.uCloudiness.value = cloudiness;
    this.waterMaterial.uniforms.uRainIntensity.value = rainIntensity;
    this.waterMaterial.uniforms.uRainSplashScale.value = THREE.MathUtils.lerp(
      0.2,
      0.48,
      rainIntensity
    );
    this.atmosphereRainIntensity = rainIntensity;
    this.atmosphereWindStrength = windStrength;
    this.atmosphereWindDirection = ((windDirection % TAU) + TAU) % TAU;
    this.atmosphereWindGustiness = windGustiness;
    this.windDirectionVector.set(
      Math.cos(this.atmosphereWindDirection),
      Math.sin(this.atmosphereWindDirection)
    );
    if (this.windDirectionVector.lengthSq() < 1e-6) {
      this.windDirectionVector.set(1, 0);
    } else {
      this.windDirectionVector.normalize();
    }
    this.applyWindUniforms();
  }

  render(): void {
    const now = performance.now() * 0.001;
    const deltaSeconds = THREE.MathUtils.clamp(now - this.previousFrameTime, 0.001, 0.06);
    this.previousFrameTime = now;
    this.waterMaterial.uniforms.uTime.value = now;
    this.updateRainParticles(deltaSeconds, now);
    this.applyWindUniforms();
    for (const material of this.windVegetationMaterials) {
      const shader = material.userData.shader;
      if (shader) {
        const windUniform = shader.uniforms.uWindTime as THREE.IUniform<number> | undefined;
        if (windUniform) {
          windUniform.value = now;
        }
      }
    }
    // Keep the same color pipeline in normal/photo modes.
    // Photo mode only toggles the Bokeh pass.
    this.composer.render();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResizeBound);
    this.controls.dispose();
    this.terrainGeometry.dispose();
    this.waterGeometry.dispose();
    this.riverGuideGeometry.dispose();
    this.rainGeometry.dispose();
    this.canopyConiferLeafMesh.geometry.dispose();
    this.canopyBroadleafLeafMesh.geometry.dispose();
    this.canopyTrunkMesh.geometry.dispose();
    this.shrubRoundLeafMesh.geometry.dispose();
    this.shrubTuftLeafMesh.geometry.dispose();
    this.shrubTrunkMesh.geometry.dispose();
    this.grassMesh.geometry.dispose();

    const terrainMaterial = this.terrainMesh.material;
    if (Array.isArray(terrainMaterial)) {
      for (const material of terrainMaterial) {
        material.dispose();
      }
    } else {
      terrainMaterial.dispose();
    }

    const waterMaterial = this.waterMesh.material;
    if (Array.isArray(waterMaterial)) {
      for (const material of waterMaterial) {
        material.dispose();
      }
    } else {
      waterMaterial.dispose();
    }

    const riverGuideMaterial = this.riverGuideMesh.material;
    if (Array.isArray(riverGuideMaterial)) {
      for (const material of riverGuideMaterial) {
        material.dispose();
      }
    } else {
      riverGuideMaterial.dispose();
    }

    this.rainMaterial.dispose();

    for (const material of this.windVegetationMaterials) {
      material.dispose();
    }
    for (const material of this.staticVegetationMaterials) {
      material.dispose();
    }

    this.renderer.dispose();
    this.composer.dispose();
  }

  private onResize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
  }

  private updateRainParticles(deltaSeconds: number, nowSeconds: number): void {
    const rainIntensity = this.atmosphereRainIntensity;
    if (rainIntensity < 0.05) {
      this.rainMesh.visible = false;
      return;
    }

    this.rainMesh.visible = true;
    this.rainMaterial.opacity = THREE.MathUtils.lerp(0.06, 0.42, rainIntensity);
    const cameraX = this.camera.position.x;
    const cameraY = this.camera.position.y;
    const cameraZ = this.camera.position.z;
    const gustWave =
      Math.sin(nowSeconds * 1.12 + this.atmosphereWindDirection * 0.7) * 0.5 +
      Math.sin(nowSeconds * 0.58 + this.atmosphereWindDirection * 1.4) * 0.35;
    const gustScale =
      0.72 +
      (gustWave * 0.5 + 0.5) * THREE.MathUtils.lerp(0.38, 0.92, this.atmosphereWindGustiness);
    const driftMagnitude =
      THREE.MathUtils.lerp(0.02, 0.54, this.atmosphereWindStrength) * gustScale;
    const windX = this.windDirectionVector.x * driftMagnitude;
    const windZ = this.windDirectionVector.y * driftMagnitude;
    const fallMultiplier = 0.9 + rainIntensity * 1.7;

    for (let index = 0; index < RAIN_PARTICLE_COUNT; index += 1) {
      const offsetIndex = index * 2;
      const positionIndex = index * 6;
      let localY = this.rainHeights[index] - this.rainSpeeds[index] * deltaSeconds * fallMultiplier;
      if (localY < RAIN_BOTTOM_OFFSET) {
        localY = RAIN_TOP_OFFSET + Math.random() * 16;
        this.rainOffsets[offsetIndex] = (Math.random() - 0.5) * RAIN_AREA_RADIUS * 2;
        this.rainOffsets[offsetIndex + 1] = (Math.random() - 0.5) * RAIN_AREA_RADIUS * 2;
      }
      this.rainHeights[index] = localY;

      const x = cameraX + this.rainOffsets[offsetIndex];
      const y = cameraY + localY;
      const z = cameraZ + this.rainOffsets[offsetIndex + 1];
      const length = this.rainLengths[index] * (0.82 + rainIntensity * 0.55);
      const driftX = windX * length;
      const driftZ = windZ * length;

      this.rainPositions[positionIndex] = x;
      this.rainPositions[positionIndex + 1] = y;
      this.rainPositions[positionIndex + 2] = z;
      this.rainPositions[positionIndex + 3] = x + driftX;
      this.rainPositions[positionIndex + 4] = y - length;
      this.rainPositions[positionIndex + 5] = z + driftZ;
    }

    this.rainPositionAttr.needsUpdate = true;
  }

  private applyWindUniforms(): void {
    const strengthScale = THREE.MathUtils.lerp(0, 2.35, this.atmosphereWindStrength);
    const speedScale = THREE.MathUtils.lerp(1.02, 2.2, this.atmosphereWindGustiness);
    const gustiness = THREE.MathUtils.lerp(0, 1, this.atmosphereWindGustiness);

    for (const material of this.windVegetationMaterials) {
      const shader = material.userData.shader;
      if (!shader) {
        continue;
      }

      const windStrengthUniform = shader.uniforms.uWindStrength as
        | THREE.IUniform<number>
        | undefined;
      if (windStrengthUniform) {
        windStrengthUniform.value = material.userData.windStrength * strengthScale;
      }

      const windSpeedUniform = shader.uniforms.uWindSpeed as THREE.IUniform<number> | undefined;
      if (windSpeedUniform) {
        windSpeedUniform.value = material.userData.windSpeed * speedScale;
      }

      const windDirUniform = shader.uniforms.uWindDirection as
        | THREE.IUniform<THREE.Vector2>
        | undefined;
      if (windDirUniform) {
        windDirUniform.value.copy(this.windDirectionVector);
      }

      const windGustUniform = shader.uniforms.uWindGustiness as THREE.IUniform<number> | undefined;
      if (windGustUniform) {
        windGustUniform.value = gustiness;
      }
    }
  }
}
