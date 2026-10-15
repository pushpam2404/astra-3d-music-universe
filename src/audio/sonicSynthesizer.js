// src/audio/sonicSynthesizer.js
/**
 * Procedural Web Audio API Sonic DNA Synthesizer (Blueprint 05)
 * Translates Spotify Audio Features into a real-time polyphonic synthesizer and FFT spectrum visualizer.
 */

export class SonicDnaSynthesizer {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.masterGain = null;
    this.isPlaying = false;
    this.arpTimer = null;
    this.activeNode = null;
    this.freqData = new Uint8Array(64);
  }

  initContext() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 128;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.22;

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playNodeSignature(node) {
    this.initContext();
    this.stop();
    this.isPlaying = true;
    this.activeNode = node;

    const bpm = Math.max(60, Math.min(200, node.bpm || 120));
    const valence = node.valence ?? 0.65;
    const energy = node.energy ?? 0.75;
    const acoustic = node.acoustic ?? 0.30;

    // 1. Determine root frequency & modal scale intervals from Valence
    const rootFreq = 130.81 + ((bpm % 12) * 8.5); // Near C3
    const scaleIntervals =
      valence >= 0.60 ? [0, 4, 7, 11, 14, 18] : // Lydian (Cosmic euphoria)
      valence >= 0.45 ? [0, 3, 7, 10, 14, 17] : // Dorian (Contemplative)
                        [0, 3, 7, 8, 12, 15];    // Aeolian (Deep nocturnal)

    const stepDurationMs = Math.max(120, Math.round((60 / bpm) * 500));
    let stepIndex = 0;

    const triggerArpStep = () => {
      if (!this.isPlaying || !this.ctx) return;
      const now = this.ctx.currentTime;

      const semitone = scaleIntervals[stepIndex % scaleIntervals.length] + (stepIndex % 8 === 7 ? 12 : 0);
      const noteFreq = rootFreq * Math.pow(2, semitone / 12);

      // Lead Voice
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const env = this.ctx.createGain();

      osc.type = energy > 0.75 ? 'sawtooth' : (acoustic > 0.5 ? 'triangle' : 'sine');
      osc.frequency.setValueAtTime(noteFreq, now);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(450 + energy * 2800, now);
      filter.Q.value = 3.5;

      const noteDurationSec = (stepDurationMs / 1000) * 1.5;
      env.gain.setValueAtTime(0.001, now);
      env.gain.linearRampToValueAtTime(0.25, now + 0.03);
      env.gain.exponentialRampToValueAtTime(0.001, now + noteDurationSec);

      osc.connect(filter);
      filter.connect(env);
      env.connect(this.masterGain);

      osc.start(now);
      osc.stop(now + noteDurationSec + 0.05);

      // Warm Sub-Bass Fundamental every 4 steps
      if (stepIndex % 4 === 0) {
        const subOsc = this.ctx.createOscillator();
        const subEnv = this.ctx.createGain();
        const subDurationSec = (stepDurationMs / 1000) * 3.6;

        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(rootFreq * 0.5, now);

        subEnv.gain.setValueAtTime(0.001, now);
        subEnv.gain.linearRampToValueAtTime(0.2, now + 0.08);
        subEnv.gain.exponentialRampToValueAtTime(0.001, now + subDurationSec);

        subOsc.connect(subEnv);
        subEnv.connect(this.masterGain);

        subOsc.start(now);
        subOsc.stop(now + subDurationSec + 0.1);
      }

      stepIndex++;
    };

    triggerArpStep();
    this.arpTimer = setInterval(triggerArpStep, stepDurationMs);
  }

  stop() {
    this.isPlaying = false;
    this.activeNode = null;
    if (this.arpTimer) {
      clearInterval(this.arpTimer);
      this.arpTimer = null;
    }
  }

  getFrequencyData() {
    if (this.analyser && this.isPlaying) {
      this.analyser.getByteFrequencyData(this.freqData);
    } else {
      this.freqData.fill(0);
    }
    return this.freqData;
  }

  renderVisualizer(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const data = this.getFrequencyData();
    const barCount = 28;
    const barWidth = (width / barCount) - 2;

    for (let i = 0; i < barCount; i++) {
      const val = data[i * 2] / 255.0;
      const barHeight = Math.max(3, val * (height - 6));
      const x = i * (barWidth + 2);
      const y = height - barHeight;

      const grad = ctx.createLinearGradient(0, height, 0, 0);
      grad.addColorStop(0, '#00F0FF');
      grad.addColorStop(0.6, '#FF007F');
      grad.addColorStop(1, '#FFB800');

      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }
}
