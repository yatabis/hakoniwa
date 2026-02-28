import { describe, expect, test } from 'vitest';
import { stepWater, totalWater } from '../src/core/water';
import type { SimParams, WorldState } from '../src/core/types';

function makeWorld(size: number): WorldState {
  return {
    version: 1,
    size,
    terrainSeed: 0,
    terrain: new Float32Array(size * size),
    water: new Float32Array(size * size),
    sources: [],
    vegetationSeed: 1,
    time: 0
  };
}

describe('water simulation', () => {
  test('preserves mass when damping and evaporation are disabled', () => {
    const world = makeWorld(8);

    for (let index = 0; index < world.water.length; index += 1) {
      world.water[index] = (index % 5) * 0.2;
    }

    const params: SimParams = {
      dt: 1 / 30,
      flowRate: 1.4,
      damping: 0,
      evaporation: 0
    };

    const before = totalWater(world);
    stepWater(world, params);
    const after = totalWater(world);

    expect(after).toBeCloseTo(before, 5);
  });

  test('distributes center water symmetrically on flat terrain', () => {
    const world = makeWorld(5);
    world.water[2 + 2 * 5] = 1;

    const params: SimParams = {
      dt: 1,
      flowRate: 1,
      damping: 0,
      evaporation: 0
    };

    stepWater(world, params);

    const right = world.water[3 + 2 * 5];
    const left = world.water[1 + 2 * 5];
    const up = world.water[2 + 3 * 5];
    const down = world.water[2 + 1 * 5];

    expect(right).toBeCloseTo(left, 6);
    expect(up).toBeCloseTo(down, 6);
    expect(right).toBeCloseTo(up, 6);
  });
});
