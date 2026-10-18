// server/historyLoader.js
/**
 * Detects and parses local Spotify Streaming History JSON files placed inside the project
 * directory (e.g., `/Users/pushpam/Desktop/spotify/Spotify Extended Streaming History`).
 * Caches the parsed summary in memory so reloads are instant.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.js';
import { parseStreamingEvents } from '../src/etl/historyParser.js';

const HISTORY_DIR_CANDIDATES = [
  'Spotify Extended Streaming History',
  'Spotify Account Data',
  'MyData',
  'history',
  'streaming_history'
];

const HISTORY_FILE_PATTERN = /^(?:Streaming_History_Audio_.*|StreamingHistory_music_.*|StreamingHistory\d+|endsong_.*)\.json$/i;

let cachedLocalHistory = null;
let cachedMtimeKey = null;

function findHistoryFiles() {
  const found = [];

  // 1. Check known candidate folders in ROOT_DIR
  for (const dirName of HISTORY_DIR_CANDIDATES) {
    const dirPath = path.join(ROOT_DIR, dirName);
    try {
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        const entries = fs.readdirSync(dirPath);
        for (const name of entries) {
          if (HISTORY_FILE_PATTERN.test(name)) {
            found.push({ folder: dirName, name, fullPath: path.join(dirPath, name) });
          }
        }
      }
    } catch {
      // Ignore inaccessible directories
    }
  }

  // 2. Also check top-level ROOT_DIR if user dropped JSON files directly
  if (found.length === 0) {
    try {
      const entries = fs.readdirSync(ROOT_DIR);
      for (const name of entries) {
        if (HISTORY_FILE_PATTERN.test(name)) {
          found.push({ folder: '.', name, fullPath: path.join(ROOT_DIR, name) });
        }
      }
    } catch {
      // Ignore
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function getLocalHistorySummary() {
  const files = findHistoryFiles();
  if (files.length === 0) return null;

  const mtimeKey = files.map(f => {
    try {
      const st = fs.statSync(f.fullPath);
      return `${f.name}:${st.size}:${st.mtimeMs}`;
    } catch {
      return f.name;
    }
  }).join('|');

  if (cachedLocalHistory && cachedMtimeKey === mtimeKey) {
    return cachedLocalHistory;
  }

  const allEvents = [];
  const loadedFiles = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(f.fullPath, 'utf8'));
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i++) allEvents.push(raw[i]);
        loadedFiles.push(f.name);
      }
    } catch (err) {
      console.warn(`[historyLoader] Failed to parse ${f.name}:`, err.message);
    }
  }

  if (allEvents.length === 0) return null;

  const summary = parseStreamingEvents(allEvents);
  summary.sourceFolder = files[0].folder;
  summary.fileNames = loadedFiles;
  cachedLocalHistory = summary;
  cachedMtimeKey = mtimeKey;
  console.log(`[historyLoader] Loaded ${summary.validPlays.toLocaleString()} plays (${summary.artists.length} artists, ${summary.tracks.length} tracks) from ${loadedFiles.length} files in "${summary.sourceFolder}".`);
  return summary;
}

export function getLocalHistoryStatus() {
  const summary = getLocalHistorySummary();
  if (!summary) return { available: false };
  return {
    available: true,
    sourceFolder: summary.sourceFolder,
    fileCount: summary.fileNames?.length || 0,
    fileNames: summary.fileNames || [],
    totalEvents: summary.totalEvents,
    validPlays: summary.validPlays,
    totalHours: summary.totalHours,
    firstDate: summary.firstDate,
    lastDate: summary.lastDate,
    years: summary.years,
    artistCount: summary.artists.length,
    trackCount: summary.tracks.length
  };
}
