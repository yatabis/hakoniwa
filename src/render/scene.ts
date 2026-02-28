import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { toIndex } from '../core/grid';

const MAX_CANOPY_VEGETATION = 9_000;
const MAX_SHRUB_VEGETATION = 11_000;
const MAX_GRASS_VEGETATION = 14_000;
const TAU = Math.PI * 2;
const SKY_DAY = new THREE.Color('#bccbc4');
const SKY_DUSK = new THREE.Color('#c59d7f');
const SKY_NIGHT = new THREE.Color('#2f4353');
const SKY_STORM = new THREE.Color('#7e8f91');
const FOG_DAY = new THREE.Color('#d4ddd2');
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

function hash2D(x: number, y: number, seed: number): number {
  const value = Math.sin((x + seed * 0.001) * 12.9898 + (y - seed * 0.001) * 78.233) * 43758.5453;
  return value - Math.floor(value);
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
    shader.vertexShader = `
      uniform float uWindTime;
      uniform float uWindStrength;
      uniform float uWindSpeed;
      uniform float uWindBend;
    ${shader.vertexShader}
    `;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      float windHeight = clamp(position.y * 0.72, 0.0, 1.0);
      float windPhase = instanceMatrix[3].x * 0.23 + instanceMatrix[3].z * 0.19;
      float gustA = sin(windPhase + uWindTime * uWindSpeed);
      float gustB = cos(windPhase * 1.37 - uWindTime * (uWindSpeed * 0.61));
      float sway = (gustA * 0.72 + gustB * 0.28) * windHeight * uWindStrength;
      transformed.x += sway * uWindBend;
      transformed.z += sway * (uWindBend * 0.62);
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
        color += vec3(fresnel * (0.08 + uDaylight * 0.08));
        color = mix(color, color * vec3(0.92, 0.95, 1.03), storminess * 0.25);

        float alpha = clamp(depth * 0.64 + flowStrength * 0.3 + rapidness * 0.1 + fresnel * 0.1 + storminess * 0.08, 0.0, 0.9);
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
  private readonly canopyMesh: THREE.InstancedMesh;
  private readonly shrubMesh: THREE.InstancedMesh;
  private readonly grassMesh: THREE.InstancedMesh;
  private readonly canopyMaterial: WindVegetationMaterial;
  private readonly shrubMaterial: WindVegetationMaterial;
  private readonly grassMaterial: WindVegetationMaterial;
  private readonly vegetationMaterials: WindVegetationMaterial[];
  private readonly vegetationDummy: THREE.Object3D;
  private readonly vegetationColor: THREE.Color;
  private readonly tempColorA: THREE.Color;
  private readonly tempColorB: THREE.Color;
  private readonly tempColorC: THREE.Color;
  private vegetationCounts: VegetationRenderCounts;
  private atmosphereRainIntensity: number;
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

    const canopyGeometry = new THREE.ConeGeometry(0.46, 1.58, 7);
    const shrubGeometry = new THREE.ConeGeometry(0.62, 0.86, 8);
    const grassGeometry = new THREE.ConeGeometry(0.2, 0.55, 4);

    this.canopyMaterial = createWindVegetationMaterial('#486f46', 0.84, 0.04, 0.42, 1.06, 0.14, {
      toneDark: '#3f5f34',
      toneLight: '#88ad6a',
      emissive: 0.26
    });
    this.shrubMaterial = createWindVegetationMaterial('#6f8556', 0.89, 0.03, 0.34, 1.2, 0.1, {
      toneDark: '#48693c',
      toneLight: '#99b675',
      emissive: 0.22
    });
    this.grassMaterial = createWindVegetationMaterial('#7c9357', 0.93, 0.02, 0.28, 1.42, 0.08, {
      toneDark: '#5c7f44',
      toneLight: '#a8be7d',
      emissive: 0.18
    });
    this.vegetationMaterials = [this.canopyMaterial, this.shrubMaterial, this.grassMaterial];

    this.canopyMesh = new THREE.InstancedMesh(
      canopyGeometry,
      this.canopyMaterial,
      MAX_CANOPY_VEGETATION
    );
    this.canopyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.canopyMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_CANOPY_VEGETATION * 3),
      3
    );
    this.canopyMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.canopyMesh.count = 0;
    this.scene.add(this.canopyMesh);

    this.shrubMesh = new THREE.InstancedMesh(
      shrubGeometry,
      this.shrubMaterial,
      MAX_SHRUB_VEGETATION
    );
    this.shrubMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shrubMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_SHRUB_VEGETATION * 3),
      3
    );
    this.shrubMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.shrubMesh.count = 0;
    this.scene.add(this.shrubMesh);

    this.grassMesh = new THREE.InstancedMesh(
      grassGeometry,
      this.grassMaterial,
      MAX_GRASS_VEGETATION
    );
    this.grassMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.grassMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_GRASS_VEGETATION * 3),
      3
    );
    this.grassMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.grassMesh.count = 0;
    this.scene.add(this.grassMesh);

    this.onResizeBound = this.onResize.bind(this);
    window.addEventListener('resize', this.onResizeBound);
  }

  getTerrainMesh(): THREE.Mesh {
    return this.terrainMesh;
  }

  getVegetationCounts(): VegetationRenderCounts {
    return { ...this.vegetationCounts };
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
    let shrubCount = 0;
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

        if (selected === 'canopy' && canopyCount >= MAX_CANOPY_VEGETATION) {
          selected = shrubWeight >= grassWeight ? 'shrub' : 'grass';
        } else if (selected === 'shrub' && shrubCount >= MAX_SHRUB_VEGETATION) {
          selected = tallWeight >= grassWeight ? 'canopy' : 'grass';
        } else if (selected === 'grass' && grassCount >= MAX_GRASS_VEGETATION) {
          selected = tallWeight >= shrubWeight ? 'canopy' : 'shrub';
        }

        if (
          (selected === 'canopy' && canopyCount >= MAX_CANOPY_VEGETATION) ||
          (selected === 'shrub' && shrubCount >= MAX_SHRUB_VEGETATION) ||
          (selected === 'grass' && grassCount >= MAX_GRASS_VEGETATION)
        ) {
          continue;
        }

        const sizeNoise = hash2D(x + 13, y + 23, seed);
        const hueNoise = hash2D(x - 71, y + 5, seed);
        const rotNoise = hash2D(x + 31, y - 17, seed);
        this.vegetationDummy.position.set(x - half, height, y - half);
        this.vegetationDummy.rotation.set(0, rotNoise * Math.PI * 2, 0);

        if (selected === 'canopy') {
          const scale =
            (0.64 + sizeNoise * 1.06) * (0.72 + fertility * 0.38 + clampedVitality * 0.14);
          this.vegetationDummy.position.y += 0.09;
          this.vegetationDummy.scale.set(scale * 0.52, scale * 1.36, scale * 0.52);
          this.vegetationDummy.updateMatrix();
          this.canopyMesh.setMatrixAt(canopyCount, this.vegetationDummy.matrix);

          const hue = 0.22 + moisture * 0.06 + clampedVitality * 0.03 + hueNoise * 0.02;
          const saturation = THREE.MathUtils.clamp(0.18 + moisture * 0.26 + wetness * 0.08, 0, 1);
          const lightness = THREE.MathUtils.clamp(
            0.4 + fertility * 0.2 + clampedVitality * 0.1 + sizeNoise * 0.04,
            0,
            1
          );
          this.vegetationColor.setHSL(hue, saturation, lightness);
          this.canopyMesh.setColorAt(canopyCount, this.vegetationColor);
          canopyCount += 1;
        } else if (selected === 'shrub') {
          const scale = (0.42 + sizeNoise * 0.82) * (0.72 + fertility * 0.33);
          this.vegetationDummy.position.y += 0.05;
          this.vegetationDummy.scale.set(scale * 0.92, scale * 0.64, scale * 0.92);
          this.vegetationDummy.updateMatrix();
          this.shrubMesh.setMatrixAt(shrubCount, this.vegetationDummy.matrix);

          const hue = 0.2 + moisture * 0.04 + hueNoise * 0.03;
          const saturation = THREE.MathUtils.clamp(0.16 + moisture * 0.22 + fertility * 0.12, 0, 1);
          const lightness = THREE.MathUtils.clamp(0.38 + fertility * 0.18 + sizeNoise * 0.04, 0, 1);
          this.vegetationColor.setHSL(hue, saturation, lightness);
          this.shrubMesh.setColorAt(shrubCount, this.vegetationColor);
          shrubCount += 1;
        } else {
          const scale =
            (0.27 + sizeNoise * 0.58) * (0.82 + fertility * 0.24 + clampedVitality * 0.14);
          this.vegetationDummy.position.y += 0.03;
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

    this.canopyMesh.count = canopyCount;
    this.shrubMesh.count = shrubCount;
    this.grassMesh.count = grassCount;
    this.vegetationCounts = {
      canopy: canopyCount,
      shrub: shrubCount,
      grass: grassCount,
      total: canopyCount + shrubCount + grassCount
    };

    this.canopyMesh.instanceMatrix.needsUpdate = true;
    this.shrubMesh.instanceMatrix.needsUpdate = true;
    this.grassMesh.instanceMatrix.needsUpdate = true;

    if (this.canopyMesh.instanceColor) {
      this.canopyMesh.instanceColor.needsUpdate = true;
    }
    if (this.shrubMesh.instanceColor) {
      this.shrubMesh.instanceColor.needsUpdate = true;
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
  }): void {
    const dayPhase = state.dayPhase - Math.floor(state.dayPhase);
    const daylight = THREE.MathUtils.clamp(state.daylight, 0, 1);
    const cloudiness = THREE.MathUtils.clamp(state.cloudiness, 0, 1);
    const rainIntensity = THREE.MathUtils.clamp(state.rainIntensity, 0, 1);

    const sunAngle = (dayPhase - 0.25) * TAU;
    const sunHeight = Math.sin(sunAngle);
    const dawnDusk = THREE.MathUtils.clamp(1 - Math.abs(sunHeight) * 3.3, 0, 1);
    const warmBand = THREE.MathUtils.clamp(dawnDusk * (0.35 + daylight * 0.65), 0, 1);
    const stormBlend = THREE.MathUtils.clamp(cloudiness * 0.42 + rainIntensity * 0.6, 0, 1);

    this.tempColorA.copy(SKY_NIGHT).lerp(SKY_DAY, daylight);
    this.tempColorB.copy(SKY_DUSK).lerp(this.tempColorA, daylight);
    const background = this.scene.background;
    if (background instanceof THREE.Color) {
      background
        .copy(this.tempColorA)
        .lerp(SKY_DUSK, warmBand * 0.45)
        .lerp(SKY_STORM, stormBlend);
    }

    this.tempColorC.copy(FOG_NIGHT).lerp(FOG_DAY, daylight).lerp(FOG_STORM, stormBlend);
    const fog = this.scene.fog;
    if (fog instanceof THREE.Fog) {
      fog.color.copy(this.tempColorC);
      fog.near = 130 + cloudiness * 24 + rainIntensity * 20;
      fog.far = 410 - cloudiness * 18 - rainIntensity * 18;
    }

    const sunIntensity =
      (0.12 + Math.max(0, sunHeight) * 0.95) * (1 - cloudiness * 0.38) * (1 - rainIntensity * 0.24);
    this.sunLight.intensity = sunIntensity;
    this.sunLight.position.set(
      Math.cos(sunAngle) * 52,
      30 + sunHeight * 56,
      Math.sin(sunAngle) * 34
    );
    this.tempColorA.setRGB(0.94, 0.96, 1);
    this.tempColorB.setRGB(1, 0.76, 0.58);
    this.sunLight.color.copy(this.tempColorA).lerp(this.tempColorB, warmBand);

    const moonIntensity = (0.08 + (1 - daylight) * 0.42) * (1 - cloudiness * 0.3);
    this.moonLight.intensity = moonIntensity;
    this.moonLight.position.set(
      -Math.cos(sunAngle) * 48,
      32 + Math.max(0, -sunHeight) * 46,
      -Math.sin(sunAngle) * 30
    );
    this.tempColorC.setRGB(0.56, 0.66, 0.82);
    this.moonLight.color.copy(this.tempColorC);

    const hemiIntensity = 0.26 + daylight * 0.46 + cloudiness * 0.1;
    this.hemiLight.intensity = hemiIntensity;
    this.tempColorA.setRGB(1, 0.95, 0.84);
    this.tempColorB.setRGB(0.64, 0.74, 0.78);
    this.hemiLight.color
      .copy(this.tempColorA)
      .lerp(this.tempColorB, cloudiness * 0.65 + rainIntensity * 0.3);
    this.tempColorC.setRGB(0.32, 0.38, 0.38);
    this.hemiLight.groundColor.copy(this.tempColorC).lerp(HEMI_GROUND_DAY, daylight * 0.7);

    this.renderer.toneMappingExposure = 0.66 + daylight * 0.36 - rainIntensity * 0.05;
    this.waterMaterial.uniforms.uDaylight.value = daylight;
    this.waterMaterial.uniforms.uCloudiness.value = cloudiness;
    this.waterMaterial.uniforms.uRainIntensity.value = rainIntensity;
    this.atmosphereRainIntensity = rainIntensity;
  }

  render(): void {
    const now = performance.now() * 0.001;
    const deltaSeconds = THREE.MathUtils.clamp(now - this.previousFrameTime, 0.001, 0.06);
    this.previousFrameTime = now;
    this.waterMaterial.uniforms.uTime.value = now;
    this.updateRainParticles(deltaSeconds, now);
    for (const material of this.vegetationMaterials) {
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
    this.canopyMesh.geometry.dispose();
    this.shrubMesh.geometry.dispose();
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

    for (const material of this.vegetationMaterials) {
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
    const windX = Math.sin(nowSeconds * 0.63) * 0.19;
    const windZ = Math.cos(nowSeconds * 0.47) * 0.12;
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
}
