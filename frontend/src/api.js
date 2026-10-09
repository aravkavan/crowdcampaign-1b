// Every call to the backend goes through api(). Requests and responses are JSON, and
// the login token travels in the Authorization header ("Bearer <token>"), not a cookie.
export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/+$/, '');

const TOKEN_KEY = 'crowdcampaign.token';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status; // 0 means the server could not be reached at all
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing can block storage; the session then lasts until reload.
  }
}

let unauthorizedHandler = null;
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, `Can’t reach the server at ${API_URL}. Is the backend running?`);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // A 401 on a request that carried a token means the session is over
    // (expired, password changed elsewhere, or account deleted).
    const isLoginAttempt = path.startsWith('/api/auth/login') || path.startsWith('/api/auth/register');
    if (res.status === 401 && token && !isLoginAttempt) unauthorizedHandler?.();
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status}).`);
  }
  return data;
}
