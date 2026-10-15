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

/** Resolves to { dataset, diagnostics }; dataset is null when Spotify has no data for the range. */
export function fetchUniverse(timeRange) {
  return requestJson(`/api/universe?time_range=${encodeURIComponent(timeRange)}`);
}

export function logout() {
  return requestJson('/api/auth/logout', { method: 'POST' });
}
