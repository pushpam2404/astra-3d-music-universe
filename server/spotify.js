// server/spotify.js
/**
 * Spotify Accounts + Web API client (Authorization Code flow with client secret).
 */
import { config } from './config.js';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(status, message, endpoint, retryAfterSec = 0) {
    super(message);
    this.status = status;
    this.endpoint = endpoint;
    this.retryAfterSec = retryAfterSec;
  }
}

// When Spotify rate-limits the app, every further request extends the block. Once it
// asks for more than a short wait, stop calling it at all until the wait is over.
let blockedUntil = 0;

export function buildAuthorizeUrl(state, redirectUri) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: config.scopes,
    state
  });
  return `${ACCOUNTS_BASE}/authorize?${params}`;
}

async function tokenRequest(form) {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const res = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(form)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SpotifyError(res.status, data.error_description || data.error || res.statusText, '/api/token');
  }
  return {
    accessToken: data.access_token,
    // Spotify only sometimes rotates the refresh token.
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope
  };
}

export function exchangeCode(code, redirectUri) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Returns an API client bound to one user session. onTokensRefreshed(session) is
 * called with the updated session whenever the access token is refreshed.
 */
export function createApi(session, onTokensRefreshed) {
  async function getValidAccessToken() {
    if (Date.now() < session.expiresAt - 60_000) return session.accessToken;
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
    session = {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken || session.refreshToken,
      expiresAt: fresh.expiresAt,
      scope: fresh.scope || session.scope
    };
    onTokensRefreshed(session);
    return session.accessToken;
  }

  async function get(endpoint, attempt = 0) {
    const waitSec = Math.ceil((blockedUntil - Date.now()) / 1000);
    if (waitSec > 0) throw new SpotifyError(429, 'Too many requests', endpoint, waitSec);
    const token = await getValidAccessToken();
    const res = await fetch(`${API_BASE}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get('Retry-After') || 1);
      if (retryAfterSec <= 10 && attempt < 2) {
        await sleep(retryAfterSec * 1000);
        return get(endpoint, attempt + 1);
      }
      blockedUntil = Math.max(blockedUntil, Date.now() + retryAfterSec * 1000);
      throw new SpotifyError(429, 'Too many requests', endpoint, retryAfterSec);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new SpotifyError(res.status, body.error?.message || res.statusText, endpoint);
    }
    return res.json();
  }
  return { get };
}
