// src/renderer/cameraController.js
import * as THREE from 'three';

export class CameraFlightController {
  constructor(camera, orbitControls) {
    this.camera = camera;
    this.controls = orbitControls;
    this.active = false;
    this.targetCameraPos = new THREE.Vector3();
    this.targetLookAt = new THREE.Vector3();

    // Auto-pilot tour state
    this.autoPilotActive = false;
    this.autoPilotNodes = [];
    this.autoPilotIndex = 0;
    this.autoPilotTimer = 0;
    this.onWarpChange = null;
  }

  flyToNode(node) {
    const standoffDist =
      node.type === 'genre' ? 85.0 :
      node.type === 'artist' ? 56.0 : 36.0;

    const viewDir = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
      .normalize();

    if (viewDir.lengthSq() < 0.001) {
      viewDir.set(0, 0.4, 1).normalize();
    }

    this.targetLookAt.copy(node.position);
    this.targetCameraPos.copy(node.position).addScaledVector(viewDir, standoffDist);
    this.active = true;

    if (this.onWarpChange) {
      this.onWarpChange(1.0);
    }
  }

  resetOverview() {
    this.targetLookAt.set(0, 0, 0);
    this.targetCameraPos.set(0, 160, 320);
    this.active = true;
    if (this.onWarpChange) this.onWarpChange(0.6);
  }

  startAutoPilot(nodes) {
    this.autoPilotActive = true;
    this.autoPilotNodes = nodes.filter(n => n.type === 'genre' || n.type === 'artist')
      .sort((a, b) => b.plays - a.plays);
    this.autoPilotIndex = 0;
    this.autoPilotTimer = performance.now();
    if (this.autoPilotNodes.length > 0) {
      this.flyToNode(this.autoPilotNodes[0]);
    }
  }

  stopAutoPilot() {
    this.autoPilotActive = false;
  }

  update(selectedNode, now) {
    if (this.active) {
      this.camera.position.lerp(this.targetCameraPos, 0.065);
      this.controls.target.lerp(this.targetLookAt, 0.08);

      if (this.camera.position.distanceTo(this.targetCameraPos) < 1.0) {
        this.active = false;
        if (this.onWarpChange) this.onWarpChange(0.0);
      }
    } else if (selectedNode) {
      // Smoothly track selected node as it orbits
      this.controls.target.lerp(selectedNode.position, 0.08);
    }

    // Auto-pilot tour progression
    if (this.autoPilotActive && this.autoPilotNodes.length > 0) {
      if (now - this.autoPilotTimer > 6000) {
        this.autoPilotTimer = now;
        this.autoPilotIndex = (this.autoPilotIndex + 1) % Math.min(8, this.autoPilotNodes.length);
        this.flyToNode(this.autoPilotNodes[this.autoPilotIndex]);
      }
    }

    this.controls.update();
  }
}
