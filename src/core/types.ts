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

export interface LifeUpdateState {
  daylight: number;
  rainIntensity: number;
  windStrength: number;
  windDirection: number;
  windGustiness: number;
  time: number;
  cameraX: number;
  cameraZ: number;
}

export interface LifeDiagnostics {
  birdsTotal: number;
  birdsActive: number;
  insectsTotal: number;
  insectsActive: number;
  nearCameraBirds: number;
  nearCameraInsects: number;
  spawnableWaterEdgeCells: number;
}
