// src/etl/timeMachine4D.js
/**
 * 4D Temporal Scrubber & Continuous-Time Exponential Half-Life Engine (Blueprint 09)
 * Calculates dynamic star mass and cooling orbital drift as a function of time.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export class TemporalUniverseScrubber {
  constructor(rawEvents = [], halfLifeDays = 90) {
    this.lambda = Math.LN2 / (halfLifeDays * MS_PER_DAY);
    this.eventsByEntity = new Map();
    this.minTimestamp = Infinity;
    this.maxTimestamp = -Infinity;

    if (rawEvents.length > 0) {
      this.indexTimestampedEvents(rawEvents);
    } else {
      this.generateSyntheticTimeline();
    }
  }

  indexTimestampedEvents(records) {
    for (const row of records) {
      const timestamp = row.timestamp || new Date(row.ts || row.endTime).getTime();
      const artist = row.artist || row.artistName || row.master_metadata_album_artist_name;
      if (!timestamp || !artist || isNaN(timestamp)) continue;

      this.minTimestamp = Math.min(this.minTimestamp, timestamp);
      this.maxTimestamp = Math.max(this.maxTimestamp, timestamp);

      if (!this.eventsByEntity.has(artist.toLowerCase())) {
        this.eventsByEntity.set(artist.toLowerCase(), []);
      }
      this.eventsByEntity.get(artist.toLowerCase()).push(timestamp);
    }
    if (this.minTimestamp === Infinity) {
      this.generateSyntheticTimeline();
    }
  }

  generateSyntheticTimeline() {
    // Generate a realistic 2-year timeline for demo galaxies
    const now = Date.now();
    this.minTimestamp = now - 730 * MS_PER_DAY;
    this.maxTimestamp = now;
  }

  /**
   * Evaluates all node weights, radii, and orbital distances at normalized progress u in [0, 1].
   */
  evaluateAtProgress(u, nodes) {
    const simTime = this.minTimestamp + u * (this.maxTimestamp - this.minTimestamp);
    let maxWeight = 1.0;

    nodes.forEach(node => {
      if (node.type === 'genre') {
        // Genres remain solid anchor suns
        return;
      }

      const timestamps = this.eventsByEntity.get(node.name?.toLowerCase()) || [];
      let activeWeight = 0;

      if (timestamps.length > 0) {
        for (let i = 0; i < timestamps.length; i++) {
          const dt = simTime - timestamps[i];
          if (dt >= 0) {
            activeWeight += Math.exp(-this.lambda * dt);
          }
        }
      } else {
        // Synthetic progression based on node properties and time
        const nodeHash = ((node.name?.charCodeAt(0) || 65) % 10) / 10;
        const emergenceTime = this.minTimestamp + nodeHash * 0.7 * (this.maxTimestamp - this.minTimestamp);
        if (simTime >= emergenceTime) {
          const ageDays = (simTime - emergenceTime) / MS_PER_DAY;
          const peakAge = 60 + nodeHash * 90;
          const decay = ageDays > peakAge ? Math.exp(-0.005 * (ageDays - peakAge)) : (ageDays / peakAge);
          activeWeight = (node.plays || 100) * 0.05 * Math.max(0.1, decay);
        } else {
          activeWeight = 0;
        }
      }

      node.temporalWeight = activeWeight;
      maxWeight = Math.max(maxWeight, activeWeight);
    });

    const maxLog = Math.log10(maxWeight + 1) || 1;

    nodes.forEach(node => {
      if (node.type === 'genre') return;

      const norm = Math.log10((node.temporalWeight || 0) + 1) / maxLog;
      const isVisible = (node.temporalWeight || 0) > 0.01;

      if (node.meshGroup) {
        node.meshGroup.visible = isVisible;
      }
      if (node.labelEl) {
        node.labelEl.style.display = isVisible ? 'block' : 'none';
      }

      // Dynamic cooling radius & orbital drift
      if (node.type === 'artist') {
        node.currentRadius = 2.4 + norm * 6.5;
        node.idealOrbitDist = 75 - norm * 42;
      } else if (node.type === 'track') {
        node.currentRadius = 1.2 + norm * 2.5;
      }
    });

    return new Date(simTime).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short'
    });
  }
}
