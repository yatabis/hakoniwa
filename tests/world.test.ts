import { describe, expect, test } from 'vitest';
import { createInitialWorld, MAX_TERRAIN_HEIGHT, MIN_TERRAIN_HEIGHT } from '../src/core/world';

describe('initial terrain generation', () => {
  test('is deterministic for a fixed terrain seed', () => {
    const worldA = createInitialWorld(64, 123456);
    const worldB = createInitialWorld(64, 123456);

    expect(worldA.terrain).toHaveLength(worldB.terrain.length);
    for (let index = 0; index < worldA.terrain.length; index += 1) {
      expect(worldA.terrain[index]).toBeCloseTo(worldB.terrain[index], 6);
    }

    expect(worldA.sources).toEqual(worldB.sources);
  });

  test('creates varied terrain within bounds', () => {
    const world = createInitialWorld(64, 891011);

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;

    for (let index = 0; index < world.terrain.length; index += 1) {
      const value = world.terrain[index];
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }

    const average = sum / world.terrain.length;

    expect(min).toBeGreaterThanOrEqual(MIN_TERRAIN_HEIGHT);
    expect(max).toBeLessThanOrEqual(MAX_TERRAIN_HEIGHT);
    expect(max - min).toBeGreaterThan(2.8);
    expect(Math.abs(average)).toBeLessThan(4.5);
  });

  test('spawns at least one active initial water source', () => {
    const world = createInitialWorld(64, 991827);

    expect(world.sources.length).toBeGreaterThanOrEqual(1);

    const source = world.sources[0];
    if (!source) {
      throw new Error('Expected an initial source');
    }

    expect(source.active).toBe(true);
    expect(source.x).toBeGreaterThanOrEqual(0);
    expect(source.x).toBeLessThan(world.size);
    expect(source.y).toBeGreaterThanOrEqual(0);
    expect(source.y).toBeLessThan(world.size);
    expect(source.rate).toBeGreaterThan(0);
  });
});
