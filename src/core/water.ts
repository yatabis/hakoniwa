import { clamp, inBounds, toIndex } from './grid';
import type { SimParams, WorldState } from './types';

const scratchByLength = new Map<number, Float32Array>();

export interface CellWaterDiagnostics {
  x: number;
  y: number;
  index: number;
  isEdge: boolean;
  terrainHeight: number;
  waterHeight: number;
  totalHeight: number;
  neighborTotalHeights: {
    right: number | null;
    left: number | null;
    up: number | null;
    down: number | null;
  };
  downhillDiffs: {
    right: number;
    left: number;
    up: number;
    down: number;
  };
  outflowPotentials: {
    right: number;
    left: number;
    up: number;
    down: number;
  };
  seepageLossPerStep: number;
  edgeDrainLossPerStep: number;
}

function getScratch(length: number): Float32Array {
  const existing = scratchByLength.get(length);
  if (existing) {
    existing.fill(0);
    return existing;
  }

  const created = new Float32Array(length);
  scratchByLength.set(length, created);
  return created;
}

export function stepWater(state: WorldState, params: SimParams): void {
  const dt = Math.max(0.0001, params.dt);
  const flowRate = Math.max(0, params.flowRate);
  const damping = Math.max(0, params.damping);
  const evaporation = Math.max(0, params.evaporation);
  const seepage = Math.max(0, params.seepage ?? 0);
  const edgeDrain = Math.max(0, params.edgeDrain ?? 0);

  for (const source of state.sources) {
    if (!source.active) {
      continue;
    }

    const sx = Math.round(source.x);
    const sy = Math.round(source.y);
    if (!inBounds(state.size, sx, sy)) {
      continue;
    }

    const sourceIndex = toIndex(state.size, sx, sy);
    state.water[sourceIndex] += Math.max(0, source.rate) * dt;
  }

  const delta = getScratch(state.water.length);

  for (let y = 0; y < state.size; y += 1) {
    for (let x = 0; x < state.size; x += 1) {
      const index = toIndex(state.size, x, y);
      const currentWater = state.water[index];

      if (currentWater <= 0) {
        continue;
      }

      const totalHeight = state.terrain[index] + currentWater;

      let rightPotential = 0;
      let leftPotential = 0;
      let upPotential = 0;
      let downPotential = 0;
      let rightIndex = -1;
      let leftIndex = -1;
      let upIndex = -1;
      let downIndex = -1;

      if (x + 1 < state.size) {
        rightIndex = toIndex(state.size, x + 1, y);
        const diff = totalHeight - (state.terrain[rightIndex] + state.water[rightIndex]);
        if (diff > 0) {
          rightPotential = diff * flowRate * dt;
        }
      }

      if (x - 1 >= 0) {
        leftIndex = toIndex(state.size, x - 1, y);
        const diff = totalHeight - (state.terrain[leftIndex] + state.water[leftIndex]);
        if (diff > 0) {
          leftPotential = diff * flowRate * dt;
        }
      }

      if (y + 1 < state.size) {
        upIndex = toIndex(state.size, x, y + 1);
        const diff = totalHeight - (state.terrain[upIndex] + state.water[upIndex]);
        if (diff > 0) {
          upPotential = diff * flowRate * dt;
        }
      }

      if (y - 1 >= 0) {
        downIndex = toIndex(state.size, x, y - 1);
        const diff = totalHeight - (state.terrain[downIndex] + state.water[downIndex]);
        if (diff > 0) {
          downPotential = diff * flowRate * dt;
        }
      }

      const totalPotential = rightPotential + leftPotential + upPotential + downPotential;
      if (totalPotential <= 0) {
        continue;
      }

      const scale = Math.min(1, currentWater / totalPotential);

      if (rightPotential > 0 && rightIndex >= 0) {
        const amount = rightPotential * scale;
        delta[index] -= amount;
        delta[rightIndex] += amount;
      }

      if (leftPotential > 0 && leftIndex >= 0) {
        const amount = leftPotential * scale;
        delta[index] -= amount;
        delta[leftIndex] += amount;
      }

      if (upPotential > 0 && upIndex >= 0) {
        const amount = upPotential * scale;
        delta[index] -= amount;
        delta[upIndex] += amount;
      }

      if (downPotential > 0 && downIndex >= 0) {
        const amount = downPotential * scale;
        delta[index] -= amount;
        delta[downIndex] += amount;
      }
    }
  }

  const dampingFactor = clamp(1 - damping * dt, 0, 1);
  const evaporationLoss = evaporation * dt;

  for (let y = 0; y < state.size; y += 1) {
    for (let x = 0; x < state.size; x += 1) {
      const index = toIndex(state.size, x, y);
      const withFlow = state.water[index] + delta[index];
      const seepLoss = withFlow * seepage * dt;
      let next = withFlow * dampingFactor - evaporationLoss - seepLoss;

      const isEdge = x === 0 || y === 0 || x === state.size - 1 || y === state.size - 1;
      if (isEdge && next > 0) {
        next -= edgeDrain * dt;
      }

      state.water[index] = Math.max(0, next);
    }
  }
}

export function totalWater(state: WorldState): number {
  let total = 0;
  for (let index = 0; index < state.water.length; index += 1) {
    total += state.water[index];
  }
  return total;
}

export function sampleCellWaterDiagnostics(
  state: WorldState,
  params: SimParams,
  x: number,
  y: number
): CellWaterDiagnostics | null {
  if (!inBounds(state.size, x, y)) {
    return null;
  }

  const dt = Math.max(0.0001, params.dt);
  const flowRate = Math.max(0, params.flowRate);
  const seepage = Math.max(0, params.seepage ?? 0);
  const edgeDrain = Math.max(0, params.edgeDrain ?? 0);

  const index = toIndex(state.size, x, y);
  const terrainHeight = state.terrain[index];
  const waterHeight = state.water[index];
  const totalHeight = terrainHeight + waterHeight;

  const rightIndex = x + 1 < state.size ? toIndex(state.size, x + 1, y) : null;
  const leftIndex = x - 1 >= 0 ? toIndex(state.size, x - 1, y) : null;
  const upIndex = y + 1 < state.size ? toIndex(state.size, x, y + 1) : null;
  const downIndex = y - 1 >= 0 ? toIndex(state.size, x, y - 1) : null;

  const rightTotal =
    rightIndex === null ? null : state.terrain[rightIndex] + state.water[rightIndex];
  const leftTotal = leftIndex === null ? null : state.terrain[leftIndex] + state.water[leftIndex];
  const upTotal = upIndex === null ? null : state.terrain[upIndex] + state.water[upIndex];
  const downTotal = downIndex === null ? null : state.terrain[downIndex] + state.water[downIndex];

  const rightDiff = rightTotal === null ? 0 : Math.max(0, totalHeight - rightTotal);
  const leftDiff = leftTotal === null ? 0 : Math.max(0, totalHeight - leftTotal);
  const upDiff = upTotal === null ? 0 : Math.max(0, totalHeight - upTotal);
  const downDiff = downTotal === null ? 0 : Math.max(0, totalHeight - downTotal);

  const isEdge = x === 0 || y === 0 || x === state.size - 1 || y === state.size - 1;

  return {
    x,
    y,
    index,
    isEdge,
    terrainHeight,
    waterHeight,
    totalHeight,
    neighborTotalHeights: {
      right: rightTotal,
      left: leftTotal,
      up: upTotal,
      down: downTotal
    },
    downhillDiffs: {
      right: rightDiff,
      left: leftDiff,
      up: upDiff,
      down: downDiff
    },
    outflowPotentials: {
      right: rightDiff * flowRate * dt,
      left: leftDiff * flowRate * dt,
      up: upDiff * flowRate * dt,
      down: downDiff * flowRate * dt
    },
    seepageLossPerStep: waterHeight * seepage * dt,
    edgeDrainLossPerStep: isEdge ? edgeDrain * dt : 0
  };
}
