// src/renderer/labelProjector.js
import * as THREE from 'three';
import { nodeMatchesLens } from './celestialFactory.js';
import { escapeHtml, safeColor } from '../ui/escapeHtml.js';

const tempProjVec = new THREE.Vector3();
const LABEL_PADDING = 4;
const TOP_ARTISTS_PER_CLUSTER = 3;
const TOP_ARTISTS_OVERALL = 14;

/**
 * Projects 3D nodes to HTML labels. Labels are placed greedily by priority and any
 * label that would overlap an already placed one is hidden, so the screen never
 * turns into a pile of text.
 *
 * Guarantees that labels are NEVER shown for dimmed/unlit/culled nodes (`focusTarget < 0.65`
 * or `lensScale <= 0.01`), and when a Time & Memory Lens is active, only nodes that
 * match the lens are labeled.
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

    const leadIcon = node.type === 'track'
      ? `<span class="label-song-icon" style="color:${safeColor(node.color)}">◆ ♪</span>`
      : `<span class="label-dot" style="background:${safeColor(node.color)}"></span>`;

    const roleBadges = node.type === 'artist'
      ? `<span class="label-primary-badge">PRIMARY</span><span class="label-collab-badge">COLLAB</span>`
      : '';

    const count = node.type === 'genre'
      ? `<span class="label-count">${node.neighbors?.size || 0}</span>`
      : (node.history?.shortBadge ? `<span class="label-era">${escapeHtml(node.history.shortBadge)}</span>` : '');

    el.innerHTML = `${leadIcon}${roleBadges}<span class="label-text">${escapeHtml(node.name)}</span>${count}`;
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

  hide(el) {
    if (!el || !el._shown) return;
    el._shown = false;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
  }

  show(el, transform, opacity, isMainFocused, isPrimaryArtist, isCollab, showBadge) {
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
    if (el._focused !== isMainFocused) {
      el._focused = isMainFocused;
      el.classList.toggle('focused', isMainFocused);
    }
    if (el._isPrimary !== isPrimaryArtist) {
      el._isPrimary = isPrimaryArtist;
      el.classList.toggle('is-primary-artist', Boolean(isPrimaryArtist));
    }
    if (el._isCollab !== isCollab) {
      el._isCollab = isCollab;
      el.classList.toggle('is-collab', Boolean(isCollab));
    }
    if (el._showBadge !== showBadge) {
      el._showBadge = showBadge;
      el.classList.toggle('with-badge', Boolean(showBadge));
    }
  }

  priorityOf(node, selectedNode, hoveredNode = null, activeLens = 'all') {
    if (hoveredNode && node.id === hoveredNode.id) return 0;

    // Never label a dimmed/unlit/culled planet or moon
    if (node.type !== 'genre' && ((node.focusTarget ?? 1) < 0.65 || (node.lensScale ?? 1) <= 0.01)) {
      return -1;
    }

    const hasLens = Boolean(activeLens && activeLens !== 'all');
    const matchesLens = hasLens ? nodeMatchesLens(node, activeLens) : true;

    if (selectedNode) {
      if (node.id === selectedNode.id) return 0;

      // Artist Focus Mode: show selected artist + collaborators + songs
      if (selectedNode.type === 'artist') {
        if (node.type === 'genre') return -1;
        if (node.type === 'artist' && selectedNode.collaboratorArtistIds?.has(node.id)) {
          return 1;
        }
        if (node.type === 'track' && selectedNode.neighbors?.has(node.id)) {
          if (selectedNode.collabTrackIds?.has(node.id) || node.featArtistIds?.length) return 1.4;
          if (hasLens && matchesLens) return 1.6;
          return 2.0;
        }
        return -1;
      }

      // Song Focus Mode: show song, primary artist, and collaborating artists
      if (selectedNode.type === 'track') {
        if (node.type === 'genre') return -1;
        if (node.type === 'artist' && selectedNode.neighbors?.has(node.id)) return 1;
        return -1;
      }

      // Cluster Focus Mode: strictly enforce lens filter if active
      if (selectedNode.neighbors?.has(node.id)) {
        if (node.type === 'genre') return 1;
        if (hasLens) {
          return matchesLens ? (node.type === 'artist' ? 1.5 : 2.2) : -1;
        }
        return node.type === 'artist' ? 2 : 2.5;
      }
      if (selectedNode.type === 'genre' && node.type === 'track' && node.connectedGenres?.includes(selectedNode.name)) {
        if (hasLens) {
          return (matchesLens && (node.normScore ?? 0) > 0.35) ? 2.6 : -1;
        }
        if ((node.focusTarget ?? 1) >= 0.65 && (node.normScore ?? 0) > 0.72) return 3.2;
      }
      return -1;
    }

    if (hoveredNode) {
      if (hoveredNode.type === 'track' && node.type === 'artist' && hoveredNode.neighbors?.has(node.id)) {
        return 0.5;
      }
      if (hoveredNode.type === 'artist' && node.type === 'artist' && hoveredNode.collaboratorArtistIds?.has(node.id)) {
        return 0.8;
      }
    }

    if (hasLens) {
      if (node.type === 'genre') return 1.2;
      if (!matchesLens) return -1;
      if (node.type === 'artist') {
        if ((node.globalRank ?? 999) < 40 || (node.normScore ?? 0) > 0.45) return 1.6;
        return 2.2;
      }
      // Track satellites revolve rapidly; only label them in lens mode when explicitly hovered or selected
      if (node.type === 'track') {
        if (hoveredNode && node.id === hoveredNode.id) return 0.2;
        return -1;
      }
      return -1;
    }

    if (node.type === 'genre') return 1;
    if (node.isWormholeBridge) return 2;
    if (node.type === 'artist') {
      if ((node.globalRank ?? 99) < TOP_ARTISTS_OVERALL) return 2;
      if ((node.labelRank ?? 99) < TOP_ARTISTS_PER_CLUSTER) return 3 + node.labelRank;
    }
    return -1;
  }

  update(nodes, camera, selectedNode, scaleMultiplier = 1.0, labelsVisible = true, activeLens = 'all', hoveredNode = null) {
    if (!labelsVisible) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'block';

    const w = window.innerWidth;
    const h = window.innerHeight;
    const candidates = [];
    const hasLens = Boolean(activeLens && activeLens !== 'all');
    const activeNode = selectedNode;

    for (const node of nodes) {
      if (node.meshGroup && !node.meshGroup.visible) continue;
      const isHovered = Boolean(hoveredNode && node.id === hoveredNode.id);
      if (!isHovered && node.type !== 'genre' && ((node.focusTarget ?? 1) < 0.65 || (node.lensScale ?? 1) <= 0.01)) continue;
      if (!isHovered && (node.focusLevel ?? 1) < 0.15) continue;
      const priority = this.priorityOf(node, selectedNode, hoveredNode, activeLens);
      if (priority < 0) continue;

      tempProjVec.copy(node.position);
      tempProjVec.y += (node.currentRadius || node.baseRadius || 5) * (node.lensScale || 1) * scaleMultiplier + 1.5;
      tempProjVec.project(camera);
      if (tempProjVec.z > 1 || tempProjVec.z < -1 || Math.abs(tempProjVec.x) > 1.1 || Math.abs(tempProjVec.y) > 1.1) continue;

      candidates.push({
        node,
        el: this.ensureLabel(node),
        priority,
        x: (tempProjVec.x * 0.5 + 0.5) * w,
        y: (-tempProjVec.y * 0.5 + 0.5) * h,
        depth: tempProjVec.z
      });
    }

    // Deterministic priority ordering with hysteresis:
    // 1. Hovered / focused items win immediately
    // 2. Previously placed incumbent labels get a stability bonus to stop flicker
    // 3. Canonical importance (plays/score), then unique ID (NEVER camera depth!)
    candidates.sort((a, b) => {
      if (Math.abs(a.priority - b.priority) > 0.01) return a.priority - b.priority;
      const aShown = this.shown.has(a.el) ? 1 : 0;
      const bShown = this.shown.has(b.el) ? 1 : 0;
      if (aShown !== bShown) return bShown - aShown;
      const aScore = (a.node.history?.plays ?? 0) || ((a.node.normScore ?? 0) * 100);
      const bScore = (b.node.history?.plays ?? 0) || ((b.node.normScore ?? 0) * 100);
      if (bScore !== aScore) return bScore - aScore;
      return String(a.node.id).localeCompare(String(b.node.id));
    });

    this.placed.length = 0;
    const shownNow = new Set();

    for (const c of candidates) {
      const isPrimaryArtist = Boolean(
        (activeNode?.type === 'artist' && c.node.id === activeNode.id) ||
        (activeNode?.type === 'track' && c.node.type === 'artist' && c.node.id === activeNode.artistId)
      );
      const isCollab = Boolean(
        (activeNode?.type === 'artist' && c.node.type === 'artist' && c.node.id !== activeNode.id) ||
        (activeNode?.type === 'track' && c.node.type === 'artist' && c.node.id !== activeNode.artistId)
      );
      const showBadge = hasLens || (activeNode && c.priority <= 2.8) || (hoveredNode && c.priority <= 0.8);
      if (
        !c.node.labelSize ||
        c.node._measuredBadge !== showBadge ||
        c.node._measuredCollab !== isCollab ||
        c.node._measuredPrimary !== isPrimaryArtist
      ) {
        c.el.classList.toggle('with-badge', Boolean(showBadge));
        c.el.classList.toggle('is-collab', isCollab);
        c.el.classList.toggle('is-primary-artist', isPrimaryArtist);
        c.node.labelSize = { w: c.el.offsetWidth || 96, h: c.el.offsetHeight || 22 };
        c.node._measuredBadge = showBadge;
        c.node._measuredCollab = isCollab;
        c.node._measuredPrimary = isPrimaryArtist;
      }
      const { w: lw, h: lh } = c.node.labelSize;
      
      // Fixed physical anchor: rigidly anchored right over the node without hopping across 4 offsets
      const x = c.x;
      const y = c.y;
      const rect = { x0: x - lw / 2 - LABEL_PADDING, x1: x + lw / 2 + LABEL_PADDING, y0: y - lh - LABEL_PADDING, y1: y + LABEL_PADDING };
      const blocked = c.priority > 0 && this.placed.some(r => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0);
      if (blocked) continue;

      this.placed.push(rect);

      const focused = (activeNode && c.priority <= 2.5) || (hoveredNode && c.priority <= 0.8);
      const opacity = c.priority === 0 ? '1' : (activeNode && !focused ? '0.45' : (c.node.type === 'genre' ? '0.96' : '0.94'));
      this.show(
        c.el,
        `translate(-50%, -100%) translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`,
        opacity,
        c.priority === 0,
        isPrimaryArtist,
        isCollab,
        showBadge
      );
      shownNow.add(c.el);
    }
    this.shown.forEach(el => { if (!shownNow.has(el)) this.hide(el); });
    this.shown = shownNow;
  }
}
