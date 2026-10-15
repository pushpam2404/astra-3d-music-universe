// src/renderer/labelProjector.js
import * as THREE from 'three';

const tempProjVec = new THREE.Vector3();
const LABEL_PADDING = 4;
// Without focus, each cluster shows its top N artists by name.
const TOP_ARTISTS_PER_CLUSTER = 3;
const TOP_ARTISTS_OVERALL = 12;

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
    this.shown = new Set();
  }

  syncLabels(nodes, onLabelClick) {
    this.container.innerHTML = '';
    this.labelPool.clear();
    this.onLabelClick = onLabelClick;
    this.shown = new Set();
    // Labels are created lazily, the first time a node is a label candidate: a big
    // library has thousands of artists and songs, and only a few dozen are ever named.
    nodes.forEach(node => {
      node.labelEl = null;
      node.labelSize = null;
    });
  }

  ensureLabel(node) {
    let el = this.labelPool.get(node.id);
    if (el) return el;
    el = document.createElement('div');
    el.className = `celestial-hud-label label-${node.type}`;
    if (node.type === 'artist' && (node.globalRank ?? 99) < TOP_ARTISTS_OVERALL) el.classList.add('label-favourite');
    if (node.isWormholeBridge) el.classList.add('label-wormhole');
    if (node.isBridge) el.classList.add('label-bridge');

    const count = node.type === 'genre' ? `<span class="label-count">${node.neighbors?.size || 0}</span>` : '';
    el.innerHTML = `<span class="label-dot" style="background:${node.color}"></span><span class="label-text">${escapeHtml(node.name)}</span>${count}`;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    el._shown = false;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onLabelClick) this.onLabelClick(node);
    });

    this.container.appendChild(el);
    this.labelPool.set(node.id, el);
    node.labelEl = el;
    return el;
  }

  /** Writes to the DOM only when something changed. */
  hide(el) {
    if (!el || !el._shown) return;
    el._shown = false;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
  }

  show(el, transform, opacity, focused) {
    if (el._transform !== transform) {
      el._transform = transform;
      el.style.transform = transform;
    }
    if (!el._shown || el._opacity !== opacity) {
      el._opacity = opacity;
      el.style.opacity = opacity;
    }
    if (!el._shown) el.style.pointerEvents = 'auto';
    el._shown = true;
    if (el._focused !== focused) {
      el._focused = focused;
      el.classList.toggle('focused', focused);
    }
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
    if (node.type === 'artist') {
      // Your overall favourites are always named; then each cluster's top few.
      if ((node.globalRank ?? 99) < TOP_ARTISTS_OVERALL) return 2;
      if ((node.labelRank ?? 99) < TOP_ARTISTS_PER_CLUSTER) return 3 + node.labelRank;
    }
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
      const priority = (node.meshGroup && !node.meshGroup.visible) ? -1 : this.priorityOf(node, activeNode);
      if (priority < 0) continue;

      tempProjVec.copy(node.position);
      tempProjVec.y += (node.currentRadius || node.baseRadius || 5) * scaleMultiplier + 1.5;
      tempProjVec.project(camera);
      if (tempProjVec.z > 1 || tempProjVec.z < -1 || Math.abs(tempProjVec.x) > 1.1 || Math.abs(tempProjVec.y) > 1.1) continue;

      candidates.push({
        node, el: this.ensureLabel(node), priority,
        x: (tempProjVec.x * 0.5 + 0.5) * w,
        y: (-tempProjVec.y * 0.5 + 0.5) * h,
        depth: tempProjVec.z
      });
    }

    // Highest priority first; among equals, nearer to the camera first.
    candidates.sort((a, b) => a.priority - b.priority || a.depth - b.depth);
    this.placed.length = 0;
    const shownNow = new Set();

    for (const c of candidates) {
      if (!c.node.labelSize) {
        // Measure once; labels don't change size afterwards.
        c.node.labelSize = { w: c.el.offsetWidth || 80, h: c.el.offsetHeight || 22 };
      }
      const { w: lw, h: lh } = c.node.labelSize;
      // Preferred spot is above the body; if taken, try below, right, then left.
      const spots = [[0, 0], [0, lh + 16], [lw / 2 + 14, lh / 2 + 8], [-(lw / 2 + 14), lh / 2 + 8]];
      let placedAt = null;
      for (const [dx, dy] of spots) {
        const x = c.x + dx;
        const y = c.y + dy;
        const rect = { x0: x - lw / 2 - LABEL_PADDING, x1: x + lw / 2 + LABEL_PADDING, y0: y - lh - LABEL_PADDING, y1: y + LABEL_PADDING };
        const blocked = c.priority > 0 && this.placed.some(r => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0);
        if (!blocked) {
          placedAt = { x, y, rect };
          break;
        }
      }
      if (!placedAt) continue;
      this.placed.push(placedAt.rect);
      c.x = placedAt.x;
      c.y = placedAt.y;

      const focused = activeNode && (c.priority <= 2);
      const opacity = c.priority === 0 ? '1' : (activeNode && !focused ? '0.45' : (c.node.type === 'genre' ? '0.95' : '0.8'));
      this.show(c.el, `translate(-50%, -100%) translate3d(${c.x.toFixed(0)}px, ${c.y.toFixed(0)}px, 0)`, opacity, c.priority === 0);
      shownNow.add(c.el);
    }
    // Hide only what was shown last frame and isn't now (no per-node DOM work).
    this.shown.forEach(el => { if (!shownNow.has(el)) this.hide(el); });
    this.shown = shownNow;
  }
}
