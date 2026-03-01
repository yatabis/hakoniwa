import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { LifeSystem } from '../src/render/life';

function createMaps(size: number): {
  terrain: Float32Array;
  water: Float32Array;
  humidity: Float32Array;
} {
  const terrain = new Float32Array(size * size);
  const water = new Float32Array(size * size);
  const humidity = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      terrain[index] = Math.sin(x * 0.15) * 1.2 + Math.cos(y * 0.13) * 0.9;
      const nearCenter = Math.hypot(x - size * 0.45, y - size * 0.55);
      water[index] = nearCenter < size * 0.18 ? 0.12 : 0.01;
      humidity[index] = nearCenter < size * 0.22 ? 0.36 : 0.18;
    }
  }
  return { terrain, water, humidity };
}

function updateSystem(
  system: LifeSystem,
  overrides: Partial<{
    daylight: number;
    rainIntensity: number;
    windStrength: number;
    windDirection: number;
    windGustiness: number;
    time: number;
    cameraX: number;
    cameraZ: number;
  }>
): void {
  system.update({
    daylight: 0.65,
    rainIntensity: 0.1,
    windStrength: 0.4,
    windDirection: Math.PI * 0.2,
    windGustiness: 0.3,
    time: 1,
    cameraX: 0,
    cameraZ: 0,
    ...overrides
  });
}

describe('life system', () => {
  test('is deterministic for fixed seed and identical inputs', () => {
    const size = 32;
    const maps = createMaps(size);
    const sceneA = new THREE.Scene();
    const sceneB = new THREE.Scene();
    const lifeA = new LifeSystem(size, 12876, sceneA);
    const lifeB = new LifeSystem(size, 12876, sceneB);
    lifeA.rebuildHabitat(maps.terrain, maps.water, maps.humidity, 12876);
    lifeB.rebuildHabitat(maps.terrain, maps.water, maps.humidity, 12876);

    updateSystem(lifeA, { time: 2.0, cameraX: 2, cameraZ: -3 });
    updateSystem(lifeB, { time: 2.0, cameraX: 2, cameraZ: -3 });

    const snapshotA = lifeA.getAgentSnapshot();
    const snapshotB = lifeB.getAgentSnapshot();

    expect(snapshotA.birds).toHaveLength(snapshotB.birds.length);
    expect(snapshotA.insects).toHaveLength(snapshotB.insects.length);
    for (let index = 0; index < snapshotA.birds.length; index += 1) {
      const a = snapshotA.birds[index];
      const b = snapshotB.birds[index];
      if (!a || !b) {
        throw new Error('Expected bird snapshots');
      }
      expect(a.x).toBeCloseTo(b.x, 6);
      expect(a.y).toBeCloseTo(b.y, 6);
      expect(a.z).toBeCloseTo(b.z, 6);
    }
    for (let index = 0; index < snapshotA.insects.length; index += 1) {
      const a = snapshotA.insects[index];
      const b = snapshotB.insects[index];
      if (!a || !b) {
        throw new Error('Expected insect snapshots');
      }
      expect(a.x).toBeCloseTo(b.x, 6);
      expect(a.y).toBeCloseTo(b.y, 6);
      expect(a.z).toBeCloseTo(b.z, 6);
    }

    lifeA.dispose();
    lifeB.dispose();
  });

  test('reduces active birds under heavy rain', () => {
    const size = 32;
    const maps = createMaps(size);
    const life = new LifeSystem(size, 8892, new THREE.Scene());
    life.rebuildHabitat(maps.terrain, maps.water, maps.humidity, 8892);

    updateSystem(life, { rainIntensity: 0.12, daylight: 0.7, time: 2.1 });
    const calm = life.getDiagnostics();
    updateSystem(life, { rainIntensity: 1, daylight: 0.7, time: 3.4 });
    const storm = life.getDiagnostics();

    expect(calm.birdsActive).toBeGreaterThan(0);
    expect(storm.birdsActive).toBeLessThan(calm.birdsActive);
    life.dispose();
  });

  test('keeps insects near zero when no spawnable water-edge cells exist', () => {
    const size = 28;
    const terrain = new Float32Array(size * size);
    const water = new Float32Array(size * size);
    const humidity = new Float32Array(size * size);
    humidity.fill(0.02);
    const life = new LifeSystem(size, 5542, new THREE.Scene());
    life.rebuildHabitat(terrain, water, humidity, 5542);
    updateSystem(life, { time: 1.7 });

    const diagnostics = life.getDiagnostics();
    expect(diagnostics.spawnableWaterEdgeCells).toBe(0);
    expect(diagnostics.insectsTotal).toBe(0);
    expect(diagnostics.insectsActive).toBe(0);
    life.dispose();
  });

  test('does not reseed insects on repeated habitat rebuild with same seed', () => {
    const size = 32;
    const maps = createMaps(size);
    const life = new LifeSystem(size, 7771, new THREE.Scene());
    life.rebuildHabitat(maps.terrain, maps.water, maps.humidity, 7771);
    updateSystem(life, { time: 2.2 });

    const before = life.getAgentSnapshot().insects;
    life.rebuildHabitat(maps.terrain, maps.water, maps.humidity, 7771);
    const after = life.getAgentSnapshot().insects;

    expect(after).toHaveLength(before.length);
    for (let index = 0; index < before.length; index += 1) {
      const prev = before[index];
      const next = after[index];
      if (!prev || !next) {
        throw new Error('Expected insect snapshots');
      }
      expect(next.x).toBeCloseTo(prev.x, 6);
      expect(next.y).toBeCloseTo(prev.y, 6);
      expect(next.z).toBeCloseTo(prev.z, 6);
    }
    life.dispose();
  });

  test('keeps bird and insect coordinates within world bounds over time', () => {
    const size = 36;
    const maps = createMaps(size);
    const life = new LifeSystem(size, 10101, new THREE.Scene());
    life.rebuildHabitat(maps.terrain, maps.water, maps.humidity, 10101);

    let time = 1;
    for (let step = 0; step < 240; step += 1) {
      time += 1 / 60;
      updateSystem(life, {
        time,
        daylight: 0.28 + Math.sin(step * 0.06) * 0.2 + 0.3,
        rainIntensity: 0.25 + Math.sin(step * 0.09) * 0.2,
        windStrength: 0.4 + Math.sin(step * 0.07) * 0.25,
        windDirection: step * 0.05,
        windGustiness: 0.35 + Math.sin(step * 0.04) * 0.2
      });
    }

    const half = (size - 1) * 0.5;
    const snapshot = life.getAgentSnapshot();
    for (const bird of snapshot.birds) {
      expect(Number.isFinite(bird.x)).toBe(true);
      expect(Number.isFinite(bird.y)).toBe(true);
      expect(Number.isFinite(bird.z)).toBe(true);
      expect(bird.x).toBeGreaterThanOrEqual(-half - 0.001);
      expect(bird.x).toBeLessThanOrEqual(half + 0.001);
      expect(bird.z).toBeGreaterThanOrEqual(-half - 0.001);
      expect(bird.z).toBeLessThanOrEqual(half + 0.001);
    }
    for (const insect of snapshot.insects) {
      expect(Number.isFinite(insect.x)).toBe(true);
      expect(Number.isFinite(insect.y)).toBe(true);
      expect(Number.isFinite(insect.z)).toBe(true);
      expect(insect.x).toBeGreaterThanOrEqual(-half - 0.001);
      expect(insect.x).toBeLessThanOrEqual(half + 0.001);
      expect(insect.z).toBeGreaterThanOrEqual(-half - 0.001);
      expect(insect.z).toBeLessThanOrEqual(half + 0.001);
    }
    life.dispose();
  });
});
