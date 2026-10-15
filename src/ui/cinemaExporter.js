// src/ui/cinemaExporter.js
import * as THREE from 'three';

/**
 * Automated "Cosmic Wrapped" Cinema Director & Video Exporter (Blueprint 09)
 * Flies camera along Catmull-Rom splines while recording 60fps canvas + synth audio.
 */
export class CosmicCinemaDirector {
  constructor(renderer, camera, controls, sonicSynthesizer) {
    this.renderer = renderer;
    this.camera = camera;
    this.controls = controls;
    this.synth = sonicSynthesizer;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
    this.flightCurve = null;
    this.lookAtCurve = null;
    this.onProgress = null;
    this.onComplete = null;
  }

  buildTourSpline(nodes) {
    const topNodes = [...nodes]
      .filter(n => n.type === 'genre' || n.type === 'artist')
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 6);

    const camWaypoints = [new THREE.Vector3(0, 160, 320)];
    const lookWaypoints = [new THREE.Vector3(0, 0, 0)];

    topNodes.forEach((node, idx) => {
      const angle = idx * 1.25;
      const offsetDist = node.type === 'genre' ? 70 : 45;
      camWaypoints.push(
        new THREE.Vector3(
          node.position.x + Math.cos(angle) * offsetDist,
          node.position.y + 22,
          node.position.z + Math.sin(angle) * offsetDist
        )
      );
      lookWaypoints.push(node.position.clone());
    });

    // Close loop back to astronomical overview
    camWaypoints.push(new THREE.Vector3(0, 160, 320));
    lookWaypoints.push(new THREE.Vector3(0, 0, 0));

    this.flightCurve = new THREE.CatmullRomCurve3(camWaypoints, false, 'centripetal', 0.5);
    this.lookAtCurve = new THREE.CatmullRomCurve3(lookWaypoints, false, 'centripetal', 0.5);
  }

  startCinematicRecording(nodes, durationMs = 12000, onProgress = null, onComplete = null) {
    if (this.isRecording) return;
    this.onProgress = onProgress;
    this.onComplete = onComplete;

    this.buildTourSpline(nodes);
    this.recordedChunks = [];

    // 1. Capture 60 FPS Video Stream from Three.js WebGL Canvas
    const canvasStream = this.renderer.domElement.captureStream(60);

    // 2. Capture Web Audio API Synthesizer Stream if initialized
    if (this.synth?.ctx && this.synth?.masterGain) {
      try {
        const audioDest = this.synth.ctx.createMediaStreamDestination();
        this.synth.masterGain.connect(audioDest);
        const audioTrack = audioDest.stream.getAudioTracks()[0];
        if (audioTrack) canvasStream.addTrack(audioTrack);
      } catch (err) {
        console.warn('Audio capture warning:', err);
      }
    }

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : (MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4');

    try {
      this.mediaRecorder = new MediaRecorder(canvasStream, {
        mimeType,
        videoBitsPerSecond: 10000000
      });
    } catch (e) {
      this.mediaRecorder = new MediaRecorder(canvasStream);
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ASTRA_Cosmic_Flythrough_${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);

      this.isRecording = false;
      if (this.onComplete) this.onComplete();
    };

    this.isRecording = true;
    this.recordingStartTime = performance.now();
    this.recordingDuration = durationMs;
    this.mediaRecorder.start();
  }

  updateCinemaCamera(now) {
    if (!this.isRecording || !this.flightCurve) return;

    const elapsed = now - this.recordingStartTime;
    const t = Math.min(1.0, elapsed / this.recordingDuration);

    if (this.onProgress) {
      this.onProgress(Math.round(t * 100));
    }

    // Smooth cubic ease-in-out: 3t^2 - 2t^3
    const smoothT = t * t * (3.0 - 2.0 * t);

    const camPos = this.flightCurve.getPointAt(smoothT);
    const lookPos = this.lookAtCurve.getPointAt(smoothT);

    this.camera.position.copy(camPos);
    this.controls.target.copy(lookPos);
    this.controls.update();

    if (t >= 1.0) {
      this.stop();
    }
  }

  stop() {
    if (this.isRecording && this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.isRecording = false;
  }
}
