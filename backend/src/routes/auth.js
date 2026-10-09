// POST /api/auth/register, POST /api/auth/login, GET /api/auth/me
import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { clearFailures, recordFailure, secondsLocked, throttleKey } from '../auth/loginThrottle.js';
import { hashPassword, needsRehash, spendVerifyTime, verifyPassword } from '../auth/passwords.js';
import { requireAuth } from '../auth/requireAuth.js';
import { createToken } from '../auth/tokens.js';
import { HttpError, bodyOf } from '../lib/http.js';
import { PUBLIC_USER_COLUMNS, publicUser } from '../lib/users.js';
import { emailProblem, passwordProblem, text, usernameProblem } from '../lib/validate.js';

export const authRouter = Router();

function duplicateMessage(constraint) {
  return constraint === 'users_email_ci' ? 'That email is already registered.' : 'That username is taken.';
}

function session(userRow) {
  const token = createToken(userRow);
  return {
    token,
    // The same token under the OAuth 2.0 names, so standard tools find it too.
    access_token: token,
    token_type: 'Bearer',
    expires_in: config.tokenTtlSeconds,
    user: publicUser(userRow),
  };
}

// Body: { username, email (optional), password }  ->  201 { token, user, ... }
authRouter.post('/register', async (req, res) => {
  const body = bodyOf(req);
  const username = text(body.username);
  const email = text(body.email).toLowerCase();
  const { password } = body;

  const problem = usernameProblem(username) ?? (email ? emailProblem(email) : null) ?? passwordProblem(password);
  if (problem) throw new HttpError(400, problem);

  // Check for duplicates before hashing, so a taken name doesn't cost a full scrypt.
  const { rows: clashes } = await query(
    `SELECT lower(username) = lower($1) AS same_username FROM users
      WHERE lower(username) = lower($1) OR (email IS NOT NULL AND lower(email) = $2)`,
    [username, email || null],
  );
  if (clashes.some((row) => row.same_username)) throw new HttpError(409, duplicateMessage('users_username_ci'));
  if (clashes.length) throw new HttpError(409, duplicateMessage('users_email_ci'));

  const passwordHash = await hashPassword(password);
  try {
    const { rows } = await query(
      `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)
       RETURNING ${PUBLIC_USER_COLUMNS}, token_version`,
      [username, email || null, passwordHash],
    );
    res.status(201).json(session(rows[0]));
  } catch (err) {
    // Someone registered the same name in the split second after our check.
    if (err.code === '23505') throw new HttpError(409, duplicateMessage(err.constraint));
    throw err;
  }
});

// Body: { username (or email), password }  ->  200 { token, user, ... }
authRouter.post('/login', async (req, res) => {
  const body = bodyOf(req);
  const identifier = [body.username, body.email, body.identifier, body.login].map(text).find(Boolean) ?? '';
  const { password } = body;
  if (!identifier || typeof password !== 'string' || !password) {
    throw new HttpError(400, 'Send your username (or email) and your password.');
  }
  if (password.length > 1024) throw new HttpError(400, 'That password is too long.');

  const key = throttleKey(req, identifier);
  const wait = secondsLocked(key);
  if (wait > 0) {
    res.set('Retry-After', String(wait));
    throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minutes.`);
  }

  const { rows } = await query(
    `SELECT ${PUBLIC_USER_COLUMNS}, token_version, password_hash FROM users
      WHERE lower(username) = lower($1) OR lower(email) = lower($1)
      LIMIT 1`,
    [identifier],
  );
  const user = rows[0];
  const ok = user ? await verifyPassword(password, user.password_hash) : await spendVerifyTime(password);
  if (!ok) {
    recordFailure(key);
    // Same message whether or not the username exists, so accounts can't be discovered.
    throw new HttpError(401, 'Wrong username or password.');
  }
  clearFailures(key);

  if (needsRehash(user.password_hash)) {
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), user.id]);
  }
  res.json(session(user));
});

// -> 200 the logged-in user
authRouter.get('/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});
