import { clamp, inBounds, toIndex } from './grid';
import { MAX_TERRAIN_HEIGHT, MIN_TERRAIN_HEIGHT } from './world';
import type { BrushSettings, ToolMode, WorldState } from './types';

export function applyBrush(
  state: WorldState,
  cx: number,
  cy: number,
  tool: ToolMode,
  brush: BrushSettings
): void {
  if (tool === 'waterSource') {
    return;
  }

  const radius = Math.max(1, brush.radius);
  const strength = clamp(brush.strength, 0.01, 1);
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(state.size - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(state.size - 1, Math.ceil(cy + radius));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > radius) {
        continue;
      }

      const falloff = 1 - distance / radius;
      const influence = falloff * strength;
      const index = toIndex(state.size, x, y);
      const current = state.terrain[index];

      let next = current;
      if (tool === 'raise') {
        next = current + influence;
      } else if (tool === 'lower') {
        next = current - influence;
      } else if (tool === 'flatten') {
        next = current + (brush.flattenHeight - current) * influence;
      }

      state.terrain[index] = clamp(next, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT);
    }
  }
}

export function computeSlopeAt(terrain: Float32Array, size: number, x: number, y: number): number {
  if (!inBounds(size, x, y)) {
    return 0;
  }

  const xm = Math.max(0, x - 1);
  const xp = Math.min(size - 1, x + 1);
  const ym = Math.max(0, y - 1);
  const yp = Math.min(size - 1, y + 1);

  const left = terrain[toIndex(size, xm, y)];
  const right = terrain[toIndex(size, xp, y)];
  const down = terrain[toIndex(size, x, ym)];
  const up = terrain[toIndex(size, x, yp)];

  const dx = (right - left) * 0.5;
  const dy = (up - down) * 0.5;
  return Math.sqrt(dx * dx + dy * dy);
}
