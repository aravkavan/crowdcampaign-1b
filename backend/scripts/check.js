// Self-check: exercises every endpoint the way the course's grading script does.
// 1) start the backend (npm start)   2) in a second terminal: npm run check
// It creates two temporary accounts and deletes them at the end.
import { signPayload } from '../src/auth/tokens.js';
import { config } from '../src/config.js';

const BASE = (process.env.API_URL ?? `http://localhost:${config.port}`).replace(/\/+$/, '');
const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = color(32);
const red = color(31);
const yellow = color(33);
const bold = color(1);

const results = [];
const leaks = [];
let responses = 0;

// Rule 1: look through EVERY response for anything that resembles a password or hash.
function scanForLeaks(label, value) {
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (/pass|hash|salt/i.test(key)) leaks.push(`${label}: field "${key}"`);
      scanForLeaks(label, inner);
    }
  } else if (typeof value === 'string' && /^(scrypt\$|\$2[aby]\$|\$argon2)/.test(value)) {
    leaks.push(`${label}: a hash-like value`);
  }
}

async function call(method, path, { token, body, raw, headers = {} } = {}) {
  const sent = { ...headers };
  if (body !== undefined || raw !== undefined) sent['content-type'] = 'application/json';
  if (token) sent.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers: sent,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  responses += 1;
  scanForLeaks(`${method} ${path}`, json);
  return { status: res.status, body: json };
}

function check(name, passed, detail = '') {
  results.push(Boolean(passed));
  console.log(`${passed ? green('PASS') : red('FAIL')}  ${name}${!passed && detail ? `   ${yellow(detail)}` : ''}`);
}

function section(title) {
  console.log(`\n${bold(title)}`);
}

function finish() {
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${bold(`${results.length - failed} of ${results.length} checks passed.`)}`);
  if (failed) console.log(red('Fix the FAIL lines above, restart the backend, and run this again.'));
  else console.log(green('Everything the grading script checks is working.'));
  process.exitCode = failed ? 1 : 0;
}

async function main() {
  try {
    await fetch(`${BASE}/healthz`);
  } catch {
    console.error(red(`Can't reach ${BASE}. Start the backend first (cd backend, then npm start), and run this again.`));
    process.exitCode = 1;
    return;
  }
  console.log(`Checking the API at ${BASE}`);

  section('Health');
  const health = await call('GET', '/healthz');
  check('GET /healthz -> 200 {"status":"ok"}', health.status === 200 && health.body?.status === 'ok', `got ${health.status}`);

  section('Register and log in');
  const stamp = Date.now().toString(36);
  const alice = { username: `check_a_${stamp}`, email: `a_${stamp}@example.com`, password: 'Sunny-Days-2026!' };
  const bob = { username: `check_b_${stamp}`, email: `b_${stamp}@example.com`, password: 'Brew-Haus-2026!' };

  const regA = await call('POST', '/api/auth/register', { body: alice });
  check('register account A -> 201 with a token', regA.status === 201 && typeof regA.body?.token === 'string', `got ${regA.status}`);
  const regB = await call('POST', '/api/auth/register', { body: bob });
  check('register account B -> 201', regB.status === 201, `got ${regB.status}`);
  const duplicate = await call('POST', '/api/auth/register', { body: alice });
  check('register the same username again -> 409', duplicate.status === 409, `got ${duplicate.status}`);
  const shortPassword = await call('POST', '/api/auth/register', { body: { username: `check_c_${stamp}`, password: 'short' } });
  check('register with a 5-character password -> 400', shortPassword.status === 400, `got ${shortPassword.status}`);
  const brokenJson = await call('POST', '/api/auth/register', { raw: '{"username": ' });
  check('send broken JSON -> 400', brokenJson.status === 400, `got ${brokenJson.status}`);

  const wrongPassword = await call('POST', '/api/auth/login', { body: { username: alice.username, password: 'not-the-password' } });
  check('log in with the wrong password -> 401', wrongPassword.status === 401, `got ${wrongPassword.status}`);
  const unknownUser = await call('POST', '/api/auth/login', { body: { username: `nobody_${stamp}`, password: 'whatever-123' } });
  check(
    'log in as a user who does not exist -> 401, same message',
    unknownUser.status === 401 && unknownUser.body?.error === wrongPassword.body?.error,
    `got ${unknownUser.status}`,
  );
  const loginA = await call('POST', '/api/auth/login', { body: { username: alice.username, password: alice.password } });
  check('log in as A -> 200 with a token', loginA.status === 200 && typeof loginA.body?.token === 'string', `got ${loginA.status}`);
  const byEmail = await call('POST', '/api/auth/login', { body: { email: alice.email, password: alice.password } });
  check('log in as A using the email -> 200', byEmail.status === 200, `got ${byEmail.status}`);
  const loginB = await call('POST', '/api/auth/login', { body: { username: bob.username, password: bob.password } });

  let tokenA = loginA.body?.token;
  const tokenB = loginB.body?.token;
  const idA = loginA.body?.user?.id;
  const idB = loginB.body?.user?.id;
  if (!tokenA || !tokenB || !idA || !idB) {
    check('could not log in both test accounts, so the remaining checks were skipped', false);
    return finish();
  }

  section('Rule 2: missing, bad or expired token -> 401');
  const now = Math.floor(Date.now() / 1000);
  const [header, , signature] = tokenA.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ sub: idB, tv: 0, iat: now, exp: now + 3600 })).toString('base64url');
  const unsignedNone = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${forgedPayload}.`;
  const badTokens = [
    ['no Authorization header', {}],
    ['"Bearer" with nothing after it', { headers: { authorization: 'Bearer' } }],
    ['random garbage token', { token: 'not.a.token' }],
    ['wrong scheme (Basic)', { headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } }],
    ['expired token', { token: signPayload({ sub: idA, tv: 0, iat: now - 7200, exp: now - 3600 }) }],
    ['token with an edited payload', { token: `${header}.${forgedPayload}.${signature}` }],
    ['token with "alg": "none"', { token: unsignedNone }],
  ];
  for (const [label, options] of badTokens) {
    const r = await call('GET', '/api/auth/me', options);
    check(`${label}: GET /api/auth/me -> 401`, r.status === 401, `got ${r.status}`);
  }
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const r = await call(method, `/api/users/${idA}`, method === 'PATCH' ? { body: { email: 'x@example.com' } } : {});
    check(`no token: ${method} /api/users/:id -> 401`, r.status === 401, `got ${r.status}`);
  }

  section('Your own account');
  const me = await call('GET', '/api/auth/me', { token: tokenA });
  check('GET /api/auth/me -> 200, account A', me.status === 200 && me.body?.id === idA && me.body?.username === alice.username, `got ${me.status}`);
  const ownGet = await call('GET', `/api/users/${idA}`, { token: tokenA });
  check('GET /api/users/:id (own) -> 200', ownGet.status === 200 && ownGet.body?.id === idA, `got ${ownGet.status}`);
  const newEmail = `a2_${stamp}@example.com`;
  const ownPatch = await call('PATCH', `/api/users/${idA}`, { token: tokenA, body: { email: newEmail } });
  check('PATCH /api/users/:id (own email) -> 200 with the new email', ownPatch.status === 200 && ownPatch.body?.email === newEmail, `got ${ownPatch.status}`);
  const emptyPatch = await call('PATCH', `/api/users/${idA}`, { token: tokenA, body: {} });
  check('PATCH with nothing to change -> 400', emptyPatch.status === 400, `got ${emptyPatch.status}`);

  section("Rule 3: A's token cannot touch B's account");
  const crossGet = await call('GET', `/api/users/${idB}`, { token: tokenA });
  const crossPatch = await call('PATCH', `/api/users/${idB}`, { token: tokenA, body: { email: `stolen_${stamp}@example.com` } });
  const crossDelete = await call('DELETE', `/api/users/${idB}`, { token: tokenA });
  const codes = [crossGet.status, crossPatch.status, crossDelete.status];
  check(`GET, PATCH, DELETE B with A's token are refused (${codes.join(', ')})`, codes.every((c) => c === 403 || c === 404));
  check('all three refusals use the same status code', new Set(codes).size === 1);
  const bAfter = await call('GET', '/api/auth/me', { token: tokenB });
  check('B is unchanged afterwards', bAfter.status === 200 && bAfter.body?.email === bob.email, `got ${bAfter.status}`);
  const noSuchId = await call('GET', '/api/users/00000000-0000-4000-8000-000000000000', { token: tokenA });
  check("an id that doesn't exist gets that same code", noSuchId.status === crossGet.status, `got ${noSuchId.status}`);

  section('Campaigns, ideas, AI shortlist, winner');
  const deadline = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const campaign = await call('POST', '/api/campaigns', {
    token: tokenA,
    body: {
      brand: 'Check Co',
      title: `Self-check campaign ${stamp}`,
      brief: 'A short brief written by the self-check script. We want a marketing idea that gets students to try a new snack on campus.',
      prize: 'Bragging rights',
      deadline,
    },
  });
  check('A creates a campaign -> 201', campaign.status === 201 && campaign.body?.is_organizer === true, `got ${campaign.status}`);
  const cid = campaign.body?.id;
  const list = await call('GET', '/api/campaigns', { token: tokenB });
  check('B sees it in GET /api/campaigns', list.status === 200 && list.body?.campaigns?.some((c) => c.id === cid), `got ${list.status}`);
  const idea = {
    title: 'Snack swap stands',
    content: 'Set up snack swap stands on campus where students trade any snack for a free sample, then post a photo with a hashtag to win a semester supply.',
  };
  const submitted = await call('POST', `/api/campaigns/${cid}/submissions`, { token: tokenB, body: idea });
  check('B submits an idea -> 201', submitted.status === 201, `got ${submitted.status}`);
  const again = await call('POST', `/api/campaigns/${cid}/submissions`, { token: tokenB, body: idea });
  check('B submits a second idea to the same campaign -> 409', again.status === 409, `got ${again.status}`);
  const ownEntry = await call('POST', `/api/campaigns/${cid}/submissions`, { token: tokenA, body: idea });
  check('the organizer enters their own campaign -> 403', ownEntry.status === 403, `got ${ownEntry.status}`);
  const peek = await call('GET', `/api/campaigns/${cid}/submissions`, { token: tokenB });
  check('B lists every idea (organizer only) -> 403', peek.status === 403, `got ${peek.status}`);
  const all = await call('GET', `/api/campaigns/${cid}/submissions`, { token: tokenA });
  check("A lists every idea -> 200 with B's idea", all.status === 200 && all.body?.submissions?.length === 1, `got ${all.status}`);

  const evaluation = await call('POST', `/api/campaigns/${cid}/evaluate`, { token: tokenA, body: {} });
  if (evaluation.status === 502) {
    console.log(`${yellow('NOTE')}  the AI provider failed (${evaluation.body?.error}). That is allowed: the app kept working.`);
  } else {
    check(
      `A runs the judge (${evaluation.body?.judge?.label ?? 'unknown'}) -> 200 with scores`,
      evaluation.status === 200 && evaluation.body?.submissions?.[0]?.evaluation,
      `got ${evaluation.status}`,
    );
  }
  const shortlist = await call('GET', `/api/campaigns/${cid}/shortlist`, { token: tokenA });
  check('GET /api/campaigns/:id/shortlist -> 200', shortlist.status === 200 && Array.isArray(shortlist.body?.shortlist), `got ${shortlist.status}`);
  const stealWin = await call('POST', `/api/campaigns/${cid}/winner`, { token: tokenB, body: { submission_id: submitted.body?.id } });
  check('B tries to pick the winner -> 403', stealWin.status === 403, `got ${stealWin.status}`);
  const pick = await call('POST', `/api/campaigns/${cid}/winner`, { token: tokenA, body: { submission_id: submitted.body?.id } });
  check(
    'A picks the winner -> 200 and the campaign closes',
    pick.status === 200 && pick.body?.status === 'winner_selected' && pick.body?.winner?.id === submitted.body?.id,
    `got ${pick.status}`,
  );
  const pickAgain = await call('POST', `/api/campaigns/${cid}/winner`, { token: tokenA, body: { submission_id: submitted.body?.id } });
  check('picking a second winner -> 409', pickAgain.status === 409, `got ${pickAgain.status}`);

  section('Changing a password');
  const nextPassword = 'Another-Pass-2026!';
  const noCurrent = await call('PATCH', `/api/users/${idA}`, { token: tokenA, body: { password: nextPassword } });
  check('without current_password -> 400', noCurrent.status === 400, `got ${noCurrent.status}`);
  const badCurrent = await call('PATCH', `/api/users/${idA}`, { token: tokenA, body: { password: nextPassword, current_password: 'wrong-guess-123' } });
  check('with a wrong current_password -> 403', badCurrent.status === 403, `got ${badCurrent.status}`);
  const changed = await call('PATCH', `/api/users/${idA}`, { token: tokenA, body: { password: nextPassword, current_password: alice.password } });
  check('with the right current_password -> 200', changed.status === 200, `got ${changed.status}`);
  const oldToken = await call('GET', '/api/auth/me', { token: tokenA });
  check('the old token stops working -> 401', oldToken.status === 401, `got ${oldToken.status}`);
  const relogin = await call('POST', '/api/auth/login', { body: { username: alice.username, password: nextPassword } });
  check('log in with the new password -> 200', relogin.status === 200, `got ${relogin.status}`);
  tokenA = relogin.body?.token;

  section('Deleting accounts');
  const deleteA = await call('DELETE', `/api/users/${idA}`, { token: tokenA });
  check('DELETE /api/users/:id (own) -> 200', deleteA.status === 200, `got ${deleteA.status}`);
  const ghostToken = await call('GET', '/api/auth/me', { token: tokenA });
  check("a deleted account's token -> 401", ghostToken.status === 401, `got ${ghostToken.status}`);
  const ghostLogin = await call('POST', '/api/auth/login', { body: { username: alice.username, password: nextPassword } });
  check('logging in to a deleted account -> 401', ghostLogin.status === 401, `got ${ghostLogin.status}`);
  const orphan = await call('GET', `/api/campaigns/${cid}`, { token: tokenB });
  check("A's campaign was removed along with A -> 404", orphan.status === 404, `got ${orphan.status}`);
  const deleteB = await call('DELETE', `/api/users/${idB}`, { token: tokenB });
  check('clean up account B -> 200', deleteB.status === 200, `got ${deleteB.status}`);

  section('Rule 1: never return a password hash');
  check(`no password or hash field in any of the ${responses} responses`, leaks.length === 0, leaks.slice(0, 3).join('; '));

  return finish();
}

main().catch((err) => {
  console.error(red(`The check script crashed: ${err.message}`));
  process.exitCode = 1;
});
