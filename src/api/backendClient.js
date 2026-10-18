// src/api/backendClient.js
/**
 * Thin client for the ASTRA backend (server/). Spotify tokens never reach the browser.
 */

export const SPOTIFY_LOGIN_URL = '/api/auth/login';

async function requestJson(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function getAuthStatus() {
  try {
    return await requestJson('/api/auth/status');
  } catch {
    // Backend not running (e.g. plain `vite` dev server); presets still work.
    return { configured: false, loggedIn: false, backendUnavailable: true };
  }
}

export async function getHistoryStatus() {
  try {
    return await requestJson('/api/history/status');
  } catch {
    return { available: false };
  }
}

/**
 * Resolves to { dataset, artistMeta, diagnostics }; dataset is null when Spotify has no
 * data yet. knownMeta is what earlier loads learned (see artistMetaCache.js).
 * historySummary is optional browser-imported streaming history.
 */
export function fetchUniverse(knownMeta = {}, { historySummary = null, useLocalHistory = true } = {}) {
  return requestJson('/api/universe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ knownMeta, historySummary, useLocalHistory })
  });
}

/** Looks up genres for up to 50 artists; resolves to { artistMeta, warnings }. */
export function enrichArtists(artists) {
  return requestJson('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artists, allowHistoryEnrich: true })
  });
}

export function logout() {
  return requestJson('/api/auth/logout', { method: 'POST' });
}
