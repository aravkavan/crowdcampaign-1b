// Middleware for protected routes. Rule 2: no token, bad token or expired token -> 401.
import { query } from '../db.js';
import { PUBLIC_USER_COLUMNS } from '../lib/users.js';
import { isUuid } from '../lib/validate.js';
import { verifyToken } from './tokens.js';

const MESSAGES = {
  missing: 'Log in first, then send your token as "Authorization: Bearer <token>".',
  malformed: 'That token is not valid. Log in again to get a new one.',
  signature: 'That token is not valid. Log in again to get a new one.',
  expired: 'Your token has expired. Log in again to get a new one.',
  revoked: 'That token no longer works. Log in again to get a new one.',
};

function reject(res, reason) {
  // RFC 6750: a 401 says which auth scheme is expected and, if one was sent, why it failed.
  const challenge =
    reason === 'missing' ? 'Bearer realm="crowdcampaign"' : 'Bearer realm="crowdcampaign", error="invalid_token"';
  res.set('WWW-Authenticate', challenge);
  return res.status(401).json({ error: MESSAGES[reason] });
}

export async function requireAuth(req, res, next) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '');
  if (!match) return reject(res, 'missing');

  // Everything that can be decided without the database is decided first,
  // so a bad token gets its 401 even if the database is slow or down.
  const result = verifyToken(match[1]);
  if (!result.ok) return reject(res, result.reason);
  const { sub, tv } = result.claims;
  if (!isUuid(sub)) return reject(res, 'malformed');

  // A signed token can outlive its account (deleted) or its password (changed).
  const { rows } = await query(`SELECT ${PUBLIC_USER_COLUMNS}, token_version FROM users WHERE id = $1`, [sub]);
  const user = rows[0];
  if (!user || user.token_version !== tv) return reject(res, 'revoked');

  req.user = user;
  return next();
}
