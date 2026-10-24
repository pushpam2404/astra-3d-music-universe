// src/api/historyStorage.js
/**
 * Browser-side import, export, and IndexedDB persistence for Spotify Streaming History
 * and compiled Astra Universe snapshots.
 */
import { parseStreamingEvents } from '../etl/historyParser.js';
import { isZipFile, extractZipEntries } from './zipReader.js';

const DB_NAME = 'astra_history_db';
const STORE_NAME = 'kv';
const HISTORY_KEY = 'imported_history_summary_v1';
const SNAPSHOT_KEY = 'imported_universe_snapshot_v1';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbSet(key, val) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore storage errors
  }
}

async function idbDelete(key) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore
  }
}

export async function loadStoredHistorySummary() {
  return idbGet(HISTORY_KEY);
}

export async function saveStoredHistorySummary(summary) {
  if (!summary) return idbDelete(HISTORY_KEY);
  return idbSet(HISTORY_KEY, summary);
}

export async function loadStoredUniverseSnapshot() {
  return idbGet(SNAPSHOT_KEY);
}

export async function saveStoredUniverseSnapshot(snapshot) {
  if (!snapshot) return idbDelete(SNAPSHOT_KEY);
  return idbSet(SNAPSHOT_KEY, snapshot);
}

export async function clearStoredHistory() {
  await Promise.all([idbDelete(HISTORY_KEY), idbDelete(SNAPSHOT_KEY)]);
}

/**
 * Reads selected files (from folder upload, multi-file picker, or drag-and-drop).
 * Recognizes:
 *  - Exported Astra Universe Snapshot JSON (`isAstraUniverseSnapshot: true` or `{ dataset: { genres, artists, tracks } }`)
 *  - Pre-aggregated Astra History Summary JSON (`isAstraHistorySummary: true`)
 *  - Raw Spotify Extended Streaming History (`Streaming_History_Audio_*.json`, `endsong_*.json`)
 *  - Standard Spotify Account Data (`StreamingHistory_music_*.json`, `StreamingHistory*.json`)
 */
const listNames = (names) => (names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and '));

const isAudioJson = (name) => name.toLowerCase().endsWith('.json') && !name.toLowerCase().includes('video');

export async function parseImportedFiles(fileList) {
  const picked = Array.from(fileList || []).filter(Boolean);
  const files = [];
  for (const f of picked) {
    if (isZipFile(f)) files.push(...await extractZipEntries(f, isAudioJson));
    else if (isAudioJson(f.name)) files.push(f);
  }
  if (!files.length) {
    throw new Error('No audio JSON files found in your selection. Choose your Spotify data zip, the unzipped Streaming History folder, or its JSON files.');
  }

  const rawEvents = [];
  const loadedFileNames = [];
  const unreadable = [];
  const empty = [];

  for (const file of files) {
    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      unreadable.push(file.name);
      continue;
    }

    // 1. Check if it's a full exported Astra Universe Snapshot
    if (parsed && (parsed.isAstraUniverseSnapshot || (parsed.dataset?.genres && parsed.dataset?.artists && parsed.dataset?.tracks))) {
      return {
        kind: 'snapshot',
        snapshot: parsed,
        dataset: parsed.dataset,
        artistMeta: parsed.artistMeta || {},
        historySummary: parsed.historySummary || null,
        fileNames: [file.name]
      };
    }

    // 2. Check if it's a pre-parsed Astra History Summary
    if (parsed && parsed.isAstraHistorySummary && Array.isArray(parsed.artists)) {
      return {
        kind: 'history',
        historySummary: parsed,
        fileNames: [file.name]
      };
    }

    // 3. Raw array of Spotify streaming history events
    if (Array.isArray(parsed) && parsed.length) {
      for (let i = 0; i < parsed.length; i++) rawEvents.push(parsed[i]);
      loadedFileNames.push(file.name);
    } else {
      empty.push(file.name);
    }
  }

  if (!rawEvents.length) {
    const reasons = [
      unreadable.length && `${listNames(unreadable)} ${unreadable.length === 1 ? 'isn’t' : 'aren’t'} valid JSON`,
      empty.length && `${listNames(empty)} ${empty.length === 1 ? 'has' : 'have'} no listening events`
    ].filter(Boolean);
    throw new Error(`Couldn’t import: ${reasons.join('; ')}. Choose the Streaming_History_Audio files from your Spotify data export.`);
  }

  const historySummary = parseStreamingEvents(rawEvents);
  historySummary.sourceFolder = files.length > 1 ? `Imported (${files.length} files)` : files[0].name;
  historySummary.fileNames = loadedFileNames;

  if (historySummary.validPlays === 0) {
    throw new Error(`No plays of 30 seconds or longer in ${listNames(loadedFileNames)}. Is this a Spotify streaming history file?`);
  }

  return {
    kind: 'history',
    historySummary,
    fileNames: loadedFileNames
  };
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 500);
}

/**
 * Exports the full compiled Astra Universe (clusters, artists, songs, 3D coordinates,
 * temporal history insights, and cached genre metadata) as a portable `.json` file
 * that can be re-imported on any device instantly.
 */
export function exportUniverseSnapshotJson(dataset, artistMeta = {}, historySummary = null) {
  if (!dataset) return;
  const dateStr = new Date().toISOString().slice(0, 10);
  const payload = {
    isAstraUniverseSnapshot: true,
    exportedAt: new Date().toISOString(),
    version: '1.1.0',
    dataset,
    artistMeta,
    historySummary: historySummary ? {
      isAstraHistorySummary: true,
      validPlays: historySummary.validPlays,
      totalHours: historySummary.totalHours,
      firstDate: historySummary.firstDate,
      lastDate: historySummary.lastDate,
      years: historySummary.years,
      sourceFolder: historySummary.sourceFolder
    } : dataset.historyMeta || null
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `astra-universe-${dateStr}.json`);
}

/**
 * Exports a comprehensive CSV spreadsheet of every artist and song in the universe,
 * including cluster, total plays, minutes listened, first & last heard dates,
 * days since last play, peak era, memory status, and year-by-year plays (2020-2026).
 */
export function exportListeningHistoryCsv(dataset) {
  if (!dataset) return;
  const dateStr = new Date().toISOString().slice(0, 10);
  const clusterMap = new Map((dataset.genres || []).map(g => [g.id, g.name]));
  const artistMap = new Map((dataset.artists || []).map(a => [a.id, a]));

  const allYears = new Set();
  (dataset.artists || []).forEach(a => {
    Object.keys(a.history?.byYear || {}).forEach(y => allYears.add(y));
  });
  const years = [...allYears].sort();
  if (!years.length) ['2020', '2021', '2022', '2023', '2024', '2025', '2026'].forEach(y => allYears.add(y));
  const sortedYears = [...allYears].sort();

  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const headers = [
    'Type',
    'Name',
    'Primary Artist',
    'Cluster',
    'Memory Status',
    'Peak Era',
    'History Plays',
    'Minutes Listened',
    'First Heard',
    'Last Heard',
    'Days Since Last Heard',
    'Liked Song',
    'Top Chart Ranks',
    ...sortedYears.map(y => `Plays ${y}`),
    'Memory Note',
    'Spotify URL'
  ];

  const rows = [headers.map(esc).join(',')];

  // 1. Artists
  (dataset.artists || [])
    .slice()
    .sort((a, b) => (b.history?.plays || b.basePlays || 0) - (a.history?.plays || a.basePlays || 0))
    .forEach(a => {
      const h = a.history || {};
      const clusterName = clusterMap.get(a.genres?.[0]) || '';
      const ranksStr = Object.entries(a.ranks || {}).map(([k, v]) => `${k}:#${v}`).join(' ');
      const row = [
        'Artist',
        a.name,
        a.name,
        clusterName,
        h.statusLabel || (Object.keys(a.ranks || {}).length ? 'Top Chart Artist' : ''),
        h.peakEra || '',
        h.plays ?? '',
        h.minutes ?? '',
        h.firstPlayed || '',
        h.lastPlayed || '',
        h.daysSinceLast ?? '',
        '',
        ranksStr,
        ...sortedYears.map(y => h.byYear?.[y] || 0),
        h.memoryNote || '',
        a.spotifyUrl || ''
      ];
      rows.push(row.map(esc).join(','));
    });

  // 2. Songs
  (dataset.tracks || [])
    .slice()
    .sort((a, b) => (b.history?.plays || b.basePlays || 0) - (a.history?.plays || a.basePlays || 0))
    .forEach(t => {
      const h = t.history || {};
      const parentArtist = artistMap.get(t.artistId);
      const clusterName = clusterMap.get(parentArtist?.genres?.[0]) || '';
      const ranksStr = Object.entries(t.ranks || {}).map(([k, v]) => `${k}:#${v}`).join(' ');
      const row = [
        'Song',
        t.name,
        t.artistName || parentArtist?.name || '',
        clusterName,
        h.statusLabel || (t.liked ? 'Liked Song' : ''),
        h.peakEra || '',
        h.plays ?? '',
        h.minutes ?? '',
        h.firstPlayed || '',
        h.lastPlayed || '',
        h.daysSinceLast ?? '',
        t.liked ? 'Yes' : 'No',
        ranksStr,
        ...sortedYears.map(y => h.byYear?.[y] || 0),
        h.memoryNote || '',
        t.spotifyUrl || ''
      ];
      rows.push(row.map(esc).join(','));
    });

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, `astra-listening-history-${dateStr}.csv`);
}
