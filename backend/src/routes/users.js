// GET, PATCH, DELETE /api/users/:id  (all protected)
import { Router } from 'express';
import { query } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { requireAuth } from '../auth/requireAuth.js';
import { HttpError, bodyOf } from '../lib/http.js';
import { PUBLIC_USER_COLUMNS, publicUser } from '../lib/users.js';
import { emailProblem, passwordProblem, text, usernameProblem } from '../lib/validate.js';

export const usersRouter = Router();

// Rule 3: you can only touch your own account. Any :id that isn't yours gets 404,
// exactly as if it didn't exist. We never look the other id up, so the answer is
// identical for "someone else's account" and "no such account": nothing to enumerate.
// This check runs before the body is read, so GET, PATCH and DELETE all refuse the
// same way no matter what the request contains.
function ownAccountOnly(req, res, next) {
  if (String(req.params.id).toLowerCase() !== req.user.id) {
    return res.status(404).json({ error: 'User not found.' });
  }
  return next();
}

usersRouter.get('/:id', requireAuth, ownAccountOnly, (req, res) => {
  res.json(publicUser(req.user));
});

// Body: any of { username, email, password + current_password }
usersRouter.patch('/:id', requireAuth, ownAccountOnly, async (req, res) => {
  const body = bodyOf(req);
  const sets = [];
  const values = [];
  const set = (column, value) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (body.username !== undefined) {
    const username = text(body.username);
    const problem = usernameProblem(username);
    if (problem) throw new HttpError(400, problem);
    set('username', username);
  }

  if (body.email !== undefined) {
    const email = text(body.email).toLowerCase();
    const problem = emailProblem(email);
    if (problem) throw new HttpError(400, problem);
    set('email', email);
  }

  if (body.password !== undefined) {
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    // OWASP: re-check the current password before changing it, so a stolen token
    // alone can't lock the real owner out.
    const current = [body.current_password, body.currentPassword, body.old_password, body.oldPassword].find(
      (value) => typeof value === 'string' && value,
    );
    if (!current) throw new HttpError(400, 'To change your password, also send current_password.');
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(current, rows[0]?.password_hash))) {
      // 403, not 401: you ARE logged in; you just failed the re-check.
      throw new HttpError(403, 'Your current password is incorrect.');
    }
    set('password_hash', await hashPassword(body.password));
    sets.push('token_version = token_version + 1'); // every existing token stops working
  }

  if (!sets.length) throw new HttpError(400, 'Nothing to update. Send username, email and/or password.');
  sets.push('updated_at = now()');
  values.push(req.user.id);

  try {
    const { rows } = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${PUBLIC_USER_COLUMNS}`,
      values,
    );
    res.json(publicUser(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      throw new HttpError(409, err.constraint === 'users_email_ci' ? 'That email is already registered.' : 'That username is taken.');
    }
    throw err;
  }
});

usersRouter.delete('/:id', requireAuth, ownAccountOnly, async (req, res) => {
  // ON DELETE CASCADE also removes this user's campaigns, ideas and their scores.
  await query('DELETE FROM users WHERE id = $1', [req.user.id]);
  res.json({ deleted: true, id: req.user.id });
});
