// Login tokens are standard JSON Web Tokens: header.payload.signature, signed with
// HMAC-SHA256. They're built on Node's crypto module so every step is visible here.
import crypto from 'node:crypto';
import { config } from '../config.js';

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', config.jwtSecret).update(data).digest();
}

export function signPayload(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const unsigned = `${HEADER}.${payload}`;
  return `${unsigned}.${sign(unsigned).toString('base64url')}`;
}

export function createToken(user) {
  const now = Math.floor(Date.now() / 1000);
  return signPayload({
    sub: user.id, // whose token this is
    tv: user.token_version, // must match the database; bumped on password change
    iat: now, // issued at
    exp: now + config.tokenTtlSeconds, // expires at
  });
}

// Returns { ok: true, claims } or { ok: false, reason: 'malformed' | 'signature' | 'expired' }.
export function verifyToken(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts.some((part) => !part)) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts;

  // 1. Check the signature before trusting anything inside the token.
  const expected = sign(`${header}.${payload}`);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature' };
  }

  // 2. Only accept HS256. This blocks the classic "alg": "none" trick.
  let head;
  let claims;
  try {
    head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (head?.alg !== 'HS256' || !claims || typeof claims.sub !== 'string' || !Number.isInteger(claims.tv)) {
    return { ok: false, reason: 'malformed' };
  }

  // 3. Reject expired tokens.
  if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims };
}
