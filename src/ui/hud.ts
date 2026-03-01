import { clamp } from '../core/grid';
import type { ToolMode } from '../core/types';
import type { InteractionMode } from '../input/controller';

export type DayCycleMode = 'simulation' | 'manual';
export type WeatherMode = 'simulation' | 'manual';
export type WindMode = 'simulation' | 'manual';
type DebugControlTab = 'dayCycle' | 'weather' | 'wind' | 'seed';
type DebugReadoutTab = 'overview' | 'water' | 'life' | 'cell';

export interface HudState {
  tool: ToolMode;
  interactionMode: InteractionMode;
  audioEnabled: boolean;
  debugMode: boolean;
  dayCycleMode: DayCycleMode;
  manualHour: number;
  weatherMode: WeatherMode;
  manualCloudiness: number;
  manualRainIntensity: number;
  windMode: WindMode;
  manualWindStrength: number;
  manualWindDirection: number;
  manualWindGustiness: number;
  terrainSeed: number;
  radius: number;
  strength: number;
  flattenHeight: number;
  sourceRate: number;
}

export interface HudCallbacks {
  onToolChange: (tool: ToolMode) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onAudioToggle: (enabled: boolean) => void;
  onDebugModeChange: (enabled: boolean) => void;
  onDayCycleModeChange: (mode: DayCycleMode) => void;
  onManualHourChange: (hour: number) => void;
  onWeatherModeChange: (mode: WeatherMode) => void;
  onManualCloudinessChange: (value: number) => void;
  onManualRainIntensityChange: (value: number) => void;
  onWindModeChange: (mode: WindMode) => void;
  onManualWindStrengthChange: (value: number) => void;
  onManualWindDirectionChange: (value: number) => void;
  onManualWindGustinessChange: (value: number) => void;
  onRadiusChange: (radius: number) => void;
  onStrengthChange: (strength: number) => void;
  onFlattenHeightChange: (height: number) => void;
  onSourceRateChange: (rate: number) => void;
  onSave: (slot: number) => void | Promise<void>;
  onLoad: (slot: number) => void | Promise<void>;
}

function normalizeSeed(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(999_999_999, Math.floor(value)));
}

function normalizeHour(value: number): number {
  if (!Number.isFinite(value)) {
    return 12;
  }

  return clamp(value, 0, 24);
}

function normalizeUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return clamp(value, 0, 1);
}

function normalizeDirection(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export class Hud {
  readonly element: HTMLDivElement;

  private readonly toolButtons: Record<ToolMode, HTMLButtonElement>;
  private readonly cameraButton: HTMLButtonElement;
  private readonly audioButton: HTMLButtonElement;
  private readonly debugButton: HTMLButtonElement;
  private readonly seedGroup: HTMLDivElement;
  private readonly dayCycleGroup: HTMLDivElement;
  private readonly dayCycleModeInput: HTMLSelectElement;
  private readonly manualHourInput: HTMLInputElement;
  private readonly manualHourValue: HTMLSpanElement;
  private readonly weatherGroup: HTMLDivElement;
  private readonly weatherModeInput: HTMLSelectElement;
  private readonly manualCloudInput: HTMLInputElement;
  private readonly manualCloudValue: HTMLSpanElement;
  private readonly manualRainInput: HTMLInputElement;
  private readonly manualRainValue: HTMLSpanElement;
  private readonly windGroup: HTMLDivElement;
  private readonly debugControlsTabs: Record<DebugControlTab, HTMLButtonElement>;
  private readonly windModeInput: HTMLSelectElement;
  private readonly manualWindStrengthInput: HTMLInputElement;
  private readonly manualWindStrengthValue: HTMLSpanElement;
  private readonly manualWindDirectionInput: HTMLInputElement;
  private readonly manualWindDirectionValue: HTMLSpanElement;
  private readonly manualWindGustinessInput: HTMLInputElement;
  private readonly manualWindGustinessValue: HTMLSpanElement;
  private readonly debugControls: HTMLDivElement;
  private readonly debugReadoutHeader: HTMLDivElement;
  private readonly debugPanel: HTMLPreElement;
  private readonly debugReadoutTabs: Record<DebugReadoutTab, HTMLButtonElement>;
  private readonly debugExpandButton: HTMLButtonElement;
  private readonly seedInput: HTMLInputElement;
  private readonly radiusInput: HTMLInputElement;
  private readonly radiusValue: HTMLSpanElement;
  private readonly strengthInput: HTMLInputElement;
  private readonly strengthValue: HTMLSpanElement;
  private readonly strengthRow: HTMLLabelElement;
  private readonly flattenInput: HTMLInputElement;
  private readonly flattenValue: HTMLSpanElement;
  private readonly flattenRow: HTMLLabelElement;
  private readonly sourceRateInput: HTMLInputElement;
  private readonly sourceRateValue: HTMLSpanElement;
  private readonly sourceRateRow: HTMLLabelElement;
  private readonly tip: HTMLParagraphElement;
  private readonly status: HTMLParagraphElement;

  private state: HudState;
  private activeDebugControlTab: DebugControlTab = 'dayCycle';
  private activeDebugReadoutTab: DebugReadoutTab = 'overview';
  private debugReadoutExpanded = false;
  private rawDebugReadout = '';

  constructor(host: HTMLElement, initialState: HudState, callbacks: HudCallbacks) {
    this.state = { ...initialState };

    this.element = document.createElement('div');
    this.element.className = 'hud';

    const title = document.createElement('h1');
    title.textContent = 'Hakoniwa';
    this.element.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'hud-subtitle';
    subtitle.textContent = 'Shape land, guide water, watch the world breathe.';
    this.element.appendChild(subtitle);

    this.debugButton = document.createElement('button');
    this.debugButton.type = 'button';
    this.debugButton.className = 'debug-toggle';
    this.debugButton.dataset.testid = 'debug-toggle';
    this.debugButton.addEventListener('click', () => {
      const next = !this.state.debugMode;
      this.setDebugMode(next);
      callbacks.onDebugModeChange(next);
    });

    this.audioButton = document.createElement('button');
    this.audioButton.type = 'button';
    this.audioButton.className = 'audio-toggle';
    this.audioButton.dataset.testid = 'audio-toggle';
    this.audioButton.addEventListener('click', () => {
      const next = !this.state.audioEnabled;
      this.setAudioEnabled(next);
      callbacks.onAudioToggle(next);
    });

    const toggles = document.createElement('div');
    toggles.className = 'mode-switch';
    toggles.appendChild(this.audioButton);
    toggles.appendChild(this.debugButton);
    this.element.appendChild(toggles);

    this.dayCycleGroup = document.createElement('div');
    this.dayCycleGroup.className = 'debug-daycycle';

    const dayCycleLabel = document.createElement('label');
    dayCycleLabel.className = 'seed-label';
    dayCycleLabel.textContent = 'Day Cycle (Debug)';

    this.dayCycleModeInput = document.createElement('select');
    this.dayCycleModeInput.dataset.testid = 'daycycle-mode';

    const dayCycleSimulationOption = document.createElement('option');
    dayCycleSimulationOption.value = 'simulation';
    dayCycleSimulationOption.textContent = 'Simulation (24m cycle)';
    this.dayCycleModeInput.appendChild(dayCycleSimulationOption);

    const manualOption = document.createElement('option');
    manualOption.value = 'manual';
    manualOption.textContent = 'Manual Override';
    this.dayCycleModeInput.appendChild(manualOption);

    this.dayCycleModeInput.addEventListener('change', () => {
      const next = this.dayCycleModeInput.value === 'manual' ? 'manual' : 'simulation';
      this.setDayCycleMode(next);
      callbacks.onDayCycleModeChange(next);
    });
    dayCycleLabel.appendChild(this.dayCycleModeInput);
    this.dayCycleGroup.appendChild(dayCycleLabel);

    this.manualHourInput = document.createElement('input');
    this.manualHourInput.type = 'range';
    this.manualHourInput.min = '0';
    this.manualHourInput.max = '24';
    this.manualHourInput.step = '0.1';
    this.manualHourInput.dataset.testid = 'manual-hour';

    this.manualHourValue = document.createElement('span');
    this.dayCycleGroup.appendChild(
      this.createControlRow('Hour', this.manualHourInput, this.manualHourValue)
    );
    this.manualHourInput.addEventListener('input', () => {
      const next = clamp(Number(this.manualHourInput.value), 0, 24);
      this.setManualHour(next);
      callbacks.onManualHourChange(next);
    });

    this.weatherGroup = document.createElement('div');
    this.weatherGroup.className = 'debug-weather';

    const weatherLabel = document.createElement('label');
    weatherLabel.className = 'seed-label';
    weatherLabel.textContent = 'Weather (Debug)';

    this.weatherModeInput = document.createElement('select');
    this.weatherModeInput.dataset.testid = 'weather-mode';

    const simulationOption = document.createElement('option');
    simulationOption.value = 'simulation';
    simulationOption.textContent = 'Simulation';
    this.weatherModeInput.appendChild(simulationOption);

    const weatherManualOption = document.createElement('option');
    weatherManualOption.value = 'manual';
    weatherManualOption.textContent = 'Manual Override';
    this.weatherModeInput.appendChild(weatherManualOption);

    this.weatherModeInput.addEventListener('change', () => {
      const next = this.weatherModeInput.value === 'manual' ? 'manual' : 'simulation';
      this.setWeatherMode(next);
      callbacks.onWeatherModeChange(next);
    });
    weatherLabel.appendChild(this.weatherModeInput);
    this.weatherGroup.appendChild(weatherLabel);

    this.manualCloudInput = document.createElement('input');
    this.manualCloudInput.type = 'range';
    this.manualCloudInput.min = '0';
    this.manualCloudInput.max = '1';
    this.manualCloudInput.step = '0.01';
    this.manualCloudInput.dataset.testid = 'manual-cloudiness';

    this.manualCloudValue = document.createElement('span');
    this.weatherGroup.appendChild(
      this.createControlRow('Cloud', this.manualCloudInput, this.manualCloudValue)
    );
    this.manualCloudInput.addEventListener('input', () => {
      const next = clamp(Number(this.manualCloudInput.value), 0, 1);
      this.setManualCloudiness(next);
      callbacks.onManualCloudinessChange(next);
    });

    this.manualRainInput = document.createElement('input');
    this.manualRainInput.type = 'range';
    this.manualRainInput.min = '0';
    this.manualRainInput.max = '1';
    this.manualRainInput.step = '0.01';
    this.manualRainInput.dataset.testid = 'manual-rain-intensity';

    this.manualRainValue = document.createElement('span');
    this.weatherGroup.appendChild(
      this.createControlRow('Rain', this.manualRainInput, this.manualRainValue)
    );
    this.manualRainInput.addEventListener('input', () => {
      const next = clamp(Number(this.manualRainInput.value), 0, 1);
      this.setManualRainIntensity(next);
      callbacks.onManualRainIntensityChange(next);
    });

    this.windGroup = document.createElement('div');
    this.windGroup.className = 'debug-wind';

    const windLabel = document.createElement('label');
    windLabel.className = 'seed-label';
    windLabel.textContent = 'Wind (Debug)';

    this.windModeInput = document.createElement('select');
    this.windModeInput.dataset.testid = 'wind-mode';

    const windSimulationOption = document.createElement('option');
    windSimulationOption.value = 'simulation';
    windSimulationOption.textContent = 'Simulation';
    this.windModeInput.appendChild(windSimulationOption);

    const windManualOption = document.createElement('option');
    windManualOption.value = 'manual';
    windManualOption.textContent = 'Manual Override';
    this.windModeInput.appendChild(windManualOption);

    this.windModeInput.addEventListener('change', () => {
      const next = this.windModeInput.value === 'manual' ? 'manual' : 'simulation';
      this.setWindMode(next);
      callbacks.onWindModeChange(next);
    });
    windLabel.appendChild(this.windModeInput);
    this.windGroup.appendChild(windLabel);

    this.manualWindStrengthInput = document.createElement('input');
    this.manualWindStrengthInput.type = 'range';
    this.manualWindStrengthInput.min = '0';
    this.manualWindStrengthInput.max = '1';
    this.manualWindStrengthInput.step = '0.01';
    this.manualWindStrengthInput.dataset.testid = 'manual-wind-strength';

    this.manualWindStrengthValue = document.createElement('span');
    this.windGroup.appendChild(
      this.createControlRow('Force', this.manualWindStrengthInput, this.manualWindStrengthValue)
    );
    this.manualWindStrengthInput.addEventListener('input', () => {
      const next = clamp(Number(this.manualWindStrengthInput.value), 0, 1);
      this.setManualWindStrength(next);
      callbacks.onManualWindStrengthChange(next);
    });

    this.manualWindDirectionInput = document.createElement('input');
    this.manualWindDirectionInput.type = 'range';
    this.manualWindDirectionInput.min = '0';
    this.manualWindDirectionInput.max = '359';
    this.manualWindDirectionInput.step = '1';
    this.manualWindDirectionInput.dataset.testid = 'manual-wind-direction';

    this.manualWindDirectionValue = document.createElement('span');
    this.windGroup.appendChild(
      this.createControlRow(
        'Direction',
        this.manualWindDirectionInput,
        this.manualWindDirectionValue
      )
    );
    this.manualWindDirectionInput.addEventListener('input', () => {
      const next = normalizeDirection(Number(this.manualWindDirectionInput.value));
      this.setManualWindDirection(next);
      callbacks.onManualWindDirectionChange(next);
    });

    this.manualWindGustinessInput = document.createElement('input');
    this.manualWindGustinessInput.type = 'range';
    this.manualWindGustinessInput.min = '0';
    this.manualWindGustinessInput.max = '1';
    this.manualWindGustinessInput.step = '0.01';
    this.manualWindGustinessInput.dataset.testid = 'manual-wind-gustiness';

    this.manualWindGustinessValue = document.createElement('span');
    this.windGroup.appendChild(
      this.createControlRow(
        'Gustiness',
        this.manualWindGustinessInput,
        this.manualWindGustinessValue
      )
    );
    this.manualWindGustinessInput.addEventListener('input', () => {
      const next = clamp(Number(this.manualWindGustinessInput.value), 0, 1);
      this.setManualWindGustiness(next);
      callbacks.onManualWindGustinessChange(next);
    });

    this.seedGroup = document.createElement('div');
    this.seedGroup.className = 'seed-group debug-seed';

    const seedLabel = document.createElement('label');
    seedLabel.className = 'seed-label';
    seedLabel.textContent = 'Terrain Seed';

    this.seedInput = document.createElement('input');
    this.seedInput.type = 'number';
    this.seedInput.inputMode = 'numeric';
    this.seedInput.min = '0';
    this.seedInput.max = '999999999';
    this.seedInput.step = '1';
    this.seedInput.dataset.testid = 'seed-input';
    this.seedInput.readOnly = true;
    seedLabel.appendChild(this.seedInput);
    this.seedGroup.appendChild(seedLabel);

    const debugControlTabs = document.createElement('div');
    debugControlTabs.className = 'debug-tab-row debug-tab-row-controls';

    const createDebugControlTabButton = (
      tab: DebugControlTab,
      label: string,
      testid: string
    ): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.testid = testid;
      button.addEventListener('click', () => {
        this.setActiveDebugControlTab(tab);
      });
      debugControlTabs.appendChild(button);
      return button;
    };

    this.debugControlsTabs = {
      dayCycle: createDebugControlTabButton('dayCycle', 'Time', 'debug-tab-time'),
      weather: createDebugControlTabButton('weather', 'Weather', 'debug-tab-weather'),
      wind: createDebugControlTabButton('wind', 'Wind', 'debug-tab-wind'),
      seed: createDebugControlTabButton('seed', 'Seed', 'debug-tab-seed')
    };

    const tools = document.createElement('div');
    tools.className = 'tool-grid';

    const createToolButton = (tool: ToolMode, label: string): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.tool = tool;
      button.addEventListener('click', () => {
        this.setInteractionMode('edit');
        callbacks.onInteractionModeChange('edit');
        this.setTool(tool);
        callbacks.onToolChange(tool);
      });
      tools.appendChild(button);
      return button;
    };

    this.toolButtons = {
      raise: createToolButton('raise', '1 Raise'),
      lower: createToolButton('lower', '2 Lower'),
      flatten: createToolButton('flatten', '3 Flatten'),
      waterSource: createToolButton('waterSource', '4 Source')
    };

    this.cameraButton = document.createElement('button');
    this.cameraButton.type = 'button';
    this.cameraButton.textContent = '0 Camera';
    this.cameraButton.dataset.testid = 'camera-mode';
    this.cameraButton.addEventListener('click', () => {
      this.setInteractionMode('camera');
      callbacks.onInteractionModeChange('camera');
    });
    tools.appendChild(this.cameraButton);

    this.element.appendChild(tools);

    const controls = document.createElement('div');
    controls.className = 'control-stack';

    this.radiusInput = document.createElement('input');
    this.radiusInput.type = 'range';
    this.radiusInput.min = '1';
    this.radiusInput.max = '40';
    this.radiusInput.step = '1';
    this.radiusValue = document.createElement('span');
    controls.appendChild(this.createControlRow('Radius', this.radiusInput, this.radiusValue));
    this.radiusInput.addEventListener('input', () => {
      const next = clamp(Number(this.radiusInput.value), 1, 40);
      this.state.radius = next;
      this.radiusValue.textContent = String(next);
      callbacks.onRadiusChange(next);
    });

    this.strengthInput = document.createElement('input');
    this.strengthInput.type = 'range';
    this.strengthInput.min = '0.01';
    this.strengthInput.max = '1';
    this.strengthInput.step = '0.01';
    this.strengthValue = document.createElement('span');
    this.strengthRow = this.createControlRow('Strength', this.strengthInput, this.strengthValue);
    controls.appendChild(this.strengthRow);
    this.strengthInput.addEventListener('input', () => {
      const next = clamp(Number(this.strengthInput.value), 0.01, 1);
      this.state.strength = next;
      this.strengthValue.textContent = next.toFixed(2);
      callbacks.onStrengthChange(next);
    });

    this.flattenInput = document.createElement('input');
    this.flattenInput.type = 'range';
    this.flattenInput.min = '-10';
    this.flattenInput.max = '20';
    this.flattenInput.step = '0.1';
    this.flattenValue = document.createElement('span');
    this.flattenRow = this.createControlRow('Flatten', this.flattenInput, this.flattenValue);
    controls.appendChild(this.flattenRow);
    this.flattenInput.addEventListener('input', () => {
      const next = clamp(Number(this.flattenInput.value), -10, 20);
      this.state.flattenHeight = next;
      this.flattenValue.textContent = next.toFixed(1);
      callbacks.onFlattenHeightChange(next);
    });

    this.sourceRateInput = document.createElement('input');
    this.sourceRateInput.type = 'range';
    this.sourceRateInput.min = '0.1';
    this.sourceRateInput.max = '4';
    this.sourceRateInput.step = '0.1';
    this.sourceRateValue = document.createElement('span');
    this.sourceRateRow = this.createControlRow(
      'Source/s',
      this.sourceRateInput,
      this.sourceRateValue
    );
    controls.appendChild(this.sourceRateRow);
    this.sourceRateInput.addEventListener('input', () => {
      const next = clamp(Number(this.sourceRateInput.value), 0.1, 4);
      this.state.sourceRate = next;
      this.sourceRateValue.textContent = next.toFixed(1);
      callbacks.onSourceRateChange(next);
    });

    this.element.appendChild(controls);

    const slotGrid = document.createElement('div');
    slotGrid.className = 'slot-grid';
    for (let slot = 1; slot <= 3; slot += 1) {
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = `Save ${slot}`;
      save.dataset.testid = `save-slot-${slot}`;
      save.addEventListener('click', () => {
        void callbacks.onSave(slot);
      });
      slotGrid.appendChild(save);

      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = `Load ${slot}`;
      load.dataset.testid = `load-slot-${slot}`;
      load.addEventListener('click', () => {
        void callbacks.onLoad(slot);
      });
      slotGrid.appendChild(load);
    }

    this.element.appendChild(slotGrid);

    this.tip = document.createElement('p');
    this.tip.className = 'hud-tip';
    this.element.appendChild(this.tip);

    this.status = document.createElement('p');
    this.status.className = 'hud-status';
    this.status.dataset.testid = 'hud-status';
    this.status.textContent = 'Ready';
    this.element.appendChild(this.status);

    const debugSection = document.createElement('section');
    debugSection.className = 'debug-section';
    this.element.appendChild(debugSection);

    this.debugControls = document.createElement('div');
    this.debugControls.className = 'debug-controls';
    this.debugControls.appendChild(debugControlTabs);
    this.debugControls.appendChild(this.dayCycleGroup);
    this.debugControls.appendChild(this.weatherGroup);
    this.debugControls.appendChild(this.windGroup);
    this.debugControls.appendChild(this.seedGroup);
    debugSection.appendChild(this.debugControls);

    this.debugReadoutHeader = document.createElement('div');
    this.debugReadoutHeader.className = 'debug-readout-header';

    const debugReadoutTabs = document.createElement('div');
    debugReadoutTabs.className = 'debug-tab-row debug-tab-row-readout';

    const createDebugReadoutTabButton = (
      tab: DebugReadoutTab,
      label: string,
      testid: string
    ): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.testid = testid;
      button.addEventListener('click', () => {
        this.setActiveDebugReadoutTab(tab);
      });
      debugReadoutTabs.appendChild(button);
      return button;
    };

    this.debugReadoutTabs = {
      overview: createDebugReadoutTabButton('overview', 'Overview', 'debug-readout-tab-overview'),
      water: createDebugReadoutTabButton('water', 'Water', 'debug-readout-tab-water'),
      life: createDebugReadoutTabButton('life', 'Life', 'debug-readout-tab-life'),
      cell: createDebugReadoutTabButton('cell', 'Cell', 'debug-readout-tab-cell')
    };

    this.debugExpandButton = document.createElement('button');
    this.debugExpandButton.type = 'button';
    this.debugExpandButton.className = 'debug-expand-toggle';
    this.debugExpandButton.dataset.testid = 'debug-readout-expand';
    this.debugExpandButton.addEventListener('click', () => {
      this.debugReadoutExpanded = !this.debugReadoutExpanded;
      this.renderDebugReadout();
    });

    this.debugReadoutHeader.appendChild(debugReadoutTabs);
    this.debugReadoutHeader.appendChild(this.debugExpandButton);
    debugSection.appendChild(this.debugReadoutHeader);

    this.debugPanel = document.createElement('pre');
    this.debugPanel.className = 'hud-debug';
    this.debugPanel.dataset.testid = 'debug-readout';
    debugSection.appendChild(this.debugPanel);

    host.appendChild(this.element);

    this.refresh();
  }

  setTool(tool: ToolMode): void {
    this.state.tool = tool;
    for (const [mode, button] of Object.entries(this.toolButtons) as [
      ToolMode,
      HTMLButtonElement
    ][]) {
      button.classList.toggle('active', mode === tool);
    }
    this.updateContextualControlVisibility();
  }

  setInteractionMode(mode: InteractionMode): void {
    this.state.interactionMode = mode;
    this.cameraButton.classList.toggle('active', mode === 'camera');
    this.tip.textContent =
      mode === 'camera'
        ? 'Camera mode: left drag pan | right drag rotate | wheel zoom | P photo | R river guide | M audio | D debug'
        : 'Edit mode: left drag edit | right drag rotate | 0 camera mode | P photo | R river guide | M audio | D debug';
    this.updateContextualControlVisibility();
  }

  setAudioEnabled(enabled: boolean): void {
    this.state.audioEnabled = enabled;
    this.audioButton.classList.toggle('active', enabled);
    this.audioButton.textContent = enabled ? 'M Audio: ON' : 'M Audio: OFF';
  }

  setDebugMode(enabled: boolean): void {
    this.state.debugMode = enabled;
    this.debugButton.classList.toggle('active', enabled);
    this.debugButton.textContent = enabled ? 'D Debug: ON' : 'D Debug: OFF';
    this.debugControls.classList.toggle('visible', enabled);
    this.debugReadoutHeader.classList.toggle('visible', enabled);
    this.seedInput.disabled = !enabled;
    this.dayCycleModeInput.disabled = !enabled;
    this.manualHourInput.disabled = !enabled || this.state.dayCycleMode !== 'manual';
    this.weatherModeInput.disabled = !enabled;
    this.manualCloudInput.disabled = !enabled || this.state.weatherMode !== 'manual';
    this.manualRainInput.disabled = !enabled || this.state.weatherMode !== 'manual';
    this.windModeInput.disabled = !enabled;
    const windManualDisabled = !enabled || this.state.windMode !== 'manual';
    this.manualWindStrengthInput.disabled = windManualDisabled;
    this.manualWindDirectionInput.disabled = windManualDisabled;
    this.manualWindGustinessInput.disabled = windManualDisabled;
    if (!enabled) {
      this.debugReadoutExpanded = false;
    }
    this.updateDebugControlVisibility();
    this.renderDebugReadout();
  }

  setDebugReadout(text: string): void {
    this.rawDebugReadout = text;
    this.renderDebugReadout();
  }

  setTerrainSeed(seed: number): void {
    this.state.terrainSeed = normalizeSeed(seed);
    this.seedInput.value = String(this.state.terrainSeed);
  }

  setDayCycleMode(mode: DayCycleMode): void {
    this.state.dayCycleMode = mode;
    this.dayCycleModeInput.value = mode;
    this.manualHourInput.disabled = !this.state.debugMode || mode !== 'manual';
  }

  setManualHour(hour: number): void {
    this.state.manualHour = normalizeHour(hour);
    this.manualHourInput.value = this.state.manualHour.toFixed(1);
    this.manualHourValue.textContent = `${this.state.manualHour.toFixed(1)}h`;
  }

  setWeatherMode(mode: WeatherMode): void {
    this.state.weatherMode = mode;
    this.weatherModeInput.value = mode;
    const disabled = !this.state.debugMode || mode !== 'manual';
    this.manualCloudInput.disabled = disabled;
    this.manualRainInput.disabled = disabled;
  }

  setManualCloudiness(value: number): void {
    this.state.manualCloudiness = normalizeUnit(value);
    this.manualCloudInput.value = this.state.manualCloudiness.toFixed(2);
    this.manualCloudValue.textContent = this.state.manualCloudiness.toFixed(2);
  }

  setManualRainIntensity(value: number): void {
    this.state.manualRainIntensity = normalizeUnit(value);
    this.manualRainInput.value = this.state.manualRainIntensity.toFixed(2);
    this.manualRainValue.textContent = this.state.manualRainIntensity.toFixed(2);
  }

  setWindMode(mode: WindMode): void {
    this.state.windMode = mode;
    this.windModeInput.value = mode;
    const disabled = !this.state.debugMode || mode !== 'manual';
    this.manualWindStrengthInput.disabled = disabled;
    this.manualWindDirectionInput.disabled = disabled;
    this.manualWindGustinessInput.disabled = disabled;
  }

  setManualWindStrength(value: number): void {
    this.state.manualWindStrength = normalizeUnit(value);
    this.manualWindStrengthInput.value = this.state.manualWindStrength.toFixed(2);
    this.manualWindStrengthValue.textContent = this.state.manualWindStrength.toFixed(2);
  }

  setManualWindDirection(value: number): void {
    this.state.manualWindDirection = normalizeDirection(value);
    this.manualWindDirectionInput.value = this.state.manualWindDirection.toFixed(0);
    this.manualWindDirectionValue.textContent = `${this.state.manualWindDirection.toFixed(0)}deg`;
  }

  setManualWindGustiness(value: number): void {
    this.state.manualWindGustiness = normalizeUnit(value);
    this.manualWindGustinessInput.value = this.state.manualWindGustiness.toFixed(2);
    this.manualWindGustinessValue.textContent = this.state.manualWindGustiness.toFixed(2);
  }

  setRadius(radius: number): void {
    this.state.radius = clamp(Math.round(radius), 1, 40);
    this.radiusInput.value = String(this.state.radius);
    this.radiusValue.textContent = String(this.state.radius);
  }

  setStatus(message: string): void {
    this.status.textContent = message;
  }

  private setActiveDebugControlTab(tab: DebugControlTab): void {
    this.activeDebugControlTab = tab;
    for (const [key, button] of Object.entries(this.debugControlsTabs) as [
      DebugControlTab,
      HTMLButtonElement
    ][]) {
      button.classList.toggle('active', key === tab);
    }
    this.updateDebugControlVisibility();
  }

  private setActiveDebugReadoutTab(tab: DebugReadoutTab): void {
    this.activeDebugReadoutTab = tab;
    for (const [key, button] of Object.entries(this.debugReadoutTabs) as [
      DebugReadoutTab,
      HTMLButtonElement
    ][]) {
      button.classList.toggle('active', key === tab);
    }
    this.renderDebugReadout();
  }

  private updateDebugControlVisibility(): void {
    const debugVisible = this.state.debugMode;
    this.dayCycleGroup.classList.toggle(
      'visible',
      debugVisible && this.activeDebugControlTab === 'dayCycle'
    );
    this.weatherGroup.classList.toggle(
      'visible',
      debugVisible && this.activeDebugControlTab === 'weather'
    );
    this.windGroup.classList.toggle(
      'visible',
      debugVisible && this.activeDebugControlTab === 'wind'
    );
    this.seedGroup.classList.toggle(
      'visible',
      debugVisible && this.activeDebugControlTab === 'seed'
    );
  }

  private getReadoutLinesForTab(lines: string[]): string[] {
    const pickStartsWith = (prefix: string): string | null =>
      lines.find((line) => line.startsWith(prefix)) ?? null;
    const pickContains = (needle: string): string | null =>
      lines.find((line) => line.includes(needle)) ?? null;
    switch (this.activeDebugReadoutTab) {
      case 'overview':
        return [
          pickStartsWith('world ') ?? pickContains('totalWater=') ?? '',
          pickStartsWith('clock ') ?? '',
          pickStartsWith('weather ') ?? '',
          pickStartsWith('wind ') ?? '',
          pickStartsWith('life birds ') ?? '',
          pickStartsWith('sound ') ?? ''
        ].filter((line) => line.length > 0);
      case 'water':
        return lines.filter(
          (line) =>
            line.startsWith('water ') ||
            line.startsWith('humidity ') ||
            line.startsWith('world ') ||
            line.startsWith('weather ')
        );
      case 'life':
        return lines.filter((line) => line.startsWith('vegetation ') || line.startsWith('life '));
      case 'cell':
        return lines.filter(
          (line) =>
            line.startsWith('cell:') ||
            line.startsWith('terrain ') ||
            line.startsWith('water ') ||
            line.startsWith('humidity ')
        );
      default:
        return lines;
    }
  }

  private renderDebugReadout(): void {
    const enabled = this.state.debugMode;
    this.debugPanel.classList.toggle('visible', enabled);
    this.debugExpandButton.hidden = !enabled;
    if (!enabled) {
      this.debugPanel.textContent = '';
      return;
    }

    const lines = this.rawDebugReadout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    const tabLines = this.getReadoutLinesForTab(lines);
    const compactLineCount = this.activeDebugReadoutTab === 'overview' ? 5 : 4;
    const displayedLines = this.debugReadoutExpanded
      ? tabLines
      : tabLines.slice(0, compactLineCount);
    const collapsed = !this.debugReadoutExpanded && tabLines.length > compactLineCount;
    if (collapsed) {
      displayedLines.push(`... +${tabLines.length - compactLineCount} lines`);
    }
    this.debugPanel.textContent = displayedLines.join('\n');
    this.debugExpandButton.textContent = this.debugReadoutExpanded ? 'Less' : 'Details';
    this.debugExpandButton.classList.toggle('active', this.debugReadoutExpanded);
  }

  private createControlRow(
    labelText: string,
    input: HTMLInputElement,
    value: HTMLSpanElement
  ): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'control-row';

    const label = document.createElement('span');
    label.className = 'control-label';
    label.textContent = labelText;

    value.className = 'control-value';

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(value);
    return row;
  }

  private updateContextualControlVisibility(): void {
    const isCamera = this.state.interactionMode === 'camera';
    const isSourceTool = this.state.tool === 'waterSource';
    const isFlattenTool = this.state.tool === 'flatten';
    const showStrength = !isCamera && !isSourceTool;
    const showFlatten = !isCamera && isFlattenTool;
    const showSourceRate = !isCamera && isSourceTool;

    this.strengthRow.hidden = !showStrength;
    this.flattenRow.hidden = !showFlatten;
    this.sourceRateRow.hidden = !showSourceRate;
  }

  private refresh(): void {
    this.setInteractionMode(this.state.interactionMode);
    this.setAudioEnabled(this.state.audioEnabled);
    this.setTerrainSeed(this.state.terrainSeed);
    this.setTool(this.state.tool);
    this.setDayCycleMode(this.state.dayCycleMode);
    this.setManualHour(this.state.manualHour);
    this.setWeatherMode(this.state.weatherMode);
    this.setManualCloudiness(this.state.manualCloudiness);
    this.setManualRainIntensity(this.state.manualRainIntensity);
    this.setWindMode(this.state.windMode);
    this.setManualWindStrength(this.state.manualWindStrength);
    this.setManualWindDirection(this.state.manualWindDirection);
    this.setManualWindGustiness(this.state.manualWindGustiness);
    this.setActiveDebugControlTab(this.activeDebugControlTab);
    this.setActiveDebugReadoutTab(this.activeDebugReadoutTab);
    this.setDebugMode(this.state.debugMode);

    this.radiusInput.value = String(this.state.radius);
    this.radiusValue.textContent = String(this.state.radius);

    this.strengthInput.value = this.state.strength.toFixed(2);
    this.strengthValue.textContent = this.state.strength.toFixed(2);

    this.flattenInput.value = this.state.flattenHeight.toFixed(1);
    this.flattenValue.textContent = this.state.flattenHeight.toFixed(1);

    this.sourceRateInput.value = this.state.sourceRate.toFixed(1);
    this.sourceRateValue.textContent = this.state.sourceRate.toFixed(1);
    this.updateContextualControlVisibility();
  }
}
