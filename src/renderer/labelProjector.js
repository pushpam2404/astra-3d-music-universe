// src/renderer/labelProjector.js
import * as THREE from 'three';

const tempProjVec = new THREE.Vector3();
const LABEL_PADDING = 4;
// Without focus, each cluster shows its top N artists by name.
const TOP_ARTISTS_PER_CLUSTER = 3;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Projects 3D nodes to HTML labels. Labels are placed greedily by priority and any
 * label that would overlap an already placed one is hidden, so the screen never
 * turns into a pile of text.
 */
export class LabelProjector {
  constructor(containerEl) {
    this.container = containerEl;
    this.labelPool = new Map();
    this.placed = [];
  }

  syncLabels(nodes, onLabelClick) {
    this.container.innerHTML = '';
    this.labelPool.clear();

    nodes.forEach(node => {
      const el = document.createElement('div');
      el.className = `celestial-hud-label label-${node.type}`;
      if (node.isWormholeBridge) el.classList.add('label-wormhole');
      if (node.isBridge) el.classList.add('label-bridge');

      const count = node.type === 'genre' ? `<span class="label-count">${node.neighbors?.size || 0}</span>` : '';
      el.innerHTML = `<span class="label-dot" style="background:${node.color}"></span><span class="label-text">${escapeHtml(node.name)}</span>${count}`;
      el.style.opacity = '0';

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onLabelClick) onLabelClick(node);
      });

      this.container.appendChild(el);
      this.labelPool.set(node.id, el);
      node.labelEl = el;
      node.labelSize = null;
    });
  }

  priorityOf(node, activeNode) {
    if (activeNode) {
      if (node.id === activeNode.id) return 0;
      if (activeNode.neighbors?.has(node.id)) return node.type === 'genre' ? 1 : 2;
      if (node.type === 'genre') return 3;
      return -1;
    }
    if (node.type === 'genre') return 1;
    if (node.isWormholeBridge) return 2;
    if (node.type === 'artist' && (node.labelRank ?? 99) < TOP_ARTISTS_PER_CLUSTER) return 3 + node.labelRank;
    return -1;
  }

  update(nodes, camera, activeNode, scaleMultiplier = 1.0, labelsVisible = true) {
    if (!labelsVisible) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'block';

    const w = window.innerWidth;
    const h = window.innerHeight;
    const candidates = [];

    for (const node of nodes) {
      const el = this.labelPool.get(node.id);
      if (!el) continue;
      const priority = (node.meshGroup && !node.meshGroup.visible) ? -1 : this.priorityOf(node, activeNode);
      if (priority < 0) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        continue;
      }

      tempProjVec.copy(node.position);
      tempProjVec.y += (node.currentRadius || node.baseRadius || 5) * scaleMultiplier + 1.5;
      tempProjVec.project(camera);
      if (tempProjVec.z > 1 || tempProjVec.z < -1 || Math.abs(tempProjVec.x) > 1.1 || Math.abs(tempProjVec.y) > 1.1) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        continue;
      }

      candidates.push({
        node, el, priority,
        x: (tempProjVec.x * 0.5 + 0.5) * w,
        y: (-tempProjVec.y * 0.5 + 0.5) * h,
        depth: tempProjVec.z
      });
    }

    // Highest priority first; among equals, nearer to the camera first.
    candidates.sort((a, b) => a.priority - b.priority || a.depth - b.depth);
    this.placed.length = 0;

    for (const c of candidates) {
      if (!c.node.labelSize) {
        // Measure once; labels don't change size afterwards.
        c.node.labelSize = { w: c.el.offsetWidth || 80, h: c.el.offsetHeight || 22 };
      }
      const { w: lw, h: lh } = c.node.labelSize;
      const rect = { x0: c.x - lw / 2 - LABEL_PADDING, x1: c.x + lw / 2 + LABEL_PADDING, y0: c.y - lh - LABEL_PADDING, y1: c.y + LABEL_PADDING };
      const blocked = c.priority > 0 && this.placed.some(r => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0);
      if (blocked) {
        c.el.style.opacity = '0';
        c.el.style.pointerEvents = 'none';
        continue;
      }
      this.placed.push(rect);

      const focused = activeNode && (c.priority <= 2);
      c.el.style.transform = `translate(-50%, -100%) translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0)`;
      c.el.style.opacity = c.priority === 0 ? '1' : (activeNode && !focused ? '0.45' : (c.node.type === 'genre' ? '0.95' : '0.8'));
      c.el.style.pointerEvents = 'auto';
      c.el.classList.toggle('focused', c.priority === 0);
    }
  }
}
