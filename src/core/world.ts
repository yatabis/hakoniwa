import { clamp, toIndex } from './grid';
import type { WaterSource, WorldState } from './types';

export const WORLD_VERSION = 1;
export const DEFAULT_WORLD_SIZE = 128;
export const MIN_TERRAIN_HEIGHT = -12;
export const MAX_TERRAIN_HEIGHT = 24;

function fract(value: number): number {
  return value - Math.floor(value);
}

function hash2D(x: number, y: number, seed: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 0.00137) * 43758.5453123;
  return fract(value);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const tx = x - x0;
  const ty = y - y0;

  const v00 = hash2D(x0, y0, seed);
  const v10 = hash2D(x1, y0, seed);
  const v01 = hash2D(x0, y1, seed);
  const v11 = hash2D(x1, y1, seed);

  const sx = smoothstep(tx);
  const sy = smoothstep(ty);

  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

function fractalNoise(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  lacunarity: number,
  gain: number
): number {
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  let weight = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise(x * frequency, y * frequency, seed + octave * 97) * amplitude;
    weight += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return weight > 0 ? total / weight : 0;
}

function smoothTerrain(terrain: Float32Array, size: number, blend: number): void {
  const source = new Float32Array(terrain);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = toIndex(size, x, y);
      let total = 0;
      let count = 0;

      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || nx >= size || ny < 0 || ny >= size) {
            continue;
          }

          total += source[toIndex(size, nx, ny)];
          count += 1;
        }
      }

      const average = total / Math.max(1, count);
      terrain[index] = source[index] * (1 - blend) + average * blend;
    }
  }
}

function generateBaseTerrain(size: number, seed: number): Float32Array {
  const terrain = new Float32Array(size * size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = toIndex(size, x, y);
      const nx = x / (size - 1);
      const ny = y / (size - 1);
      const cx = nx * 2 - 1;
      const cy = ny * 2 - 1;
      const radial = Math.sqrt(cx * cx + cy * cy);

      const macro = fractalNoise(nx * 3.4 + 14.3, ny * 3.4 + 8.9, seed, 5, 2.08, 0.52);
      const detail = fractalNoise(nx * 18.8 + 71.1, ny * 18.8 + 39.7, seed + 999, 4, 2.2, 0.46);
      const ridgeBase = fractalNoise(nx * 5.7 + 2.7, ny * 5.7 + 6.4, seed + 313, 4, 2.03, 0.5);
      const ridges = 1 - Math.abs(ridgeBase * 2 - 1);
      const warp =
        (fractalNoise(nx * 7.2 + 11.1, ny * 7.2 + 4.2, seed + 1703, 3, 2.0, 0.5) - 0.5) * 0.72;

      const continent = (macro - 0.5) * 13.8;
      const mountain = Math.pow(ridges, 1.35) * 8.6;
      const fold =
        Math.sin((nx * 1.45 + ny * 1.2 + macro * 0.8 + seed * 0.000012) * Math.PI * 2) * 1.35;
      const valleyAxis = cy + warp + Math.sin(cx * 3.1 + seed * 0.00021) * 0.2;
      const riverValley = -Math.exp(-Math.pow(valleyAxis * 4.2, 2)) * 4.5;
      const coastalDrop = -Math.pow(Math.max(0, radial - 0.7) * 3.8, 2) * 3.3;
      const micro = (detail - 0.5) * 1.9;

      const height = continent + mountain + fold + riverValley + coastalDrop + micro;
      terrain[idx] = clamp(height, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT);
    }
  }

  smoothTerrain(terrain, size, 0.16);
  smoothTerrain(terrain, size, 0.08);

  return terrain;
}

function findHighestInteriorCell(
  terrain: Float32Array,
  size: number,
  margin: number
): { x: number; y: number; height: number } | null {
  let bestIndex = -1;
  let bestHeight = Number.NEGATIVE_INFINITY;

  for (let y = margin; y < size - margin; y += 1) {
    for (let x = margin; x < size - margin; x += 1) {
      const index = toIndex(size, x, y);
      const height = terrain[index];
      if (height > bestHeight) {
        bestHeight = height;
        bestIndex = index;
      }
    }
  }

  if (bestIndex < 0) {
    return null;
  }

  return {
    x: bestIndex % size,
    y: Math.floor(bestIndex / size),
    height: bestHeight
  };
}

function generateInitialSources(terrain: Float32Array, size: number): WaterSource[] {
  const margin = Math.max(2, Math.floor(size * 0.06));
  const peak = findHighestInteriorCell(terrain, size, margin);
  if (!peak) {
    return [];
  }

  const normalizedPeak = clamp((peak.height + 4) / 20, 0, 1);
  const rate = 1.1 + normalizedPeak * 0.95;

  return [
    {
      id: 'source-1',
      x: peak.x,
      y: peak.y,
      rate: Number(rate.toFixed(2)),
      active: true
    }
  ];
}

export function createInitialWorld(
  size = DEFAULT_WORLD_SIZE,
  terrainSeed = Math.floor(Math.random() * 10_000_000)
): WorldState {
  const terrain = generateBaseTerrain(size, terrainSeed);

  return {
    version: WORLD_VERSION,
    size,
    terrainSeed,
    terrain,
    water: new Float32Array(size * size),
    sources: generateInitialSources(terrain, size),
    vegetationSeed: Math.floor(Math.random() * 10_000_000),
    time: 0
  };
}

export function cloneWorldState(state: WorldState): WorldState {
  return {
    version: state.version,
    size: state.size,
    terrainSeed: state.terrainSeed,
    terrain: new Float32Array(state.terrain),
    water: new Float32Array(state.water),
    sources: state.sources.map((source) => ({ ...source })),
    vegetationSeed: state.vegetationSeed,
    time: state.time
  };
}
