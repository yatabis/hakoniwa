interface AmbientAudioUpdateParams {
  daylight: number;
  rainIntensity: number;
  windStrength: number;
  windGustiness: number;
  waterProximity: number;
  waterFlow: number;
  waterDepth: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function createNoiseBuffer(context: AudioContext, seconds = 2): AudioBuffer {
  const frameCount = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < frameCount; index += 1) {
    channel[index] = Math.random() * 2 - 1;
  }
  return buffer;
}

function setSmoothParam(param: AudioParam, value: number, now: number, timeConstant: number): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, timeConstant);
}

type AmbientAudioNodeGraph = {
  context: AudioContext;
  masterGain: GainNode;
  windBusGain: GainNode;
  windBreezeGain: GainNode;
  windBreezeBandpass: BiquadFilterNode;
  windBreezeLowpass: BiquadFilterNode;
  windGaleGain: GainNode;
  windGaleBandpass: BiquadFilterNode;
  windGaleLowpass: BiquadFilterNode;
  windRumbleGain: GainNode;
  windRumbleLowpass: BiquadFilterNode;
  rainDrizzleGain: GainNode;
  rainDrizzleBandpass: BiquadFilterNode;
  rainHeavyGain: GainNode;
  rainHeavyHighpass: BiquadFilterNode;
  waterBabbleGain: GainNode;
  waterBabbleBandpass: BiquadFilterNode;
  waterRoarGain: GainNode;
  waterRoarBandpass: BiquadFilterNode;
  noiseSources: AudioBufferSourceNode[];
};

export class AmbientAudioController {
  private graph: AmbientAudioNodeGraph | null = null;
  private enabled = true;
  private started = false;
  private timeSeconds = 0;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isStarted(): boolean {
    return this.started;
  }

  async ensureStarted(): Promise<boolean> {
    if (typeof window === 'undefined') {
      return false;
    }

    const AudioContextCtor =
      window.AudioContext ??
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;

    if (!AudioContextCtor) {
      return false;
    }

    if (!this.graph) {
      const context = new AudioContextCtor();
      this.graph = this.createGraph(context);
    }

    const context = this.graph.context;
    if (context.state !== 'running') {
      try {
        await context.resume();
      } catch {
        this.started = false;
        return false;
      }
    }

    this.started = context.state === 'running';
    return this.started;
  }

  update(params: AmbientAudioUpdateParams, deltaSeconds: number): void {
    this.timeSeconds += Math.max(0, deltaSeconds);

    const graph = this.graph;
    if (!graph) {
      return;
    }

    const now = graph.context.currentTime;
    const active = this.enabled && this.started;
    setSmoothParam(graph.masterGain.gain, active ? 0.84 : 0, now, 0.08);
    if (!active) {
      setSmoothParam(graph.windBusGain.gain, 0, now, 0.08);
      setSmoothParam(graph.windBreezeGain.gain, 0, now, 0.08);
      setSmoothParam(graph.windGaleGain.gain, 0, now, 0.08);
      setSmoothParam(graph.windRumbleGain.gain, 0, now, 0.08);
      setSmoothParam(graph.rainDrizzleGain.gain, 0, now, 0.08);
      setSmoothParam(graph.rainHeavyGain.gain, 0, now, 0.08);
      setSmoothParam(graph.waterBabbleGain.gain, 0, now, 0.08);
      setSmoothParam(graph.waterRoarGain.gain, 0, now, 0.08);
      return;
    }

    const daylight = clamp01(params.daylight);
    const rainIntensity = clamp01(params.rainIntensity);
    const windStrength = clamp01(params.windStrength);
    const windGustiness = clamp01(params.windGustiness);
    const waterProximity = clamp01(params.waterProximity);
    const waterFlow = clamp01(params.waterFlow);
    const waterDepth = clamp01(params.waterDepth);
    const windEnergy = clamp01(windStrength * (0.9 + windGustiness * 0.1));
    const waterPresence = waterProximity * (0.35 + waterDepth * 0.65);
    const babbleMix = Math.pow(1 - waterFlow, 0.72);
    const rapidMix = Math.pow(waterFlow, 1.32);
    const gustPulse =
      Math.sin(this.timeSeconds * 0.86 + 0.4) * 0.5 +
      Math.sin(this.timeSeconds * 0.37 + 1.9) * 0.28;
    const gustModulation =
      0.86 + (gustPulse * 0.5 + 0.5) * (0.16 + windGustiness * 0.38) * (0.52 + windEnergy * 0.48);
    const stormPulse =
      Math.sin(this.timeSeconds * 0.21 + 0.8) * 0.5 +
      Math.sin(this.timeSeconds * 0.12 + 2.3) * 0.36;
    const stormModulation = 0.84 + (stormPulse * 0.5 + 0.5) * (0.2 + windGustiness * 0.34);

    const nightBoost = 1 - daylight * 0.24;
    const dayBalance = 0.92 + nightBoost * 0.08;
    const breezeMix = clamp01(1 - windEnergy * 1.2);
    const galeMix = clamp01((windEnergy - 0.18) / 0.82);
    const rumbleMix = clamp01((windEnergy - 0.34) / 0.66);
    const baseWind = Math.pow(windEnergy, 0.94) * dayBalance;
    const windBreezeGainTarget =
      baseWind * (0.07 + breezeMix * 0.09) * (0.9 + windGustiness * 0.22);
    const windGaleGainTarget =
      baseWind *
      (0.03 + galeMix * 0.24) *
      gustModulation *
      stormModulation *
      (0.88 + windGustiness * 0.4);
    const windRumbleGainTarget =
      baseWind * (0.012 + rumbleMix * 0.11) * stormModulation * (0.84 + windGustiness * 0.48);
    const drizzleMix = clamp01(1 - rainIntensity * 1.18);
    const heavyMix = clamp01((rainIntensity - 0.24) / 0.76);
    const rainDrizzleGainTarget =
      rainIntensity * (0.028 + drizzleMix * 0.095) * (1 - heavyMix * 0.54);
    const rainHeavyGainTarget = Math.pow(heavyMix, 1.16) * (0.016 + rainIntensity * 0.19);
    const waterPulse =
      Math.sin(this.timeSeconds * 3.1 + 1.2) * 0.5 +
      Math.sin(this.timeSeconds * 4.7 + 0.3) * 0.28 +
      Math.sin(this.timeSeconds * 7.4 + 2.4) * 0.22;
    const pulseMix = 0.78 + (waterPulse * 0.5 + 0.5) * (0.28 + babbleMix * 0.25);
    const waterBabbleGainTarget =
      waterPresence * (0.028 + babbleMix * 0.1) * pulseMix * (0.9 + rainIntensity * 0.18);
    const waterRoarGainTarget =
      waterPresence * rapidMix * (0.012 + 0.13 * (0.72 + rainIntensity * 0.32));

    setSmoothParam(graph.windBusGain.gain, 1.85, now, 0.08);
    setSmoothParam(graph.windBreezeGain.gain, windBreezeGainTarget, now, 0.09);
    setSmoothParam(graph.windGaleGain.gain, windGaleGainTarget, now, 0.08);
    setSmoothParam(graph.windRumbleGain.gain, windRumbleGainTarget, now, 0.08);
    setSmoothParam(graph.rainDrizzleGain.gain, rainDrizzleGainTarget, now, 0.07);
    setSmoothParam(graph.rainHeavyGain.gain, rainHeavyGainTarget, now, 0.07);
    setSmoothParam(graph.waterBabbleGain.gain, waterBabbleGainTarget, now, 0.09);
    setSmoothParam(graph.waterRoarGain.gain, waterRoarGainTarget, now, 0.08);

    setSmoothParam(
      graph.windBreezeBandpass.frequency,
      140 + breezeMix * 110 + windEnergy * 170,
      now,
      0.17
    );
    setSmoothParam(graph.windBreezeLowpass.frequency, 650 + windEnergy * 190, now, 0.17);
    setSmoothParam(
      graph.windGaleBandpass.frequency,
      250 + windEnergy * 360 + windGustiness * 120,
      now,
      0.14
    );
    setSmoothParam(graph.windGaleLowpass.frequency, 780 + windEnergy * 210, now, 0.14);
    setSmoothParam(
      graph.windRumbleLowpass.frequency,
      80 + rumbleMix * 100 + windGustiness * 35,
      now,
      0.14
    );
    setSmoothParam(
      graph.rainDrizzleBandpass.frequency,
      2000 + drizzleMix * 500 + windEnergy * 220,
      now,
      0.15
    );
    setSmoothParam(graph.rainHeavyHighpass.frequency, 1500 + windEnergy * 420, now, 0.15);
    setSmoothParam(
      graph.waterBabbleBandpass.frequency,
      660 + babbleMix * 520 + rainIntensity * 120,
      now,
      0.14
    );
    setSmoothParam(
      graph.waterRoarBandpass.frequency,
      280 + rapidMix * 280 + rainIntensity * 60,
      now,
      0.12
    );
  }

  async dispose(): Promise<void> {
    const graph = this.graph;
    if (!graph) {
      return;
    }

    for (const source of graph.noiseSources) {
      try {
        source.stop();
      } catch {
        // no-op: source may already be stopped.
      }
      source.disconnect();
    }

    graph.masterGain.disconnect();
    graph.windBusGain.disconnect();
    graph.windBreezeGain.disconnect();
    graph.windGaleGain.disconnect();
    graph.windRumbleGain.disconnect();
    graph.rainDrizzleGain.disconnect();
    graph.rainHeavyGain.disconnect();
    graph.waterBabbleGain.disconnect();
    graph.waterRoarGain.disconnect();
    graph.windBreezeBandpass.disconnect();
    graph.windBreezeLowpass.disconnect();
    graph.windGaleBandpass.disconnect();
    graph.windGaleLowpass.disconnect();
    graph.windRumbleLowpass.disconnect();
    graph.rainDrizzleBandpass.disconnect();
    graph.rainHeavyHighpass.disconnect();
    graph.waterBabbleBandpass.disconnect();
    graph.waterRoarBandpass.disconnect();

    await graph.context.close();
    this.graph = null;
    this.started = false;
  }

  private createGraph(context: AudioContext): AmbientAudioNodeGraph {
    const noiseBuffer = createNoiseBuffer(context, 2.2);
    const masterGain = context.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(context.destination);
    const windBusGain = context.createGain();
    windBusGain.gain.value = 0;
    windBusGain.connect(masterGain);

    const makeNoiseSource = (): AudioBufferSourceNode => {
      const source = context.createBufferSource();
      source.buffer = noiseBuffer;
      source.loop = true;
      source.start();
      return source;
    };

    const windSource = makeNoiseSource();
    const rainSource = makeNoiseSource();
    const waterSource = makeNoiseSource();

    const windBreezeBandpass = context.createBiquadFilter();
    windBreezeBandpass.type = 'bandpass';
    windBreezeBandpass.frequency.value = 320;
    windBreezeBandpass.Q.value = 0.66;
    const windBreezeLowpass = context.createBiquadFilter();
    windBreezeLowpass.type = 'lowpass';
    windBreezeLowpass.frequency.value = 1500;
    const windBreezeGain = context.createGain();
    windBreezeGain.gain.value = 0;
    windSource.connect(windBreezeBandpass);
    windBreezeBandpass.connect(windBreezeLowpass);
    windBreezeLowpass.connect(windBreezeGain);
    windBreezeGain.connect(windBusGain);

    const windGaleBandpass = context.createBiquadFilter();
    windGaleBandpass.type = 'bandpass';
    windGaleBandpass.frequency.value = 420;
    windGaleBandpass.Q.value = 0.52;
    const windGaleLowpass = context.createBiquadFilter();
    windGaleLowpass.type = 'lowpass';
    windGaleLowpass.frequency.value = 980;
    const windGaleGain = context.createGain();
    windGaleGain.gain.value = 0;
    windSource.connect(windGaleBandpass);
    windGaleBandpass.connect(windGaleLowpass);
    windGaleLowpass.connect(windGaleGain);
    windGaleGain.connect(windBusGain);

    const windRumbleLowpass = context.createBiquadFilter();
    windRumbleLowpass.type = 'lowpass';
    windRumbleLowpass.frequency.value = 160;
    const windRumbleGain = context.createGain();
    windRumbleGain.gain.value = 0;
    windSource.connect(windRumbleLowpass);
    windRumbleLowpass.connect(windRumbleGain);
    windRumbleGain.connect(windBusGain);

    const rainDrizzleBandpass = context.createBiquadFilter();
    rainDrizzleBandpass.type = 'bandpass';
    rainDrizzleBandpass.frequency.value = 2300;
    rainDrizzleBandpass.Q.value = 0.72;
    const rainDrizzleGain = context.createGain();
    rainDrizzleGain.gain.value = 0;
    rainSource.connect(rainDrizzleBandpass);
    rainDrizzleBandpass.connect(rainDrizzleGain);
    rainDrizzleGain.connect(masterGain);

    const rainHeavyHighpass = context.createBiquadFilter();
    rainHeavyHighpass.type = 'highpass';
    rainHeavyHighpass.frequency.value = 1500;
    const rainHeavyGain = context.createGain();
    rainHeavyGain.gain.value = 0;
    rainSource.connect(rainHeavyHighpass);
    rainHeavyHighpass.connect(rainHeavyGain);
    rainHeavyGain.connect(masterGain);

    const waterBabbleBandpass = context.createBiquadFilter();
    waterBabbleBandpass.type = 'bandpass';
    waterBabbleBandpass.frequency.value = 900;
    waterBabbleBandpass.Q.value = 0.8;
    const waterBabbleGain = context.createGain();
    waterBabbleGain.gain.value = 0;
    waterSource.connect(waterBabbleBandpass);
    waterBabbleBandpass.connect(waterBabbleGain);
    waterBabbleGain.connect(masterGain);

    const waterRoarBandpass = context.createBiquadFilter();
    waterRoarBandpass.type = 'bandpass';
    waterRoarBandpass.frequency.value = 320;
    waterRoarBandpass.Q.value = 0.72;
    const waterRoarGain = context.createGain();
    waterRoarGain.gain.value = 0;
    waterSource.connect(waterRoarBandpass);
    waterRoarBandpass.connect(waterRoarGain);
    waterRoarGain.connect(masterGain);

    return {
      context,
      masterGain,
      windBusGain,
      windBreezeGain,
      windBreezeBandpass,
      windBreezeLowpass,
      windGaleGain,
      windGaleBandpass,
      windGaleLowpass,
      windRumbleGain,
      windRumbleLowpass,
      rainDrizzleGain,
      rainDrizzleBandpass,
      rainHeavyGain,
      rainHeavyHighpass,
      waterBabbleGain,
      waterBabbleBandpass,
      waterRoarGain,
      waterRoarBandpass,
      noiseSources: [windSource, rainSource, waterSource]
    };
  }
}
