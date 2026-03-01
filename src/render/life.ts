import * as THREE from 'three';
import { toIndex } from '../core/grid';
import type { LifeDiagnostics, LifeUpdateState } from '../core/types';

const TAU = Math.PI * 2;
const BIRD_MAX = 48;
const INSECT_MAX = 180;
const BIRD_ACTIVITY_RAIN_THRESHOLD = 0.6;
const INSECT_WATER_NEAR_THRESHOLD = 0.08;
const INSECT_MIN_HUMIDITY = 0.15;
const INSECT_MAX_STANDING_WATER = 0.64;
const INSECT_MAX_SLOPE = 0.95;
const BIRD_NEAR_CAMERA_RADIUS = 22;
const INSECT_NEAR_CAMERA_RADIUS = 13.5;
const BIRD_LOCAL_NEIGHBOR_RADIUS = 10.5;
const BIRD_SEPARATION_RADIUS = 3.2;
const BIRD_TARGET_MARGIN = 16;
const BIRD_CENTER_RETURN_START_RATIO = 0.78;
const BIRD_CENTER_RETURN_END_RATIO = 0.94;

type BirdAgent = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  phase: number;
  activityThreshold: number;
};

type InsectAgent = {
  homeX: number;
  homeZ: number;
  orbitRadius: number;
  orbitAngle: number;
  orbitSpeed: number;
  baseHeight: number;
  flutterPhase: number;
  driftScale: number;
  activityThreshold: number;
  x: number;
  y: number;
  z: number;
};

type InsectSpawnOptions = {
  rng: () => number;
  seed: number;
  index: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function hashNoise(x: number, y: number, seed: number): number {
  const value = Math.sin((x + seed * 0.001) * 12.9898 + (y - seed * 0.001) * 78.233) * 43758.5453;
  return value - Math.floor(value);
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

function createBirdGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([
    0, 0.05, 0.32, -0.06, 0.04, -0.1, 0.06, 0.04, -0.1, 0, -0.05, -0.14, -0.02, 0.02, 0.06, -0.42,
    0.01, -0.02, -0.04, -0.01, -0.08, 0.02, 0.02, 0.06, 0.42, 0.01, -0.02, 0.04, -0.01, -0.08
  ]);
  const indices = new Uint16Array([0, 1, 2, 1, 3, 2, 0, 2, 3, 0, 3, 1, 4, 5, 6, 7, 9, 8]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function createInsectGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([
    -0.085, -0.035, 0, 0.085, -0.035, 0, 0.085, 0.035, 0, -0.085, 0.035, 0, 0, -0.035, -0.085, 0,
    -0.035, 0.085, 0, 0.035, 0.085, 0, 0.035, -0.085
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function computeInsectTargetCount(spawnableCellCount: number): number {
  if (spawnableCellCount <= 0) {
    return 0;
  }
  return Math.min(INSECT_MAX, Math.max(24, Math.floor(spawnableCellCount * 2.2)));
}

export class LifeSystem {
  private readonly size: number;
  private readonly half: number;
  private readonly root: THREE.Group;
  private readonly birdMesh: THREE.InstancedMesh;
  private readonly insectMesh: THREE.InstancedMesh;
  private readonly dummy: THREE.Object3D;
  private readonly color: THREE.Color;
  private terrain: Float32Array | null = null;
  private birds: BirdAgent[] = [];
  private insects: InsectAgent[] = [];
  private spawnableCells: Array<{ x: number; y: number }> = [];
  private diagnostics: LifeDiagnostics = {
    birdsTotal: BIRD_MAX,
    birdsActive: 0,
    insectsTotal: 0,
    insectsActive: 0,
    nearCameraBirds: 0,
    nearCameraInsects: 0,
    spawnableWaterEdgeCells: 0
  };
  private seed: number;
  private lastTime: number | null = null;
  private flockTargetX = 0;
  private flockTargetZ = 0;
  private flockDriftX = 0;
  private flockDriftZ = 0;

  constructor(size: number, seed: number, scene: THREE.Scene) {
    this.size = size;
    this.half = (size - 1) * 0.5;
    this.seed = seed;
    this.root = new THREE.Group();
    this.root.name = 'LifeSystemRoot';
    this.root.renderOrder = 7;
    scene.add(this.root);
    this.dummy = new THREE.Object3D();
    this.color = new THREE.Color();

    const birdMaterial = new THREE.MeshStandardMaterial({
      color: '#4e5f6f',
      roughness: 0.74,
      metalness: 0.03,
      flatShading: true,
      vertexColors: true
    });
    this.birdMesh = new THREE.InstancedMesh(createBirdGeometry(), birdMaterial, BIRD_MAX);
    this.birdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.birdMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(BIRD_MAX * 3),
      3
    );
    this.birdMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.birdMesh.frustumCulled = false;
    this.root.add(this.birdMesh);

    const insectMaterial = new THREE.MeshBasicMaterial({
      color: '#d4c26d',
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.insectMesh = new THREE.InstancedMesh(createInsectGeometry(), insectMaterial, INSECT_MAX);
    this.insectMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.insectMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(INSECT_MAX * 3),
      3
    );
    this.insectMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.insectMesh.frustumCulled = false;
    this.root.add(this.insectMesh);

    this.reseedFlockTarget(seed);
    this.reseedBirds(seed);
    this.birdMesh.count = 0;
    this.insectMesh.count = 0;
  }

  update(state: LifeUpdateState): void {
    const delta = this.computeDeltaSeconds(state.time);
    const windDirection = ((state.windDirection % TAU) + TAU) % TAU;
    const windX = Math.cos(windDirection);
    const windZ = Math.sin(windDirection);
    const windStrength = clamp01(state.windStrength);
    const windGustiness = clamp01(state.windGustiness);
    const rainIntensity = clamp01(state.rainIntensity);
    const daylight = clamp01(state.daylight);
    const cameraX = state.cameraX;
    const cameraZ = state.cameraZ;

    const daylightFactor = THREE.MathUtils.smoothstep(daylight, 0.16, 0.62);
    const rainFactor =
      rainIntensity <= BIRD_ACTIVITY_RAIN_THRESHOLD
        ? 1
        : THREE.MathUtils.lerp(
            1,
            0.16,
            clamp01(
              (rainIntensity - BIRD_ACTIVITY_RAIN_THRESHOLD) / (1 - BIRD_ACTIVITY_RAIN_THRESHOLD)
            )
          );
    const birdActivityScale = clamp01(Math.max(0.06, daylightFactor * rainFactor));
    const effectiveBirdActivityScale = Math.max(0.2, birdActivityScale);
    this.advanceFlockTarget(state.time, windX, windZ, windStrength, windGustiness, delta);
    const neighborRadiusSq = BIRD_LOCAL_NEIGHBOR_RADIUS * BIRD_LOCAL_NEIGHBOR_RADIUS;
    const separationRadiusSq = BIRD_SEPARATION_RADIUS * BIRD_SEPARATION_RADIUS;
    const birdSpeedCap = 0.26 + windStrength * 0.18 + windGustiness * 0.08;
    const birdNearDistanceSq = BIRD_NEAR_CAMERA_RADIUS * BIRD_NEAR_CAMERA_RADIUS;
    let birdActiveCount = 0;
    let birdNearCount = 0;
    let birdWrite = 0;

    for (let index = 0; index < this.birds.length; index += 1) {
      const bird = this.birds[index];
      const jitterA = Math.sin(state.time * 1.7 + bird.phase + index * 0.31);
      const jitterB = Math.cos(state.time * 1.2 + bird.phase * 1.7 + index * 0.47);
      let localCenterX = 0;
      let localCenterY = 0;
      let localCenterZ = 0;
      let localVelX = 0;
      let localVelY = 0;
      let localVelZ = 0;
      let separationX = 0;
      let separationY = 0;
      let separationZ = 0;
      let neighborCount = 0;
      for (let nearIndex = 0; nearIndex < this.birds.length; nearIndex += 1) {
        if (nearIndex === index) {
          continue;
        }
        const other = this.birds[nearIndex];
        if (!other) {
          continue;
        }
        const dx = other.x - bird.x;
        const dy = other.y - bird.y;
        const dz = other.z - bird.z;
        const distSq = dx * dx + dz * dz + dy * dy * 0.35;
        if (distSq > neighborRadiusSq) {
          continue;
        }
        neighborCount += 1;
        localCenterX += other.x;
        localCenterY += other.y;
        localCenterZ += other.z;
        localVelX += other.vx;
        localVelY += other.vy;
        localVelZ += other.vz;
        if (distSq < separationRadiusSq) {
          const dist = Math.sqrt(Math.max(distSq, 1e-5));
          const push = (1 - dist / BIRD_SEPARATION_RADIUS) * 0.38;
          const inv = 1 / Math.max(dist, 0.001);
          separationX -= dx * inv * push;
          separationY -= dy * inv * push;
          separationZ -= dz * inv * push;
        }
      }
      let cohesionX = 0;
      let cohesionY = 0;
      let cohesionZ = 0;
      let alignX = 0;
      let alignY = 0;
      let alignZ = 0;
      if (neighborCount > 0) {
        const invNeighbor = 1 / neighborCount;
        cohesionX = localCenterX * invNeighbor - bird.x;
        cohesionY = localCenterY * invNeighbor - bird.y;
        cohesionZ = localCenterZ * invNeighbor - bird.z;
        alignX = localVelX * invNeighbor - bird.vx;
        alignY = localVelY * invNeighbor - bird.vy;
        alignZ = localVelZ * invNeighbor - bird.vz;
      }
      const formationRadius =
        7.4 + Math.sin(bird.phase * 1.4 + index * 0.13) * 2.9 + windStrength * 1.8;
      const formationAngle = bird.phase * 1.35 + state.time * (0.22 + windGustiness * 0.12);
      const targetX = this.flockTargetX + Math.cos(formationAngle) * formationRadius;
      const targetZ = this.flockTargetZ + Math.sin(formationAngle) * formationRadius;
      const toTargetX = targetX - bird.x;
      const toTargetZ = targetZ - bird.z;

      const terrainHeight = this.sampleTerrainHeight(bird.x, bird.z);
      const targetHeight =
        terrainHeight +
        5.2 +
        birdActivityScale * 4.4 +
        Math.sin(state.time * 0.7 + bird.phase) * 0.6;
      const groundAvoid = bird.y < terrainHeight + 2.5 ? 0.085 : 0;
      const topAvoid = bird.y > terrainHeight + 17 ? -0.03 : 0;
      const edgeX = Math.abs(bird.x) > this.half - 3 ? -Math.sign(bird.x) * 0.03 : 0;
      const edgeZ = Math.abs(bird.z) > this.half - 3 ? -Math.sign(bird.z) * 0.03 : 0;
      const centerDistance = Math.hypot(bird.x, bird.z);
      const centerReturnStart = this.half * BIRD_CENTER_RETURN_START_RATIO;
      const centerReturnEnd = this.half * BIRD_CENTER_RETURN_END_RATIO;
      const centerReturnScale = THREE.MathUtils.smoothstep(
        centerDistance,
        centerReturnStart,
        centerReturnEnd
      );
      const centerReturnInv = centerDistance > 0.001 ? 1 / centerDistance : 0;
      const centerReturnX = -bird.x * centerReturnInv * centerReturnScale * 0.08;
      const centerReturnZ = -bird.z * centerReturnInv * centerReturnScale * 0.08;

      bird.vx +=
        (cohesionX * 0.0016 +
          alignX * 0.0076 +
          separationX * 0.065 +
          toTargetX * 0.0018 +
          jitterA * 0.0028 +
          windX * (0.004 + windStrength * 0.028) +
          centerReturnX +
          edgeX) *
        (delta * 60);
      bird.vy +=
        ((targetHeight - bird.y) * 0.012 +
          cohesionY * 0.0008 +
          alignY * 0.005 +
          separationY * 0.025 +
          jitterB * 0.0022 +
          groundAvoid +
          topAvoid) *
        (delta * 60);
      bird.vz +=
        (cohesionZ * 0.0016 +
          alignZ * 0.0076 +
          separationZ * 0.065 +
          toTargetZ * 0.0018 +
          jitterB * 0.0028 +
          windZ * (0.004 + windStrength * 0.028) +
          centerReturnZ +
          edgeZ) *
        (delta * 60);

      bird.vx *= 0.986;
      bird.vy *= 0.986;
      bird.vz *= 0.986;
      const speed = Math.hypot(bird.vx, bird.vy, bird.vz);
      if (speed > birdSpeedCap) {
        const inv = birdSpeedCap / Math.max(speed, 0.0001);
        bird.vx *= inv;
        bird.vy *= inv;
        bird.vz *= inv;
      }

      bird.x += bird.vx * delta * 26;
      bird.y += bird.vy * delta * 26;
      bird.z += bird.vz * delta * 26;
      bird.x = THREE.MathUtils.clamp(bird.x, -this.half + 1, this.half - 1);
      bird.z = THREE.MathUtils.clamp(bird.z, -this.half + 1, this.half - 1);
      const terrainClamp = this.sampleTerrainHeight(bird.x, bird.z) + 1.9;
      if (bird.y < terrainClamp) {
        bird.y = terrainClamp;
      }

      const active = effectiveBirdActivityScale > bird.activityThreshold;
      if (!active) {
        continue;
      }
      birdActiveCount += 1;

      const dx = bird.x - cameraX;
      const dz = bird.z - cameraZ;
      if (dx * dx + dz * dz < birdNearDistanceSq) {
        birdNearCount += 1;
      }

      const yaw = Math.atan2(bird.vx, bird.vz);
      const pitch = THREE.MathUtils.clamp(-bird.vy * 3.4, -0.45, 0.45);
      const wingFlap = Math.sin(state.time * 9.2 + bird.phase) * 0.22;
      this.dummy.position.set(bird.x, bird.y, bird.z);
      this.dummy.rotation.set(pitch, yaw, wingFlap);
      const flapScale = 0.95 + Math.abs(wingFlap) * 0.34;
      this.dummy.scale.set(flapScale, 1, flapScale);
      this.dummy.updateMatrix();
      this.birdMesh.setMatrixAt(birdWrite, this.dummy.matrix);

      const duskWarm = clamp01(1 - Math.abs(daylight - 0.35) * 2.8);
      const hue = THREE.MathUtils.lerp(0.58, 0.07, duskWarm * 0.28);
      const sat = THREE.MathUtils.lerp(0.14, 0.32, duskWarm);
      const light = THREE.MathUtils.lerp(0.23, 0.58, daylight * 0.6 + duskWarm * 0.4);
      this.color.setHSL(hue, sat, light);
      this.birdMesh.setColorAt(birdWrite, this.color);
      birdWrite += 1;
    }

    this.birdMesh.count = birdWrite;
    this.birdMesh.visible = birdWrite > 0;
    this.birdMesh.instanceMatrix.needsUpdate = true;
    if (this.birdMesh.instanceColor) {
      this.birdMesh.instanceColor.needsUpdate = true;
    }

    const insectNearDistanceSq = INSECT_NEAR_CAMERA_RADIUS * INSECT_NEAR_CAMERA_RADIUS;
    const insectActivityScale = clamp01(
      Math.max(0.08, (0.58 + daylight * 0.42) * (1 - rainIntensity * 0.74))
    );
    let insectActiveCount = 0;
    let insectNearCount = 0;
    let insectWrite = 0;

    for (let index = 0; index < this.insects.length; index += 1) {
      const insect = this.insects[index];
      const active = insectActivityScale > insect.activityThreshold;
      if (!active) {
        continue;
      }
      insectActiveCount += 1;
      insect.orbitAngle += insect.orbitSpeed * delta * (0.9 + insectActivityScale * 0.6);
      const orbitX = Math.cos(insect.orbitAngle + insect.flutterPhase) * insect.orbitRadius;
      const orbitZ =
        Math.sin(insect.orbitAngle * 1.13 + insect.flutterPhase * 0.87) * insect.orbitRadius * 0.82;
      const gustDrift = (0.24 + windStrength * 0.9 + windGustiness * 0.42) * insect.driftScale;
      const jitter =
        Math.sin(state.time * (3.7 + insect.orbitSpeed) + insect.flutterPhase + index * 0.19) *
        0.07;
      const x = THREE.MathUtils.clamp(
        insect.homeX + orbitX + windX * gustDrift + jitter,
        -this.half + 1,
        this.half - 1
      );
      const z = THREE.MathUtils.clamp(
        insect.homeZ + orbitZ + windZ * gustDrift - jitter,
        -this.half + 1,
        this.half - 1
      );
      const terrainHeight = this.sampleTerrainHeight(x, z);
      const y =
        terrainHeight +
        insect.baseHeight +
        Math.sin(state.time * 10.8 + insect.flutterPhase + index * 0.11) * 0.04;

      insect.x = x;
      insect.y = y;
      insect.z = z;

      const dx = x - cameraX;
      const dz = z - cameraZ;
      if (dx * dx + dz * dz < insectNearDistanceSq) {
        insectNearCount += 1;
      }

      const roll = Math.sin(state.time * 12.6 + insect.flutterPhase) * 0.28;
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(0, insect.orbitAngle, roll);
      const flutterScale = 0.72 + (Math.abs(roll) / 0.28) * 0.55;
      this.dummy.scale.set(flutterScale, flutterScale, flutterScale);
      this.dummy.updateMatrix();
      this.insectMesh.setMatrixAt(insectWrite, this.dummy.matrix);

      const duskWarm = clamp01(1 - Math.abs(daylight - 0.35) * 2.2);
      const hue = THREE.MathUtils.lerp(0.16, 0.12, duskWarm);
      const sat = THREE.MathUtils.lerp(0.52, 0.66, duskWarm);
      const light = THREE.MathUtils.lerp(0.44, 0.68, duskWarm * 0.7 + daylight * 0.3);
      this.color.setHSL(hue, sat, light);
      this.insectMesh.setColorAt(insectWrite, this.color);
      insectWrite += 1;
    }

    this.insectMesh.count = insectWrite;
    this.insectMesh.visible = insectWrite > 0;
    this.insectMesh.instanceMatrix.needsUpdate = true;
    if (this.insectMesh.instanceColor) {
      this.insectMesh.instanceColor.needsUpdate = true;
    }

    this.diagnostics = {
      birdsTotal: this.birds.length,
      birdsActive: birdActiveCount,
      insectsTotal: this.insects.length,
      insectsActive: insectActiveCount,
      nearCameraBirds: birdNearCount,
      nearCameraInsects: insectNearCount,
      spawnableWaterEdgeCells: this.spawnableCells.length
    };
  }

  rebuildHabitat(
    terrain: Float32Array,
    water: Float32Array,
    humidity: Float32Array,
    seed: number
  ): void {
    this.terrain = terrain;
    const seedChanged = seed !== this.seed;
    if (seedChanged) {
      this.seed = seed;
      this.reseedFlockTarget(seed);
      this.reseedBirds(seed);
    }

    const spawnable: Array<{ x: number; y: number }> = [];
    for (let y = 1; y < this.size - 1; y += 1) {
      for (let x = 1; x < this.size - 1; x += 1) {
        const index = toIndex(this.size, x, y);
        const localWater = Math.max(
          water[index],
          water[toIndex(this.size, x - 1, y)],
          water[toIndex(this.size, x + 1, y)],
          water[toIndex(this.size, x, y - 1)],
          water[toIndex(this.size, x, y + 1)]
        );
        if (
          localWater < INSECT_WATER_NEAR_THRESHOLD ||
          localWater > INSECT_MAX_STANDING_WATER ||
          (humidity[index] ?? 0) < INSECT_MIN_HUMIDITY
        ) {
          continue;
        }

        const slope = computeSlope(terrain, this.size, x, y);
        if (slope > INSECT_MAX_SLOPE) {
          continue;
        }
        spawnable.push({ x, y });
      }
    }
    this.spawnableCells = spawnable;
    const targetInsectCount = computeInsectTargetCount(this.spawnableCells.length);
    if (targetInsectCount === 0) {
      this.insects = [];
      this.insectMesh.count = 0;
      this.diagnostics.insectsTotal = 0;
      this.diagnostics.spawnableWaterEdgeCells = 0;
      return;
    }

    if (seedChanged || this.insects.length === 0) {
      this.reseedInsects(seed + 977);
      return;
    }

    if (this.insects.length > targetInsectCount) {
      this.insects.length = targetInsectCount;
    } else if (this.insects.length < targetInsectCount) {
      const rng = createRng((seed + 977) ^ (targetInsectCount * 33));
      const start = this.insects.length;
      for (let index = start; index < targetInsectCount; index += 1) {
        this.insects.push(this.createInsectAgent({ rng, seed: seed + 977, index }));
      }
    }
    this.diagnostics.insectsTotal = this.insects.length;
    this.diagnostics.spawnableWaterEdgeCells = this.spawnableCells.length;
  }

  getDiagnostics(): LifeDiagnostics {
    return { ...this.diagnostics };
  }

  getAgentSnapshot(): {
    birds: Array<{ x: number; y: number; z: number }>;
    insects: Array<{ x: number; y: number; z: number }>;
  } {
    return {
      birds: this.birds.map((bird) => ({ x: bird.x, y: bird.y, z: bird.z })),
      insects: this.insects.map((insect) => ({ x: insect.x, y: insect.y, z: insect.z }))
    };
  }

  dispose(): void {
    this.root.remove(this.birdMesh);
    this.root.remove(this.insectMesh);
    this.birdMesh.geometry.dispose();
    const birdMaterial = this.birdMesh.material;
    if (Array.isArray(birdMaterial)) {
      for (const material of birdMaterial) {
        material.dispose();
      }
    } else {
      birdMaterial.dispose();
    }
    this.insectMesh.geometry.dispose();
    const insectMaterial = this.insectMesh.material;
    if (Array.isArray(insectMaterial)) {
      for (const material of insectMaterial) {
        material.dispose();
      }
    } else {
      insectMaterial.dispose();
    }
    if (this.root.parent) {
      this.root.parent.remove(this.root);
    }
  }

  private computeDeltaSeconds(time: number): number {
    if (!Number.isFinite(time)) {
      return 1 / 60;
    }
    if (this.lastTime === null) {
      this.lastTime = time;
      return 1 / 60;
    }
    const next = time;
    const raw = next - this.lastTime;
    this.lastTime = next;
    if (!Number.isFinite(raw) || raw <= 0) {
      return 1 / 60;
    }
    return THREE.MathUtils.clamp(raw, 1 / 240, 0.08);
  }

  private reseedFlockTarget(seed: number): void {
    const rng = createRng(seed ^ 0x3adf91c7);
    const maxOffset = (this.half - BIRD_TARGET_MARGIN) * 0.72;
    const angle = rng() * TAU;
    const radius = (0.18 + rng() * 0.56) * maxOffset;
    this.flockTargetX = Math.cos(angle) * radius;
    this.flockTargetZ = Math.sin(angle) * radius;
    this.flockDriftX = (rng() - 0.5) * 0.02;
    this.flockDriftZ = (rng() - 0.5) * 0.02;
  }

  private advanceFlockTarget(
    time: number,
    windX: number,
    windZ: number,
    windStrength: number,
    windGustiness: number,
    delta: number
  ): void {
    const noiseX =
      Math.sin(time * 0.11 + this.seed * 0.0017) +
      Math.sin(time * 0.047 + this.seed * 0.0033) * 0.5;
    const noiseZ =
      Math.cos(time * 0.1 + this.seed * 0.0021) +
      Math.sin(time * 0.053 + this.seed * 0.0013) * 0.48;
    const gustAngle = time * 0.28 + this.seed * 0.0029;
    const gustX = Math.cos(gustAngle) * windGustiness;
    const gustZ = Math.sin(gustAngle * 1.13 + 1.7) * windGustiness;
    const accelScale = delta * 60;
    this.flockDriftX +=
      (noiseX * 0.0009 + windX * (0.001 + windStrength * 0.0014) + gustX * 0.00095) * accelScale;
    this.flockDriftZ +=
      (noiseZ * 0.0009 + windZ * (0.001 + windStrength * 0.0014) + gustZ * 0.00095) * accelScale;
    const centerPull = (0.00072 + windStrength * 0.0002) * accelScale;
    this.flockDriftX += -this.flockTargetX * centerPull;
    this.flockDriftZ += -this.flockTargetZ * centerPull;
    this.flockDriftX *= 0.982;
    this.flockDriftZ *= 0.982;

    const driftSpeed = Math.hypot(this.flockDriftX, this.flockDriftZ);
    const maxDriftSpeed = 0.06 + windStrength * 0.025;
    if (driftSpeed > maxDriftSpeed) {
      const inv = maxDriftSpeed / Math.max(driftSpeed, 0.0001);
      this.flockDriftX *= inv;
      this.flockDriftZ *= inv;
    }

    this.flockTargetX += this.flockDriftX * accelScale;
    this.flockTargetZ += this.flockDriftZ * accelScale;
    const limit = this.half - BIRD_TARGET_MARGIN;
    const softLimit = limit * 0.8;
    const targetDistance = Math.hypot(this.flockTargetX, this.flockTargetZ);
    if (targetDistance > softLimit) {
      const overflow = targetDistance - softLimit;
      const invDist = 1 / Math.max(targetDistance, 0.0001);
      const nx = this.flockTargetX * invDist;
      const nz = this.flockTargetZ * invDist;
      const push = (0.0038 + overflow * 0.012) * accelScale;
      this.flockDriftX -= nx * push;
      this.flockDriftZ -= nz * push;
      this.flockTargetX -= nx * overflow * 0.52;
      this.flockTargetZ -= nz * overflow * 0.52;
    }
    const clampedDistance = Math.hypot(this.flockTargetX, this.flockTargetZ);
    if (clampedDistance > limit) {
      const inv = 1 / Math.max(clampedDistance, 0.0001);
      const nx = this.flockTargetX * inv;
      const nz = this.flockTargetZ * inv;
      this.flockTargetX = nx * limit;
      this.flockTargetZ = nz * limit;
      const radialOut = this.flockDriftX * nx + this.flockDriftZ * nz;
      if (radialOut > 0) {
        this.flockDriftX -= nx * radialOut * 1.45;
        this.flockDriftZ -= nz * radialOut * 1.45;
      }
    }
  }

  private reseedBirds(seed: number): void {
    const rng = createRng(seed ^ 0x51c3dd89);
    this.birds = [];
    for (let index = 0; index < BIRD_MAX; index += 1) {
      const x = (rng() - 0.5) * (this.size - 14);
      const z = (rng() - 0.5) * (this.size - 14);
      const y = 6 + rng() * 6.5;
      const vx = (rng() - 0.5) * 0.16;
      const vy = (rng() - 0.5) * 0.05;
      const vz = (rng() - 0.5) * 0.16;
      this.birds.push({
        x,
        y,
        z,
        vx,
        vy,
        vz,
        phase: rng() * TAU,
        activityThreshold: 0.08 + rng() * 0.82
      });
    }
  }

  private reseedInsects(seed: number): void {
    const targetCount = computeInsectTargetCount(this.spawnableCells.length);
    if (targetCount === 0) {
      this.insects = [];
      this.insectMesh.count = 0;
      this.diagnostics.insectsTotal = 0;
      this.diagnostics.spawnableWaterEdgeCells = 0;
      return;
    }
    const rng = createRng(seed ^ 0xb9a3f27d);
    const insects: InsectAgent[] = [];
    for (let index = 0; index < targetCount; index += 1) {
      insects.push(this.createInsectAgent({ rng, seed, index }));
    }
    this.insects = insects;
    this.diagnostics.insectsTotal = insects.length;
    this.diagnostics.spawnableWaterEdgeCells = this.spawnableCells.length;
  }

  private createInsectAgent(options: InsectSpawnOptions): InsectAgent {
    const { rng, seed, index } = options;
    const cell = this.spawnableCells[Math.floor(rng() * this.spawnableCells.length)];
    if (!cell) {
      return {
        homeX: 0,
        homeZ: 0,
        orbitRadius: 0.16,
        orbitAngle: 0,
        orbitSpeed: 1,
        baseHeight: 0.2,
        flutterPhase: 0,
        driftScale: 0.3,
        activityThreshold: 1,
        x: 0,
        y: 0.2,
        z: 0
      };
    }
    const noise = hashNoise(cell.x + index * 0.07, cell.y - index * 0.09, seed);
    const homeX = cell.x - this.half + (rng() - 0.5) * 0.58;
    const homeZ = cell.y - this.half + (rng() - 0.5) * 0.58;
    const orbitRadius = 0.08 + rng() * 0.42;
    const orbitAngle = rng() * TAU;
    const orbitSpeed = 0.7 + rng() * 1.6;
    const baseHeight = 0.12 + rng() * 0.26 + noise * 0.05;
    const flutterPhase = rng() * TAU;
    const driftScale = 0.22 + rng() * 0.92;
    return {
      homeX,
      homeZ,
      orbitRadius,
      orbitAngle,
      orbitSpeed,
      baseHeight,
      flutterPhase,
      driftScale,
      activityThreshold: 0.08 + rng() * 0.88,
      x: homeX,
      y: baseHeight,
      z: homeZ
    };
  }

  private sampleTerrainHeight(worldX: number, worldZ: number): number {
    const terrain = this.terrain;
    if (!terrain) {
      return 0;
    }
    const gx = THREE.MathUtils.clamp(worldX + this.half, 0, this.size - 1);
    const gz = THREE.MathUtils.clamp(worldZ + this.half, 0, this.size - 1);
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(this.size - 1, x0 + 1);
    const z1 = Math.min(this.size - 1, z0 + 1);
    const tx = gx - x0;
    const tz = gz - z0;
    const h00 = terrain[toIndex(this.size, x0, z0)];
    const h10 = terrain[toIndex(this.size, x1, z0)];
    const h01 = terrain[toIndex(this.size, x0, z1)];
    const h11 = terrain[toIndex(this.size, x1, z1)];
    const hx0 = h00 + (h10 - h00) * tx;
    const hx1 = h01 + (h11 - h01) * tx;
    return hx0 + (hx1 - hx0) * tz;
  }
}
