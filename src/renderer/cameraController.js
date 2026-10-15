// src/renderer/cameraController.js
import * as THREE from 'three';

/** Smooth camera flights: to a node, or back to a view of the whole galaxy. */
export class CameraFlightController {
  constructor(camera, orbitControls) {
    this.camera = camera;
    this.controls = orbitControls;
    this.active = false;
    this.targetCameraPos = new THREE.Vector3();
    this.targetLookAt = new THREE.Vector3();
    this.sceneRadius = 200;

    // Grabbing the view cancels an in-progress flight instead of fighting it.
    this.controls.addEventListener('start', () => { this.active = false; });
  }

  flyToNode(node) {
    // Suns frame their whole cluster disc; planets frame their moon system.
    const standoffDist =
      node.type === 'genre' ? Math.max(70, (node.clusterRadius || 60) * 1.9) :
      node.type === 'artist' ? 26 + (node.systemRadius || node.baseRadius * 4) * 2.2 : 14;

    const viewDir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (viewDir.lengthSq() < 0.001) viewDir.set(0, 0.4, 1).normalize();

    this.targetLookAt.copy(node.position);
    this.targetCameraPos.copy(node.position).addScaledVector(viewDir, standoffDist);
    this.active = true;
  }

  /** Frames the whole galaxy; radius comes from the layout's bounding radius. */
  setSceneRadius(radius) {
    this.sceneRadius = radius;
    this.controls.maxDistance = Math.max(850, radius * 3.2);
  }

  resetOverview() {
    // Distance at which a sphere of radius R fits the narrower field of view, plus margin.
    const R = this.sceneRadius || 200;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    // Portrait screens get more margin: the galaxy's widest axis is horizontal.
    const dist = (R / Math.sin(Math.min(vFov, hFov) / 2)) * (this.camera.aspect < 1 ? 1.0 : 0.82);
    this.targetLookAt.set(0, 0, 0);
    this.targetCameraPos.set(0, dist * 0.55, dist * 0.835);
    this.active = true;
  }

  update(selectedNode) {
    if (this.active) {
      this.camera.position.lerp(this.targetCameraPos, 0.065);
      this.controls.target.lerp(this.targetLookAt, 0.08);
      if (this.camera.position.distanceTo(this.targetCameraPos) < 0.5) this.active = false;
    } else if (selectedNode) {
      // Keep the selected body centered as it orbits.
      this.controls.target.lerp(selectedNode.position, 0.08);
    }
    this.controls.update();
  }
}
