import './style.css';
import {
  applyBrush,
  computeSlopeAt,
  createInitialWorld,
  DEFAULT_WORLD_SIZE,
  sampleCellWaterDiagnostics,
  stepWater,
  totalWater
} from './core';
import type { BrushSettings, SimParams, ToolMode, WaterSource, WorldState } from './core';
import { InputController } from './input/controller';
import type { InteractionMode } from './input/controller';
import { loadWorldFromSlot, saveWorldToSlot } from './persistence/storage';
import { SceneView } from './render/scene';
import { Hud } from './ui/hud';
import type { DayCycleMode, WeatherMode, WindMode } from './ui/hud';

const TAU = Math.PI * 2;
const DAY_CYCLE_SECONDS = 24 * 60;
const DAY_START_HOUR = 7;
const HUMIDITY_DIFFUSION_RATE = 0.13;
const HUMIDITY_DIFFUSION_STEPS = 4;
const PHOTO_FOV_MIN = 30;
const PHOTO_FOV_MAX = 78;
const PHOTO_DOF_MIN = 0;
const PHOTO_DOF_MAX = 1;

interface ClimateState {
  dayPhase: number;
  daylight: number;
  cloudiness: number;
  rainIntensity: number;
  windStrength: number;
  windDirection: number;
  windGustiness: number;
}

interface WeatherOverride {
  cloudiness: number;
  rainIntensity: number;
}

interface WindOverride {
  strength: number;
  direction: number;
  gustiness: number;
}

type VegetationKind = 'canopy' | 'shrub' | 'grass';

interface VegetationCellDiagnostics {
  status: string;
  slope: number;
  moisture: number;
  riparian: number;
  fertility: number;
  densityNoise: number;
  densityLimit: number;
  canopySuitability: number;
  shrubSuitability: number;
  grassSuitability: number;
  selected: VegetationKind | 'none';
}

type HakoniwaDebugApi = {
  getWindDiagnostics: () => ReturnType<SceneView['getWindDiagnostics']>;
};

declare global {
  interface Window {
    __hakoniwaDebug?: HakoniwaDebugApi;
  }
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Failed to find #app root');
}

let world: WorldState = createInitialWorld(DEFAULT_WORLD_SIZE);

const brush: BrushSettings = {
  radius: 7,
  strength: 0.27,
  flattenHeight: 0
};

const simParams: SimParams = {
  dt: 1 / 60,
  flowRate: 1.8,
  damping: 0.025,
  evaporation: 0.0003,
  seepage: 0.04,
  edgeDrain: 0.3
};

let toolMode: ToolMode = 'raise';
let interactionMode: InteractionMode = 'edit';
let debugMode = false;
let dayCycleMode: DayCycleMode = 'simulation';
let manualDayHour = DAY_START_HOUR;
let weatherMode: WeatherMode = 'simulation';
let manualCloudiness = 0.35;
let manualRainIntensity = 0.08;
let windMode: WindMode = 'simulation';
let manualWindStrength = 0.42;
let manualWindDirection = 200;
let manualWindGustiness = 0.36;
let sourceRate = 1.2;
let sourceIdCounter = world.sources.length + 1;
let terrainSeed = world.terrainSeed;
let hoveredCell: { x: number; y: number } | null = null;
let previousDebugReadout = '';
let climateState: ClimateState = {
  dayPhase: 0,
  daylight: 1,
  cloudiness: 0.2,
  rainIntensity: 0,
  windStrength: manualWindStrength,
  windDirection: (manualWindDirection / 180) * Math.PI,
  windGustiness: manualWindGustiness
};
let photoMode = false;
let photoFov = 46;
let photoDof = 0.38;
let riverGuideVisible = true;
let interactionModeBeforePhoto: InteractionMode = interactionMode;
let humidityMap = new Float32Array(world.size * world.size);
let humidityScratch = new Float32Array(world.size * world.size);
let humidityStepCounter = 0;

function formatCellValue(value: number | null): string {
  if (value === null) {
    return '-';
  }
  return value.toFixed(3);
}

function hashCellNoise(x: number, y: number, seed: number): number {
  const value = Math.sin((x + seed * 0.001) * 12.9898 + (y - seed * 0.001) * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function sampleVegetationCellDiagnostics(
  state: WorldState,
  humidity: Float32Array,
  seed: number,
  vitality: number,
  x: number,
  y: number
): VegetationCellDiagnostics {
  const edgeResult: VegetationCellDiagnostics = {
    status: 'edge cell (vegetation disabled)',
    slope: 0,
    moisture: 0,
    riparian: 0,
    fertility: 0,
    densityNoise: 0,
    densityLimit: 0,
    canopySuitability: 0,
    shrubSuitability: 0,
    grassSuitability: 0,
    selected: 'none'
  };

  if (x <= 0 || y <= 0 || x >= state.size - 1 || y >= state.size - 1) {
    return edgeResult;
  }

  const index = y * state.size + x;
  const height = state.terrain[index];
  const wetness = state.water[index];
  const moisture = humidity[index] ?? 0;
  const slope = computeSlopeAt(state.terrain, state.size, x, y);

  const left = state.terrain[y * state.size + (x - 1)];
  const right = state.terrain[y * state.size + (x + 1)];
  const up = state.terrain[(y + 1) * state.size + x];
  const down = state.terrain[(y - 1) * state.size + x];
  const neighborAvg = (left + right + up + down) * 0.25;
  const valley = saturate((neighborAvg - height + 0.08) / 1.6);
  const ridge = saturate((height - neighborAvg - 0.12) / 1.5);
  const nearbyWetness = Math.max(
    wetness,
    state.water[y * state.size + (x - 1)],
    state.water[y * state.size + (x + 1)],
    state.water[(y - 1) * state.size + x],
    state.water[(y + 1) * state.size + x]
  );
  const riparian = saturate(nearbyWetness * 4.2);
  const altitude01 = saturate((height + 8) / 23);
  const clampedVitality = saturate(vitality);
  const fertility = saturate(
    moisture * 0.44 +
      riparian * 0.3 +
      valley * 0.24 +
      clampedVitality * 0.2 -
      slope * 0.37 -
      ridge * 0.22
  );

  const densityNoise = hashCellNoise(x + 17, y - 13, seed + 11);
  const densityLimit = fertility * 0.95;

  let status = 'spawn candidate';
  if (height < -7.5 || height > 14) {
    status = 'blocked: altitude range';
  } else if (wetness > 0.62) {
    status = 'blocked: underwater';
  } else if (moisture < 0.06) {
    status = 'blocked: low humidity';
  } else if (slope > 1.2) {
    status = 'blocked: slope too steep';
  } else if (fertility < 0.08) {
    status = 'blocked: low fertility';
  } else if (densityNoise > densityLimit) {
    status = 'blocked: density noise gate';
  }

  const canopySuitability =
    saturate(
      (1 - Math.abs(altitude01 - 0.42) * 1.9) *
        (1 - slope * 0.85) *
        (0.5 + moisture * 0.5) *
        (0.62 + valley * 0.3)
    ) * fertility;
  const shrubSuitability =
    saturate(
      (0.7 + valley * 0.2 + ridge * 0.16) *
        (1 - slope * 0.55) *
        (0.45 + moisture * 0.45 + riparian * 0.2) *
        (1 - Math.max(0, altitude01 - 0.82) * 1.3)
    ) * fertility;
  const grassSuitability =
    saturate(
      (0.65 + altitude01 * 0.5 + ridge * 0.24) *
        (1 - slope * 0.32) *
        (0.38 + moisture * 0.4 + clampedVitality * 0.22)
    ) * fertility;

  const canopyWeight = canopySuitability * 0.92;
  const shrubWeight = shrubSuitability * 1.08;
  const grassWeight = grassSuitability * 1.35;
  const totalWeight = canopyWeight + shrubWeight + grassWeight;

  let selected: VegetationKind | 'none' = 'none';
  if (totalWeight >= 0.04) {
    const pickNoise = hashCellNoise(x - 31, y + 47, seed + 211);
    const pick = pickNoise * totalWeight;
    if (pick < canopyWeight) {
      selected = 'canopy';
    } else if (pick < canopyWeight + shrubWeight) {
      selected = 'shrub';
    } else {
      selected = 'grass';
    }
  } else if (status === 'spawn candidate') {
    status = 'blocked: low suitability';
  }

  if (status === 'spawn candidate') {
    status = `spawn: ${selected}`;
  }

  return {
    status,
    slope,
    moisture,
    riparian,
    fertility,
    densityNoise,
    densityLimit,
    canopySuitability,
    shrubSuitability,
    grassSuitability,
    selected
  };
}

function clampHour(value: number): number {
  if (!Number.isFinite(value)) {
    return DAY_START_HOUR;
  }
  return Math.max(0, Math.min(24, value));
}

function wrapHour(value: number): number {
  if (!Number.isFinite(value)) {
    return DAY_START_HOUR;
  }
  const wrapped = value % 24;
  return wrapped < 0 ? wrapped + 24 : wrapped;
}

function wrapRadians(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const wrapped = value % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

function toRadians(degrees: number): number {
  return wrapRadians((degrees / 180) * Math.PI);
}

function toDegrees(radians: number): number {
  return (wrapRadians(radians) / Math.PI) * 180;
}

function getSimulatedDayPhase(time: number): number {
  const phase = time / DAY_CYCLE_SECONDS + DAY_START_HOUR / 24;
  return phase - Math.floor(phase);
}

function getSimulatedHour(time: number): number {
  return wrapHour(getSimulatedDayPhase(time) * 24);
}

function formatClockHour(hour: number): string {
  const normalized = wrapHour(hour);
  const h = Math.floor(normalized);
  const m = Math.floor((normalized - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getActiveDayPhase(): number {
  if (debugMode && dayCycleMode === 'manual') {
    return wrapHour(manualDayHour) / 24;
  }
  return getSimulatedDayPhase(world.time);
}

function getWeatherOverride(): WeatherOverride | null {
  if (debugMode && weatherMode === 'manual') {
    return {
      cloudiness: saturate(manualCloudiness),
      rainIntensity: saturate(manualRainIntensity)
    };
  }

  return null;
}

function getWindOverride(): WindOverride | null {
  if (debugMode && windMode === 'manual') {
    return {
      strength: saturate(manualWindStrength),
      direction: toRadians(manualWindDirection),
      gustiness: saturate(manualWindGustiness)
    };
  }

  return null;
}

function buildDebugStatusMessage(enabled: boolean): string {
  const dayLabel = dayCycleMode === 'manual' ? 'manual' : 'simulation';
  const weatherLabel = weatherMode === 'manual' ? 'manual' : 'simulation';
  const windLabel = windMode === 'manual' ? 'manual' : 'simulation';

  if (!enabled) {
    return 'Debug mode off | Day cycle simulation | Weather simulation | Wind simulation';
  }

  return `Debug mode on | Day cycle ${dayLabel} | Weather ${weatherLabel} | Wind ${windLabel}`;
}

function saturate(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1;
  }

  const t = saturate((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function createClimateState(
  time: number,
  seed: number,
  dayPhase: number,
  weatherOverride: WeatherOverride | null,
  windOverride: WindOverride | null
): ClimateState {
  const wrappedDayPhase = dayPhase - Math.floor(dayPhase);
  const sunWave = Math.sin((wrappedDayPhase - 0.25) * TAU);
  const daylight = saturate(0.18 + Math.max(0, sunWave) * 0.82);

  const cloudSignalA = Math.sin(time * 0.012 + seed * 0.00017) * 0.5 + 0.5;
  const cloudSignalB = Math.sin(time * 0.0045 + seed * 0.00043) * 0.5 + 0.5;
  let cloudiness = saturate(0.1 + (cloudSignalA * 0.62 + cloudSignalB * 0.38) * 0.78);

  const rainPulse = Math.sin(time * 0.021 + seed * 0.00091) * 0.5 + 0.5;
  const rainGate = smoothstep(0.6, 0.92, cloudiness);
  let rainIntensity = saturate(rainGate * (0.14 + rainPulse * 0.62));

  if (weatherOverride) {
    cloudiness = saturate(weatherOverride.cloudiness);
    rainIntensity = saturate(weatherOverride.rainIntensity);
  }

  const windSignalA = Math.sin(time * 0.0095 + seed * 0.00031) * 0.5 + 0.5;
  const windSignalB = Math.sin(time * 0.017 + seed * 0.00073 + cloudiness * 1.4) * 0.5 + 0.5;
  const windSignalC = Math.sin(time * 0.004 + seed * 0.0011) * 0.5 + 0.5;
  let windStrength = saturate(0.18 + windSignalA * 0.46 + rainIntensity * 0.24);
  let windGustiness = saturate(0.15 + windSignalB * 0.54 + rainIntensity * 0.2);
  let windDirection = wrapRadians(
    seed * 0.000045 +
      time * (0.015 + windStrength * 0.008) +
      (windSignalC - 0.5) * 1.4 +
      (windSignalB - 0.5) * 0.55
  );

  if (windOverride) {
    windStrength = saturate(windOverride.strength);
    windDirection = wrapRadians(windOverride.direction);
    windGustiness = saturate(windOverride.gustiness);
  }

  return {
    dayPhase: wrappedDayPhase,
    daylight,
    cloudiness,
    rainIntensity,
    windStrength,
    windDirection,
    windGustiness
  };
}

function seedHumidityFromWorld(target: Float32Array, state: WorldState): void {
  for (let index = 0; index < state.terrain.length; index += 1) {
    const wetness = saturate(state.water[index] * 3.2);
    const altitude = saturate((state.terrain[index] + 8) / 26);
    const baseHumidity = 0.18 + (1 - altitude) * 0.26;
    target[index] = saturate(Math.max(baseHumidity, wetness));
  }
}

function applyRainfall(state: WorldState, rainIntensity: number, dt: number): void {
  if (rainIntensity <= 0.02) {
    return;
  }

  const baseRain = rainIntensity * dt * 0.00008;
  for (let index = 0; index < state.water.length; index += 1) {
    const altitude = saturate((state.terrain[index] + 8) / 26);
    const orographicBias = 0.72 + altitude * 0.45;
    state.water[index] += baseRain * orographicBias;
  }
}

function updateHumidity(state: WorldState, dt: number, rainIntensity: number): void {
  for (let index = 0; index < humidityMap.length; index += 1) {
    const waterWet = saturate(state.water[index] * 3.2);
    const rainWet = rainIntensity * 0.45;
    const altitude = saturate((state.terrain[index] + 8) / 26);
    const retainedMoisture = 0.12 + (1 - altitude) * 0.24;
    const wetTarget = Math.max(waterWet, retainedMoisture + rainWet * 0.35);
    const current = humidityMap[index];

    const gain = wetTarget > current ? 2.1 : 0.7;
    let next = current + (wetTarget - current) * gain * dt;
    next -= (0.022 + altitude * 0.02) * (1 - waterWet) * (1 - rainIntensity * 0.5) * dt;
    humidityMap[index] = saturate(next);
  }

  humidityStepCounter += 1;
  if (humidityStepCounter % HUMIDITY_DIFFUSION_STEPS !== 0) {
    return;
  }

  for (let y = 0; y < state.size; y += 1) {
    for (let x = 0; x < state.size; x += 1) {
      const index = y * state.size + x;
      let total = humidityMap[index];
      let count = 1;

      if (x > 0) {
        total += humidityMap[index - 1];
        count += 1;
      }
      if (x + 1 < state.size) {
        total += humidityMap[index + 1];
        count += 1;
      }
      if (y > 0) {
        total += humidityMap[index - state.size];
        count += 1;
      }
      if (y + 1 < state.size) {
        total += humidityMap[index + state.size];
        count += 1;
      }

      const avg = total / count;
      humidityScratch[index] =
        humidityMap[index] + (avg - humidityMap[index]) * HUMIDITY_DIFFUSION_RATE;
    }
  }

  const temp = humidityMap;
  humidityMap = humidityScratch;
  humidityScratch = temp;
}

function currentVegetationVitality(): number {
  return saturate(0.34 + climateState.daylight * 0.46 + climateState.rainIntensity * 0.2);
}

function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
  hud.setDebugMode(enabled);
  if (!enabled && dayCycleMode !== 'simulation') {
    dayCycleMode = 'simulation';
    hud.setDayCycleMode(dayCycleMode);
  }
  if (!enabled && weatherMode !== 'simulation') {
    weatherMode = 'simulation';
    hud.setWeatherMode(weatherMode);
  }
  if (!enabled && windMode !== 'simulation') {
    windMode = 'simulation';
    hud.setWindMode(windMode);
  }
  if (!enabled) {
    previousDebugReadout = '';
    hud.setDebugReadout('');
  }
}

function updateDebugReadout(): void {
  if (!debugMode) {
    return;
  }

  if (!hoveredCell) {
    const fallback = 'Hover terrain to inspect a cell';
    if (fallback !== previousDebugReadout) {
      previousDebugReadout = fallback;
      hud.setDebugReadout(fallback);
    }
    return;
  }

  const diagnostics = sampleCellWaterDiagnostics(world, simParams, hoveredCell.x, hoveredCell.y);
  if (!diagnostics) {
    return;
  }

  const slope = computeSlopeAt(world.terrain, world.size, diagnostics.x, diagnostics.y);
  const outflowTotal =
    diagnostics.outflowPotentials.right +
    diagnostics.outflowPotentials.left +
    diagnostics.outflowPotentials.up +
    diagnostics.outflowPotentials.down;
  const worldWater = totalWater(world);
  const hasSource = world.sources.some(
    (source) => Math.round(source.x) === diagnostics.x && Math.round(source.y) === diagnostics.y
  );
  const humidityValue = humidityMap[diagnostics.index] ?? 0;
  const simulatedHour = getSimulatedHour(world.time);
  const activeHour =
    debugMode && dayCycleMode === 'manual' ? wrapHour(manualDayHour) : simulatedHour;
  const cycleLabel = debugMode && dayCycleMode === 'manual' ? 'manual' : 'simulation';
  const weatherLabel = debugMode && weatherMode === 'manual' ? 'manual' : 'simulation';
  const windLabel = debugMode && windMode === 'manual' ? 'manual' : 'simulation';
  const vegetationVitality = currentVegetationVitality();
  const vegetationCell = sampleVegetationCellDiagnostics(
    world,
    humidityMap,
    world.vegetationSeed,
    vegetationVitality,
    diagnostics.x,
    diagnostics.y
  );
  const vegetationCounts = scene.getVegetationCounts();

  const lines = [
    `cell: (${diagnostics.x}, ${diagnostics.y}) idx=${diagnostics.index}`,
    `terrain=${diagnostics.terrainHeight.toFixed(3)} water=${diagnostics.waterHeight.toFixed(3)} total=${diagnostics.totalHeight.toFixed(3)}`,
    `slope=${slope.toFixed(3)} edge=${diagnostics.isEdge ? 'yes' : 'no'} source=${hasSource ? 'yes' : 'no'} humidity=${humidityValue.toFixed(3)}`,
    `neighborTotal R:${formatCellValue(diagnostics.neighborTotalHeights.right)} L:${formatCellValue(diagnostics.neighborTotalHeights.left)} U:${formatCellValue(diagnostics.neighborTotalHeights.up)} D:${formatCellValue(diagnostics.neighborTotalHeights.down)}`,
    `downhillDiff R:${diagnostics.downhillDiffs.right.toFixed(3)} L:${diagnostics.downhillDiffs.left.toFixed(3)} U:${diagnostics.downhillDiffs.up.toFixed(3)} D:${diagnostics.downhillDiffs.down.toFixed(3)}`,
    `outflow/step R:${diagnostics.outflowPotentials.right.toFixed(4)} L:${diagnostics.outflowPotentials.left.toFixed(4)} U:${diagnostics.outflowPotentials.up.toFixed(4)} D:${diagnostics.outflowPotentials.down.toFixed(4)}`,
    `loss/step seep=${diagnostics.seepageLossPerStep.toFixed(5)} edge=${diagnostics.edgeDrainLossPerStep.toFixed(5)} outTotal=${outflowTotal.toFixed(4)}`,
    `world totalWater=${worldWater.toFixed(2)} activeSources=${world.sources.length} terrainSeed=${terrainSeed} vegetationSeed=${world.vegetationSeed}`,
    `vegetation draw canopy=${vegetationCounts.canopy} shrub=${vegetationCounts.shrub} grass=${vegetationCounts.grass} total=${vegetationCounts.total} vitality=${vegetationVitality.toFixed(2)}`,
    `vegetation cell ${vegetationCell.status} selected=${vegetationCell.selected} fertility=${vegetationCell.fertility.toFixed(3)} moisture=${vegetationCell.moisture.toFixed(3)} riparian=${vegetationCell.riparian.toFixed(3)} slope=${vegetationCell.slope.toFixed(3)}`,
    `vegetation suit canopy=${vegetationCell.canopySuitability.toFixed(3)} shrub=${vegetationCell.shrubSuitability.toFixed(3)} grass=${vegetationCell.grassSuitability.toFixed(3)} density=${vegetationCell.densityNoise.toFixed(3)}/${vegetationCell.densityLimit.toFixed(3)}`,
    `clock mode=${cycleLabel} active=${formatClockHour(activeHour)} sim=${formatClockHour(simulatedHour)} phase=${climateState.dayPhase.toFixed(3)}`,
    `weather mode=${weatherLabel} cloud=${climateState.cloudiness.toFixed(2)} rain=${climateState.rainIntensity.toFixed(2)} daylight=${climateState.daylight.toFixed(2)}`,
    `wind mode=${windLabel} strength=${climateState.windStrength.toFixed(2)} dir=${toDegrees(climateState.windDirection).toFixed(0)}deg gust=${climateState.windGustiness.toFixed(2)}`
  ];

  const text = lines.join('\n');
  if (text !== previousDebugReadout) {
    previousDebugReadout = text;
    hud.setDebugReadout(text);
  }
}

manualDayHour = getSimulatedHour(world.time);
climateState = createClimateState(
  world.time,
  terrainSeed,
  getActiveDayPhase(),
  getWeatherOverride(),
  getWindOverride()
);
manualCloudiness = climateState.cloudiness;
manualRainIntensity = climateState.rainIntensity;
manualWindStrength = climateState.windStrength;
manualWindDirection = toDegrees(climateState.windDirection);
manualWindGustiness = climateState.windGustiness;
seedHumidityFromWorld(humidityMap, world);

const scene = new SceneView(app, world.size);
window.__hakoniwaDebug = {
  getWindDiagnostics: () => scene.getWindDiagnostics()
};
scene.updateAtmosphere(climateState);
scene.updateTerrain(world.terrain);
scene.updateWater(world.terrain, world.water);
scene.updateVegetation(
  world.terrain,
  world.water,
  humidityMap,
  world.vegetationSeed,
  currentVegetationVitality()
);
scene.setPhotoFov(photoFov);
scene.setPhotoDepthBlur(photoDof);
scene.setPhotoMode(photoMode);
scene.updateRiverGuide(world.terrain);
scene.setRiverGuideVisible(riverGuideVisible);

const hud = new Hud(
  document.body,
  {
    tool: toolMode,
    interactionMode,
    debugMode,
    dayCycleMode,
    manualHour: manualDayHour,
    weatherMode,
    manualCloudiness,
    manualRainIntensity,
    windMode,
    manualWindStrength,
    manualWindDirection,
    manualWindGustiness,
    terrainSeed,
    radius: brush.radius,
    strength: brush.strength,
    flattenHeight: brush.flattenHeight,
    sourceRate
  },
  {
    onToolChange: (tool) => {
      toolMode = tool;
      interactionMode = 'edit';
      hud.setInteractionMode(interactionMode);
      hud.setStatus(`Tool: ${tool}`);
    },
    onInteractionModeChange: (mode) => {
      interactionMode = mode;
      hud.setStatus(mode === 'camera' ? 'Camera mode' : `Edit mode: ${toolMode}`);
    },
    onDebugModeChange: (enabled) => {
      setDebugMode(enabled);
      hud.setStatus(buildDebugStatusMessage(enabled));
    },
    onDayCycleModeChange: (mode) => {
      dayCycleMode = mode;
      hud.setDayCycleMode(mode);
      if (mode === 'manual') {
        hud.setStatus(`Day cycle manual: ${formatClockHour(manualDayHour)}`);
      } else {
        hud.setStatus('Day cycle: simulation');
      }
    },
    onManualHourChange: (hour) => {
      manualDayHour = clampHour(hour);
      hud.setManualHour(manualDayHour);
      if (debugMode && dayCycleMode === 'manual') {
        hud.setStatus(`Manual time: ${formatClockHour(manualDayHour)}`);
      }
    },
    onWeatherModeChange: (mode) => {
      weatherMode = mode;
      hud.setWeatherMode(mode);
      if (mode === 'manual') {
        hud.setStatus(
          `Weather manual: cloud ${manualCloudiness.toFixed(2)} rain ${manualRainIntensity.toFixed(2)}`
        );
      } else {
        hud.setStatus('Weather: simulation');
      }
    },
    onManualCloudinessChange: (value) => {
      manualCloudiness = saturate(value);
      hud.setManualCloudiness(manualCloudiness);
      if (debugMode && weatherMode === 'manual') {
        hud.setStatus(
          `Weather manual: cloud ${manualCloudiness.toFixed(2)} rain ${manualRainIntensity.toFixed(2)}`
        );
      }
    },
    onManualRainIntensityChange: (value) => {
      manualRainIntensity = saturate(value);
      hud.setManualRainIntensity(manualRainIntensity);
      if (debugMode && weatherMode === 'manual') {
        hud.setStatus(
          `Weather manual: cloud ${manualCloudiness.toFixed(2)} rain ${manualRainIntensity.toFixed(2)}`
        );
      }
    },
    onWindModeChange: (mode) => {
      windMode = mode;
      hud.setWindMode(mode);
      if (mode === 'manual') {
        hud.setStatus(
          `Wind manual: strength ${manualWindStrength.toFixed(2)} dir ${manualWindDirection.toFixed(0)}deg gust ${manualWindGustiness.toFixed(2)}`
        );
      } else {
        hud.setStatus('Wind: simulation');
      }
    },
    onManualWindStrengthChange: (value) => {
      manualWindStrength = saturate(value);
      hud.setManualWindStrength(manualWindStrength);
      if (debugMode && windMode === 'manual') {
        hud.setStatus(
          `Wind manual: strength ${manualWindStrength.toFixed(2)} dir ${manualWindDirection.toFixed(0)}deg gust ${manualWindGustiness.toFixed(2)}`
        );
      }
    },
    onManualWindDirectionChange: (value) => {
      manualWindDirection = ((value % 360) + 360) % 360;
      hud.setManualWindDirection(manualWindDirection);
      if (debugMode && windMode === 'manual') {
        hud.setStatus(
          `Wind manual: strength ${manualWindStrength.toFixed(2)} dir ${manualWindDirection.toFixed(0)}deg gust ${manualWindGustiness.toFixed(2)}`
        );
      }
    },
    onManualWindGustinessChange: (value) => {
      manualWindGustiness = saturate(value);
      hud.setManualWindGustiness(manualWindGustiness);
      if (debugMode && windMode === 'manual') {
        hud.setStatus(
          `Wind manual: strength ${manualWindStrength.toFixed(2)} dir ${manualWindDirection.toFixed(0)}deg gust ${manualWindGustiness.toFixed(2)}`
        );
      }
    },
    onRadiusChange: (radius) => {
      brush.radius = radius;
    },
    onStrengthChange: (strength) => {
      brush.strength = strength;
    },
    onFlattenHeightChange: (height) => {
      brush.flattenHeight = height;
    },
    onSourceRateChange: (rate) => {
      sourceRate = rate;
    },
    onSave: async (slot) => {
      try {
        await saveWorldToSlot(slot, world);
        hud.setStatus(`Saved slot ${slot}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown save error';
        hud.setStatus(`Save failed: ${message}`);
      }
    },
    onLoad: async (slot) => {
      try {
        const loaded = await loadWorldFromSlot(slot);
        if (!loaded) {
          hud.setStatus(`Slot ${slot} is empty`);
          return;
        }

        if (loaded.size !== world.size) {
          hud.setStatus(`Slot size mismatch: ${loaded.size}`);
          return;
        }

        world = loaded;
        terrainSeed = world.terrainSeed;
        sourceIdCounter = world.sources.length + 1;
        climateState = createClimateState(
          world.time,
          terrainSeed,
          getActiveDayPhase(),
          getWeatherOverride(),
          getWindOverride()
        );
        seedHumidityFromWorld(humidityMap, world);
        humidityScratch.fill(0);
        humidityStepCounter = 0;
        hud.setTerrainSeed(terrainSeed);
        markAllDirty();
        hud.setStatus(`Loaded slot ${slot}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown load error';
        hud.setStatus(`Load failed: ${message}`);
      }
    }
  }
);

const photoOverlay = document.createElement('div');
photoOverlay.className = 'photo-overlay';
photoOverlay.dataset.testid = 'photo-overlay';
document.body.appendChild(photoOverlay);

let lastPhotoCaptureLabel = '';

function updatePhotoOverlay(): void {
  if (!photoMode) {
    photoOverlay.classList.remove('visible');
    photoOverlay.textContent = '';
    return;
  }

  photoOverlay.classList.add('visible');
  const lines = [
    'PHOTO MODE',
    `[ ] FOV ${photoFov.toFixed(0)}°`,
    `- / = DOF ${photoDof.toFixed(2)}`,
    'K capture PNG | P or Esc exit',
    `R river guide: ${riverGuideVisible ? 'ON' : 'OFF'}`
  ];
  if (lastPhotoCaptureLabel) {
    lines.push(`Saved: ${lastPhotoCaptureLabel}`);
  }
  photoOverlay.textContent = lines.join('\n');
}

function setPhotoModeEnabled(enabled: boolean): void {
  if (photoMode === enabled) {
    return;
  }

  photoMode = enabled;
  scene.setPhotoMode(enabled);
  hud.element.classList.toggle('photo-hidden', enabled);
  if (enabled) {
    interactionModeBeforePhoto = interactionMode;
    interactionMode = 'camera';
    hud.setInteractionMode(interactionMode);
    hud.setStatus('Photo mode ON');
  } else {
    interactionMode = interactionModeBeforePhoto;
    hud.setInteractionMode(interactionMode);
    hud.setStatus(
      interactionMode === 'camera' ? 'Photo mode OFF (camera)' : `Photo mode OFF (${toolMode})`
    );
  }
  updatePhotoOverlay();
}

function adjustPhotoFov(delta: number): void {
  photoFov = scene.setPhotoFov(clampRange(photoFov + delta, PHOTO_FOV_MIN, PHOTO_FOV_MAX));
  updatePhotoOverlay();
}

function adjustPhotoDof(delta: number): void {
  photoDof = scene.setPhotoDepthBlur(clampRange(photoDof + delta, PHOTO_DOF_MIN, PHOTO_DOF_MAX));
  updatePhotoOverlay();
}

function capturePhoto(): void {
  const dataUrl = scene.captureScreenshot('image/png');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = `hakoniwa-${stamp}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  lastPhotoCaptureLabel = stamp.slice(0, 19);
  updatePhotoOverlay();
  hud.setStatus('Captured PNG');
}

function toggleRiverGuide(): void {
  riverGuideVisible = !riverGuideVisible;
  scene.setRiverGuideVisible(riverGuideVisible);
  updatePhotoOverlay();
  hud.setStatus(`River guide ${riverGuideVisible ? 'ON' : 'OFF'}`);
}

updatePhotoOverlay();

const input = new InputController({
  domElement: scene.renderer.domElement,
  camera: scene.camera,
  terrainMesh: scene.getTerrainMesh(),
  controls: scene.controls,
  worldSize: world.size,
  onHover: (x, y) => {
    hoveredCell = { x, y };
  },
  getInteractionMode: () => interactionMode,
  getPhotoMode: () => photoMode,
  onPaint: (x, y, isInitialStroke, _shiftKey) => {
    void _shiftKey;
    if (toolMode === 'waterSource') {
      if (isInitialStroke) {
        toggleWaterSource(x, y);
      }
      return;
    }

    applyBrush(world, x, y, toolMode, brush);
    terrainDirty = true;
    waterDirty = true;
    vegetationDirty = true;
  },
  onToolKey: (tool) => {
    toolMode = tool;
    interactionMode = 'edit';
    hud.setInteractionMode(interactionMode);
    hud.setTool(tool);
    hud.setStatus(`Tool: ${tool}`);
  },
  onInteractionModeKey: (mode) => {
    interactionMode = mode;
    hud.setInteractionMode(mode);
    hud.setStatus(mode === 'camera' ? 'Camera mode' : `Edit mode: ${toolMode}`);
  },
  onDebugModeToggleKey: () => {
    const next = !debugMode;
    setDebugMode(next);
    hud.setStatus(buildDebugStatusMessage(next));
  },
  onPhotoModeToggleKey: () => {
    setPhotoModeEnabled(!photoMode);
  },
  onRiverGuideToggleKey: () => {
    toggleRiverGuide();
  },
  onPhotoFovDeltaKey: (delta) => {
    adjustPhotoFov(delta);
  },
  onPhotoDofDeltaKey: (delta) => {
    adjustPhotoDof(delta);
  },
  onPhotoCaptureKey: () => {
    capturePhoto();
  },
  onRadiusDelta: (delta) => {
    brush.radius = Math.min(40, Math.max(1, brush.radius + delta));
    hud.setRadius(brush.radius);
  }
});

let terrainDirty = false;
let waterDirty = true;
let vegetationDirty = true;
let vegetationLastUpdated = 0;

function markAllDirty(): void {
  terrainDirty = true;
  waterDirty = true;
  vegetationDirty = true;
}

function findNearbySourceIndex(x: number, y: number): number {
  return world.sources.findIndex((source) => {
    const dx = source.x - x;
    const dy = source.y - y;
    return dx * dx + dy * dy <= 1.5 * 1.5;
  });
}

function toggleWaterSource(x: number, y: number): void {
  const existingIndex = findNearbySourceIndex(x, y);
  if (existingIndex >= 0) {
    const [removed] = world.sources.splice(existingIndex, 1);
    hud.setStatus(`Source removed (${removed?.x}, ${removed?.y})`);
  } else {
    const source: WaterSource = {
      id: `source-${sourceIdCounter}`,
      x,
      y,
      rate: sourceRate,
      active: true
    };
    sourceIdCounter += 1;
    world.sources.push(source);
    hud.setStatus(`Source added (${x}, ${y})`);
  }

  waterDirty = true;
  vegetationDirty = true;
}

let lastFrameTime = performance.now();
let accumulator = 0;

function animate(frameTime: number): void {
  const deltaSeconds = Math.min(0.1, (frameTime - lastFrameTime) / 1000);
  lastFrameTime = frameTime;
  accumulator += deltaSeconds;

  while (accumulator >= simParams.dt) {
    climateState = createClimateState(
      world.time,
      terrainSeed,
      getActiveDayPhase(),
      getWeatherOverride(),
      getWindOverride()
    );
    applyRainfall(world, climateState.rainIntensity, simParams.dt);
    stepWater(world, simParams);
    updateHumidity(world, simParams.dt, climateState.rainIntensity);
    world.time += simParams.dt;
    accumulator -= simParams.dt;
    waterDirty = true;
    vegetationDirty = true;
  }

  climateState = createClimateState(
    world.time,
    terrainSeed,
    getActiveDayPhase(),
    getWeatherOverride(),
    getWindOverride()
  );

  if (terrainDirty) {
    scene.updateTerrain(world.terrain);
    scene.updateRiverGuide(world.terrain);
    terrainDirty = false;
  }

  if (waterDirty) {
    scene.updateWater(world.terrain, world.water);
    waterDirty = false;
  }

  scene.updateAtmosphere(climateState);
  updateDebugReadout();

  const now = performance.now();
  if (vegetationDirty && now - vegetationLastUpdated > 420) {
    scene.updateVegetation(
      world.terrain,
      world.water,
      humidityMap,
      world.vegetationSeed,
      currentVegetationVitality()
    );
    vegetationDirty = false;
    vegetationLastUpdated = now;
  }

  scene.controls.update();
  scene.render();
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);

window.addEventListener('beforeunload', () => {
  delete window.__hakoniwaDebug;
  input.dispose();
  scene.dispose();
});
