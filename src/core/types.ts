export type ToolMode = 'raise' | 'lower' | 'flatten' | 'waterSource';

export interface BrushSettings {
  radius: number;
  strength: number;
  flattenHeight: number;
}

export interface WaterSource {
  id: string;
  x: number;
  y: number;
  rate: number;
  active: boolean;
}

export interface WorldState {
  version: 1;
  size: number;
  terrainSeed: number;
  terrain: Float32Array;
  water: Float32Array;
  sources: WaterSource[];
  vegetationSeed: number;
  time: number;
}

export interface SimParams {
  dt: number;
  flowRate: number;
  damping: number;
  evaporation: number;
  seepage?: number;
  edgeDrain?: number;
}
