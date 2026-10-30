// Race audio built from real F1 recordings, see web/audio/CREDITS.md.
// Engine clips loop and shift pitch with the followed car, the way racing games layer engine sound.

const LOOPS = {
  idle: { loop: 1.36, rate: 1 },
  "engine-a": { loop: 0.9, rate: 1 },
  "engine-c": { loop: 0.78, rate: 0.8578 },
  crowd: { loop: 5.2, rate: 1 },
};
const PASS_BYS = ["passby-a", "passby-b", "passby-c"];
const LOOP_MARGIN = 0.1;
const GEAR_TOP_SPEED = [90, 90, 130, 165, 200, 240, 280, 320, 350];
const LOW_RPM = 5000;
const RPM_RANGE = 7500;
const RECORDED_RPM = 12000;
const IDLE_FADE_RPM = 8200;
const ENGINE_LEVEL = 0.9;
const MASTER_BOOST = 2.4;
const CROWD_LEVEL = 0.1;
const PASS_BY_LEVEL = 0.32;
const ENGINE_MIX = { idle: 0.7, "engine-a": 0.8, "engine-c": 0.22 };
const SMOOTHING = 0.05;
const RADIO_DUCK = 0.25;
const PASS_BY_MIN_GAP = 9;
const PASS_BY_MAX_GAP = 20;

export function estimateRpm(speed, gear) {
  const top = GEAR_TOP_SPEED[Math.max(Math.min(gear, 8), 0)];
  return LOW_RPM + RPM_RANGE * Math.min(speed / top, 1);
}

export class RaceSound {
  enabled = false;
  ready = null;
  context = null;
  analyser = null;
  buffers = {};
  radio = null;
  duck = 1;
  lastGear = 0;
  nextPassBy = 0;
  finished = false;
  volume = 0.5;

  // Loudness follows the square of the slider, which is how ears judge volume.
  setVolume(volume) {
    this.volume = volume;
    if (this.master) this.master.gain.setTargetAtTime(volume * volume * MASTER_BOOST, this.context.currentTime, 0.03);
  }

  async setEnabled(on) {
    this.enabled = on;
    if (on && !this.context) this.ready = this.build();
    if (!this.context) return;
    if (on) {
      await this.context.resume();
      await this.ready;
    } else {
      this.stopRadio();
      await this.context.suspend();
    }
  }

  async build() {
    const context = new AudioContext();
    this.context = context;
    const names = [...Object.keys(LOOPS), ...PASS_BYS];
    await Promise.all(names.map(async (name) => {
      const response = await fetch(`audio/${name}.mp3`);
      this.buffers[name] = await context.decodeAudioData(await response.arrayBuffer());
    }));

    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 3;
    limiter.attack.value = 0.01;
    limiter.release.value = 0.25;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 8192;
    this.master = context.createGain();
    this.master.gain.value = this.volume * this.volume * MASTER_BOOST;
    this.master.connect(limiter).connect(this.analyser).connect(context.destination);

    this.engineBus = context.createGain();
    this.engineBus.gain.value = 0;
    this.filter = context.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.Q.value = 0.4;
    this.pan = context.createStereoPanner();
    this.engineBus.connect(this.filter).connect(this.pan).connect(this.master);

    this.layers = Object.keys(ENGINE_MIX).map((name) => {
      const gain = context.createGain();
      gain.gain.value = 0;
      const source = this.loop(name, gain);
      gain.connect(this.engineBus);
      return { name, gain, source, rate: LOOPS[name].rate };
    });

    this.crowdGain = context.createGain();
    this.crowdGain.gain.value = CROWD_LEVEL * 0.5;
    this.loop("crowd", this.crowdGain);
    this.crowdGain.connect(this.master);

    this.passGain = context.createGain();
    this.passGain.gain.value = PASS_BY_LEVEL;
    this.passGain.connect(this.master);
  }

  loop(name, destination) {
    const source = this.context.createBufferSource();
    source.buffer = this.buffers[name];
    source.loop = true;
    source.loopStart = LOOP_MARGIN;
    source.loopEnd = LOOP_MARGIN + LOOPS[name].loop;
    source.connect(destination);
    source.start(0, LOOP_MARGIN + Math.random() * LOOPS[name].loop * 0.5);
    return source;
  }

  update({ running, speed = 0, gear = 0, throttle = 0, pan = 0, presence = 0 }) {
    if (!this.enabled || !this.layers) return;
    const now = this.context.currentTime;
    const rpm = estimateRpm(speed, gear);
    const power = Math.min(throttle, 100) / 100;
    const idle = Math.min(Math.max((IDLE_FADE_RPM - rpm) / 2600, 0), 1);
    for (const layer of this.layers) {
      const isIdle = layer.name === "idle";
      const rate = isIdle ? rpm / LOW_RPM : (layer.rate * rpm) / RECORDED_RPM;
      layer.source.playbackRate.setTargetAtTime(rate, now, SMOOTHING);
      layer.gain.gain.setTargetAtTime(ENGINE_MIX[layer.name] * (isIdle ? idle : 1 - idle), now, 0.08);
    }
    this.filter.frequency.setTargetAtTime(700 + power * 3300, now, SMOOTHING);
    const level = running ? ENGINE_LEVEL * presence * (0.4 + 0.6 * power) * this.duck : 0;
    if (running && gear !== this.lastGear && this.lastGear !== 0 && presence > 0.2) {
      this.engineBus.gain.cancelScheduledValues(now);
      this.engineBus.gain.setValueAtTime(level * 0.3, now);
      this.engineBus.gain.setTargetAtTime(level, now + 0.04, 0.03);
    } else {
      this.engineBus.gain.setTargetAtTime(level, now, SMOOTHING);
    }
    this.lastGear = gear;
    this.pan.pan.setTargetAtTime(Math.max(-0.3, Math.min(0.3, pan)), now, 0.3);
    this.crowdGain.gain.setTargetAtTime(CROWD_LEVEL * (running ? 1 : 0.6) * this.duck, now, 0.5);

    if (running && presence < 0.25 && now >= this.nextPassBy) {
      this.passBy();
      this.nextPassBy = now + PASS_BY_MIN_GAP + Math.random() * (PASS_BY_MAX_GAP - PASS_BY_MIN_GAP);
    }
    if (!running) this.finished = false;
  }

  // A real car going past, swept across the stereo field.
  passBy() {
    const source = this.context.createBufferSource();
    source.buffer = this.buffers[PASS_BYS[Math.floor(Math.random() * PASS_BYS.length)]];
    source.playbackRate.value = 0.92 + Math.random() * 0.16;
    const pan = this.context.createStereoPanner();
    const from = Math.random() > 0.5 ? -0.85 : 0.85;
    const now = this.context.currentTime;
    pan.pan.setValueAtTime(from, now);
    pan.pan.linearRampToValueAtTime(-from, now + source.buffer.duration * 0.75);
    source.connect(pan).connect(this.passGain);
    source.start();
  }

  swell(level, seconds) {
    if (!this.layers) return;
    const now = this.context.currentTime;
    this.crowdGain.gain.cancelScheduledValues(now);
    this.crowdGain.gain.setTargetAtTime(level, now, 0.2);
    this.crowdGain.gain.setTargetAtTime(CROWD_LEVEL, now + seconds, 1.5);
  }

  lamp() {
    if (this.enabled) this.swell(CROWD_LEVEL * 1.2, 1);
  }

  lightsOut() {
    if (this.enabled) this.swell(CROWD_LEVEL * 3, 3);
  }

  cheer() {
    if (this.enabled) this.swell(CROWD_LEVEL * 2, 2);
  }

  finish() {
    if (!this.enabled || this.finished) return;
    this.finished = true;
    this.swell(CROWD_LEVEL * 3.5, 5);
  }

  // Team radio streams from Formula 1's servers, so a clip that has gone just reports false.
  async playRadio(url) {
    this.stopRadio();
    const clip = new Audio(url);
    this.radio = clip;
    this.setDuck(RADIO_DUCK);
    const done = () => {
      if (this.radio === clip) this.stopRadio();
    };
    clip.addEventListener("ended", done);
    clip.addEventListener("error", done);
    try {
      await clip.play();
      return true;
    } catch {
      done();
      return false;
    }
  }

  stopRadio() {
    this.radio?.pause();
    this.radio = null;
    this.setDuck(1);
  }

  setDuck(level) {
    this.duck = level;
  }
}
