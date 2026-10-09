// Slows down password guessing (OWASP brute-force defence): after 10 failed logins
// for the same username from the same address, that pair is locked for 15 minutes.
// Kept in memory, which is fine for one server; several servers would share it in Redis.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map(); // key -> { count, resetAt }

export function throttleKey(req, identifier) {
  return `${req.ip}|${identifier.toLowerCase()}`;
}

export function secondsLocked(key, now = Date.now()) {
  const entry = failures.get(key);
  if (!entry) return 0;
  if (now >= entry.resetAt) {
    failures.delete(key);
    return 0;
  }
  return entry.count >= MAX_FAILURES ? Math.ceil((entry.resetAt - now) / 1000) : 0;
}

export function recordFailure(key, now = Date.now()) {
  const entry = failures.get(key);
  if (!entry || now >= entry.resetAt) {
    failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
  if (failures.size > 10_000) {
    for (const [k, value] of failures) if (now >= value.resetAt) failures.delete(k);
  }
}

export function clearFailures(key) {
  failures.delete(key);
}
