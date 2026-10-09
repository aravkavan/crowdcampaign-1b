// Shared HTTP helper for AI providers: JSON in, JSON out, with a timeout and
// short, readable error messages (never the API key).
import { config } from '../../config.js';

export class AiError extends Error {
  constructor(message, { retryable = false, retryAfterMs } = {}) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function postJson(name, url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new AiError(timedOut ? `${name} took too long to answer` : `couldn’t reach ${name}`, { retryable: !timedOut });
  }

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // Some errors come back as HTML or plain text.
  }

  if (!res.ok) {
    const detail = data?.error?.message ?? (Array.isArray(data) ? data[0]?.error?.message : undefined);
    const hint =
      res.status === 401 || res.status === 403
        ? 'the API key was rejected'
        : res.status === 404
          ? 'the model name was not found'
          : res.status === 429
            ? 'rate limit or quota reached'
            : `HTTP ${res.status}`;
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new AiError(`${name}: ${hint}${detail ? ` (${String(detail).slice(0, 160)})` : ''}`, {
      retryable: res.status === 429 || res.status >= 500,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    });
  }
  return data;
}
