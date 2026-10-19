// src/renderer/cameraController.js
import * as THREE from 'three';

/** Smooth camera flights: to a node, zoom in/out steps, or back to a view of the whole galaxy. */
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
    // Suns frame their whole cluster disc; planets frame their moon system + collab threads.
    const standoffDist =
      node.type === 'genre' ? Math.max(58, (node.currentClusterRadius || node.clusterRadius || 50) * 1.85) :
      node.type === 'artist' ? 20 + (node.systemRadius || node.baseRadius * 4) * 2.0 : 13;
    // Portrait phones are narrow (and half covered by the sheet): stand further back.
    const portrait = this.camera.aspect < 1 ? Math.min(1.65, 0.85 / this.camera.aspect) : 1;

    const viewDir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (viewDir.lengthSq() < 0.001) viewDir.set(0, 0.4, 1).normalize();

    this.targetLookAt.copy(node.position);
    this.targetCameraPos.copy(node.position).addScaledVector(viewDir, standoffDist * Math.max(1, portrait));
    this.active = true;
  }

  /** Smoothly zooms in (`factor < 1`) or out (`factor > 1`) around the current lookAt target. */
  zoomBy(factor = 0.72) {
    const baseTarget = this.active ? this.targetLookAt : this.controls.target;
    const baseCam = this.active ? this.targetCameraPos : this.camera.position;
    const offset = new THREE.Vector3().subVectors(baseCam, baseTarget);
    const curDist = Math.max(this.controls.minDistance || 5, offset.length());
    const nextDist = THREE.MathUtils.clamp(
      curDist * factor,
      this.controls.minDistance || 5,
      this.controls.maxDistance || 850
    );
    if (offset.lengthSq() < 0.001) offset.set(0, 0.4, 1);
    offset.normalize().multiplyScalar(nextDist);
    this.targetLookAt.copy(baseTarget);
    this.targetCameraPos.copy(baseTarget).add(offset);
    this.active = true;
  }

  /** Frames the whole galaxy; radius comes from the layout's bounding radius. */
  setSceneRadius(radius) {
    this.sceneRadius = radius;
    this.controls.maxDistance = Math.max(850, radius * 3.2);
  }

  resetOverview() {
    const R = this.sceneRadius || 200;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = (R / Math.sin(Math.min(vFov, hFov) / 2)) * (this.camera.aspect < 1 ? 1.08 : 1.0);
    this.targetLookAt.set(0, 0, 0);
    this.targetCameraPos.set(0, dist * 0.52, dist * 0.84);
    this.active = true;
  }

  update(selectedNode) {
    if (this.active) {
      this.camera.position.lerp(this.targetCameraPos, 0.08);
      this.controls.target.lerp(this.targetLookAt, 0.09);
      if (this.camera.position.distanceTo(this.targetCameraPos) < 0.45) this.active = false;
    } else if (selectedNode) {
      // Keep the selected body centered as it orbits.
      this.controls.target.lerp(selectedNode.position, 0.08);
    }
    this.controls.update();
  }
}
