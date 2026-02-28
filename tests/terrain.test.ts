import { describe, expect, test } from 'vitest';
import { applyBrush } from '../src/core/terrain';
import type { BrushSettings, WorldState } from '../src/core/types';

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

describe('terrain brush', () => {
  test('applies brush at edges without out-of-range access', () => {
    const world = makeWorld(12);
    const brush: BrushSettings = {
      radius: 8,
      strength: 0.6,
      flattenHeight: 0
    };

    expect(() => applyBrush(world, 0, 0, 'raise', brush)).not.toThrow();
    expect(() => applyBrush(world, 11, 11, 'lower', brush)).not.toThrow();

    expect(world.terrain).toHaveLength(144);
  });

  test('flatten converges towards target height', () => {
    const world = makeWorld(9);
    world.terrain.fill(10);

    const brush: BrushSettings = {
      radius: 4,
      strength: 0.5,
      flattenHeight: 0
    };

    let previousAbs = Math.abs(world.terrain[4 * world.size + 4]);

    for (let step = 0; step < 8; step += 1) {
      applyBrush(world, 4, 4, 'flatten', brush);
      const currentAbs = Math.abs(world.terrain[4 * world.size + 4]);
      expect(currentAbs).toBeLessThan(previousAbs);
      previousAbs = currentAbs;
    }
  });
});
