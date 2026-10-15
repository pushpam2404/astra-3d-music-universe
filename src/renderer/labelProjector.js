// src/renderer/labelProjector.js
import * as THREE from 'three';

const tempProjVec = new THREE.Vector3();

export class LabelProjector {
  constructor(containerEl) {
    this.container = containerEl;
    this.labelPool = new Map();
  }

  syncLabels(nodes, onLabelClick) {
    // Clear old labels
    this.container.innerHTML = '';
    this.labelPool.clear();

    nodes.forEach(node => {
      const el = document.createElement('div');
      el.className = `celestial-hud-label label-${node.type}`;
      if (node.isWormholeBridge) el.classList.add('label-wormhole');

      el.innerHTML = `
        <span class="label-dot" style="background:${node.color}"></span>
        <span class="label-text">${node.name}</span>
      `;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onLabelClick) onLabelClick(node);
      });

      this.container.appendChild(el);
      this.labelPool.set(node.id, el);
      node.labelEl = el;
    });
  }

  update(nodes, camera, activeNode, scaleMultiplier = 1.0, labelsVisible = true) {
    if (!labelsVisible) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'block';

    const halfW = window.innerWidth * 0.5;
    const halfH = window.innerHeight * 0.5;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const el = this.labelPool.get(node.id);
      if (!el) continue;

      if (node.meshGroup && !node.meshGroup.visible) {
        el.style.opacity = '0';
        continue;
      }

      // Declutter rule: Show genre suns, focused node & its neighbors, or top artists
      const isFocused = activeNode && (activeNode.id === node.id || (activeNode.neighbors && activeNode.neighbors.has(node.id)));
      const shouldDisplay =
        node.type === 'genre' ||
        isFocused ||
        node.isWormholeBridge ||
        (node.type === 'artist' && (node.plays || 0) >= 1800 && !activeNode);

      if (!shouldDisplay) {
        el.style.opacity = '0';
        continue;
      }

      tempProjVec.copy(node.position);
      tempProjVec.y += (node.currentRadius || node.baseRadius || 5) * scaleMultiplier + 2.5;
      tempProjVec.project(camera);

      // Frustum check (z > 1.0 means behind the camera)
      if (tempProjVec.z > 1.0 || tempProjVec.z < -1.0) {
        el.style.opacity = '0';
        continue;
      }

      const screenX = tempProjVec.x * halfW + halfW;
      const screenY = -(tempProjVec.y * halfH) + halfH;

      el.style.transform = `translate(-50%, -100%) translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0)`;
      el.style.opacity = isFocused ? '1.0' : (node.type === 'genre' ? '0.92' : '0.72');
      if (isFocused) {
        el.classList.add('focused');
      } else {
        el.classList.remove('focused');
      }
    }
  }
}
