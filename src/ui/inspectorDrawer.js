// src/ui/inspectorDrawer.js
/**
 * Glassmorphic Telemetry Inspector Drawer (Blueprint 01 & 05)
 * Displays deep physical, graph, and audio DNA metrics for the selected celestial body.
 */

export class InspectorDrawer {
  constructor(drawerEl, synth, cameraController) {
    this.drawerEl = drawerEl;
    this.synth = synth;
    this.cameraController = cameraController;
    this.currentNode = null;
    this.onNodeSelected = null;

    this.canvas = this.drawerEl.querySelector('#fft-visualizer-canvas');
    this.initEventListeners();
  }

  initEventListeners() {
    const closeBtn = this.drawerEl.querySelector('#close-inspector-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }

    const playBtn = this.drawerEl.querySelector('#play-sonic-dna-btn');
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        if (!this.currentNode) return;
        if (this.synth.isPlaying && this.synth.activeNode?.id === this.currentNode.id) {
          this.synth.stop();
          this.updatePlayButton(false);
        } else {
          this.synth.playNodeSignature(this.currentNode);
          this.updatePlayButton(true);
        }
      });
    }

    const flyBtn = this.drawerEl.querySelector('#fly-to-node-btn');
    if (flyBtn) {
      flyBtn.addEventListener('click', () => {
        if (this.currentNode) {
          this.cameraController.flyToNode(this.currentNode);
        }
      });
    }
  }

  open(node) {
    this.currentNode = node;
    this.drawerEl.classList.add('open');

    // Populate metadata
    this.drawerEl.querySelector('#inspector-node-name').textContent = node.name;

    const tierBadge = this.drawerEl.querySelector('#inspector-tier-badge');
    tierBadge.textContent = node.isWormholeBridge
      ? 'LAGRANGE WORMHOLE'
      : (node.type === 'genre' ? 'GALACTIC SUN' : (node.type === 'artist' ? 'PLANETARY BODY' : 'LUNAR SATELLITE'));
    tierBadge.style.borderColor = node.color;
    tierBadge.style.color = node.color;

    this.drawerEl.querySelector('#inspector-plays').textContent = (node.plays || 0).toLocaleString();
    this.drawerEl.querySelector('#inspector-hours').textContent = `${node.hoursListened || '0'} hrs`;
    this.drawerEl.querySelector('#inspector-mass').textContent = node.mass || '1.0';
    this.drawerEl.querySelector('#inspector-gravity-share').textContent = node.gravityShare || '0%';

    // Connected entities
    const connectionsContainer = this.drawerEl.querySelector('#inspector-connections');
    const connectionsTitle = this.drawerEl.querySelector('#inspector-connections-title');
    const subgenresContainer = this.drawerEl.querySelector('#inspector-subgenres');
    const subgenresTitle = this.drawerEl.querySelector('#inspector-subgenres-title');
    connectionsContainer.innerHTML = '';
    subgenresContainer.innerHTML = '';

    const addPill = (container, label, targetNode, color) => {
      const pill = document.createElement('span');
      pill.className = targetNode ? 'connection-pill' : 'connection-pill pill-tag';
      pill.textContent = label;
      if (color) pill.style.borderColor = color;
      if (targetNode) {
        pill.style.cursor = 'pointer';
        pill.addEventListener('click', () => {
          if (this.onNodeSelected) this.onNodeSelected(targetNode);
        });
      }
      container.appendChild(pill);
    };
    const resolve = (id) => (this.resolveNode ? this.resolveNode(id) : null);
    const neighborsOfType = (type) => [...(node.neighbors || [])].map(resolve).filter(n => n && n.type === type);

    if (node.type === 'genre') {
      connectionsTitle.textContent = 'Artists in this cluster';
      neighborsOfType('artist')
        .sort((a, b) => b.plays - a.plays)
        .forEach(a => addPill(connectionsContainer, a.name, a, a.color));
    } else if (node.type === 'artist') {
      connectionsTitle.textContent = node.isBridge ? 'Bridges two clusters' : 'Cluster';
      neighborsOfType('genre').forEach(g => addPill(connectionsContainer, g.name, g, g.color));
      neighborsOfType('track')
        .sort((a, b) => b.plays - a.plays)
        .forEach(t => addPill(connectionsContainer, `♪ ${t.name}`, t));
    } else {
      connectionsTitle.textContent = 'Artists';
      neighborsOfType('artist').forEach(a => addPill(connectionsContainer, a.name, a, a.color));
    }

    const subgenres = node.subgenres || [];
    subgenresTitle.style.display = subgenres.length ? '' : 'none';
    subgenres.forEach(g => addPill(subgenresContainer, g));

    // Audio DNA Meters
    const valence = node.valence ?? 0.65;
    const energy = node.energy ?? 0.75;
    const dance = node.dance ?? 0.60;
    const acoustic = node.acoustic ?? 0.25;
    const bpm = node.bpm || 120;

    this.setMeter('valence', valence, `${Math.round(valence * 100)}% (${valence >= 0.6 ? 'Lydian' : (valence >= 0.45 ? 'Dorian' : 'Aeolian')})`);
    this.setMeter('energy', energy, `${Math.round(energy * 100)}%`);
    this.setMeter('dance', dance, `${Math.round(dance * 100)}%`);
    this.setMeter('acoustic', acoustic, `${Math.round(acoustic * 100)}%`);
    this.drawerEl.querySelector('#val-bpm').textContent = `${bpm} BPM`;

    // Spotify Link
    const spotifyBtn = this.drawerEl.querySelector('#spotify-open-btn');
    if (node.spotifyUrl) {
      spotifyBtn.href = node.spotifyUrl;
      spotifyBtn.style.display = 'inline-flex';
    } else {
      spotifyBtn.style.display = 'none';
    }

    const isPlayingCurrent = this.synth.isPlaying && this.synth.activeNode?.id === node.id;
    this.updatePlayButton(isPlayingCurrent);
  }

  setMeter(name, value, labelText) {
    const bar = this.drawerEl.querySelector(`#bar-${name}`);
    const text = this.drawerEl.querySelector(`#val-${name}`);
    if (bar) bar.style.width = `${Math.round(value * 100)}%`;
    if (text) text.textContent = labelText;
  }

  updatePlayButton(isPlaying) {
    const playBtn = this.drawerEl.querySelector('#play-sonic-dna-btn');
    if (!playBtn) return;
    const icon = playBtn.querySelector('.btn-icon');
    const label = playBtn.querySelector('.btn-text');
    if (isPlaying) {
      icon.innerHTML = '&#9632;'; // Stop square
      label.textContent = 'Halt Sonic DNA';
      playBtn.classList.add('active');
    } else {
      icon.innerHTML = '&#9658;'; // Play triangle
      label.textContent = 'Synthesize Sonic DNA';
      playBtn.classList.remove('active');
    }
  }

  close() {
    this.drawerEl.classList.remove('open');
    this.currentNode = null;
  }

  renderSpectrum() {
    if (this.drawerEl.classList.contains('open') && this.canvas) {
      this.synth.renderVisualizer(this.canvas);
    }
  }
}
