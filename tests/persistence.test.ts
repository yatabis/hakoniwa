import { describe, expect, test } from 'vitest';
import { deserializeWorld, serializeWorld } from '../src/persistence/storage';
import type { WorldState } from '../src/core/types';

function makeWorld(size: number): WorldState {
  const terrain = new Float32Array(size * size);
  const water = new Float32Array(size * size);

  for (let index = 0; index < terrain.length; index += 1) {
    terrain[index] = Math.sin(index * 0.3) * 2;
    water[index] = Math.max(0, Math.cos(index * 0.4) * 0.8);
  }

  return {
    version: 1,
    size,
    terrainSeed: 424242,
    terrain,
    water,
    sources: [
      {
        id: 'source-1',
        x: 2,
        y: 3,
        rate: 1.4,
        active: true
      }
    ],
    vegetationSeed: 987,
    time: 12.5
  };
}

describe('world persistence payload', () => {
  test('round-trips state through serialize/deserialize', async () => {
    const original = makeWorld(6);
    const data = await serializeWorld(original);
    const restored = await deserializeWorld(data);

    expect(restored.size).toBe(original.size);
    expect(restored.version).toBe(original.version);
    expect(restored.terrainSeed).toBe(original.terrainSeed);
    expect(restored.vegetationSeed).toBe(original.vegetationSeed);
    expect(restored.time).toBeCloseTo(original.time, 5);
    expect(restored.sources).toEqual(original.sources);

    for (let index = 0; index < original.terrain.length; index += 1) {
      expect(restored.terrain[index]).toBeCloseTo(original.terrain[index], 5);
      expect(restored.water[index]).toBeCloseTo(original.water[index], 5);
    }
  });
});
