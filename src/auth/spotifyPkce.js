// src/auth/spotifyPkce.js
/**
 * Spotify OAuth 2.0 PKCE (Proof Key for Code Exchange) Module
 * Allows zero-backend client-side authentication without exposing secrets.
 */

const DEFAULT_SPOTIFY_CLIENT_ID = 'YOUR_SPOTIFY_CLIENT_ID';
const SCOPES = [
  'user-top-read',
  'user-read-recently-played',
  'playlist-modify-public',
  'playlist-modify-private'
].join(' ');

export function getSpotifyClientId() {
  return localStorage.getItem('astra_spotify_client_id') ||
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SPOTIFY_CLIENT_ID) ||
    DEFAULT_SPOTIFY_CLIENT_ID;
}

export function setSpotifyClientId(clientId) {
  if (clientId && clientId.trim()) {
    localStorage.setItem('astra_spotify_client_id', clientId.trim());
  } else {
    localStorage.removeItem('astra_spotify_client_id');
  }
}

export function getRedirectUri() {
  let uri = window.location.origin + window.location.pathname;
  if (!uri.endsWith('/')) uri += '/';
  return uri;
}

function generateRandomString(len = 64) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const randomValues = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(randomValues)
    .map(byte => charset[byte % charset.length])
    .join('');
}

async function computeCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digestBuffer = await crypto.subtle.digest('SHA-256', data);

  return btoa(String.fromCharCode(...new Uint8Array(digestBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function redirectToSpotifyLogin() {
  const clientId = getSpotifyClientId();
  if (!clientId || clientId === 'YOUR_SPOTIFY_CLIENT_ID') {
    throw new Error('Please enter a valid Spotify Client ID in settings.');
  }

  const codeVerifier = generateRandomString(64);
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const redirectUri = getRedirectUri();

  localStorage.setItem('astra_pkce_verifier', codeVerifier);
  localStorage.setItem('astra_pkce_redirect_uri', redirectUri);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function handleSpotifyCallbackIfPresent() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (!code) return null;

  const clientId = getSpotifyClientId();
  const codeVerifier = localStorage.getItem('astra_pkce_verifier');
  const redirectUri = localStorage.getItem('astra_pkce_redirect_uri') || getRedirectUri();
  if (!codeVerifier) {
    console.warn('Missing PKCE code_verifier in localStorage.');
    return null;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(`Token exchange failed: ${errData.error_description || response.statusText}`);
    }

    const tokenData = await response.json();
    const expiresAt = Date.now() + tokenData.expires_in * 1000;

    localStorage.setItem('astra_access_token', tokenData.access_token);
    if (tokenData.refresh_token) {
      localStorage.setItem('astra_refresh_token', tokenData.refresh_token);
    }
    localStorage.setItem('astra_token_expires_at', String(expiresAt));

    // Clean URL query parameters
    window.history.replaceState({}, document.title, window.location.pathname);
    return tokenData.access_token;
  } catch (err) {
    console.error('Error during token exchange:', err);
    throw err;
  }
}

export function getStoredAccessToken() {
  const token = localStorage.getItem('astra_access_token');
  const expiresAt = Number(localStorage.getItem('astra_token_expires_at') || 0);

  if (!token) return null;
  if (Date.now() > expiresAt - 60000) {
    // Token expired or expiring in under 1 minute
    return null;
  }
  return token;
}

export function logoutSpotify() {
  localStorage.removeItem('astra_access_token');
  localStorage.removeItem('astra_refresh_token');
  localStorage.removeItem('astra_token_expires_at');
  localStorage.removeItem('astra_pkce_verifier');
}
