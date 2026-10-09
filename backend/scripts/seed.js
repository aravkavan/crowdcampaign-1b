// Creates the grader account (NYUgrader / Courant2026!) and demo data.
// Safe to run any number of times: it only adds what is missing.
//   npm run seed
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { hasDatabaseUrl, pool, query } from '../src/db.js';
import { explainStartupError } from '../src/lib/startupErrors.js';
import { migrate } from '../src/migrate.js';
import { DEMO_BOTTLE_BRAND, DEMO_BRAND, DEMO_CAMPAIGNS, DEMO_PASSWORD, DEMO_PEOPLE } from './demo-data.js';

const GRADER = { username: 'NYUgrader', email: 'nyugrader@example.com', password: 'Courant2026!' };
const DAY_MS = 24 * 3600 * 1000;

async function ensureUser({ username, email }, password, { resetPassword = false } = {}) {
  const { rows } = await query('SELECT id, password_hash FROM users WHERE lower(username) = lower($1)', [username]);
  if (rows[0]) {
    if (resetPassword && !(await verifyPassword(password, rows[0].password_hash))) {
      await query(
        'UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = now() WHERE id = $2',
        [await hashPassword(password), rows[0].id],
      );
      console.log(`  reset the password of ${username}`);
    }
    return rows[0].id;
  }
  const { rows: emailTaken } = await query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]);
  const created = await query(
    'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [username, emailTaken.length ? null : email, await hashPassword(password)],
  );
  console.log(`  created user ${username}`);
  return created.rows[0].id;
}

async function ensureCampaign(spec, organizerId, people) {
  const deadline = new Date(Date.now() + spec.daysLeft * DAY_MS);
  const { rows } = await query('SELECT id, deadline FROM campaigns WHERE organizer_id = $1 AND title = $2', [
    organizerId,
    spec.title,
  ]);
  let campaignId = rows[0]?.id;
  if (!campaignId) {
    const created = await query(
      `INSERT INTO campaigns (organizer_id, brand, title, brief, prize, deadline)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [organizerId, spec.brand, spec.title, spec.brief, spec.prize, deadline.toISOString()],
    );
    campaignId = created.rows[0].id;
    console.log(`  created campaign "${spec.title}"`);
  } else if (spec.daysLeft > 0 && new Date(rows[0].deadline) < new Date()) {
    // Keep the open demo campaigns open when grading happens weeks later.
    await query(
      `UPDATE campaigns SET deadline = $1 WHERE id = $2
         AND NOT EXISTS (SELECT 1 FROM submissions WHERE campaign_id = $2 AND is_winner)`,
      [deadline.toISOString(), campaignId],
    );
    console.log(`  reopened campaign "${spec.title}" (deadline had passed)`);
  }

  for (const [username, title, content] of spec.ideas) {
    await query(
      `INSERT INTO submissions (campaign_id, author_id, title, content) VALUES ($1, $2, $3, $4)
       ON CONFLICT (campaign_id, author_id) DO NOTHING`,
      [campaignId, people.get(username), title, content],
    );
  }

  if (spec.winner) {
    await query(
      `UPDATE submissions SET is_winner = true
        WHERE campaign_id = $1 AND author_id = $2
          AND NOT EXISTS (SELECT 1 FROM submissions WHERE campaign_id = $1 AND is_winner)`,
      [campaignId, people.get(spec.winner)],
    );
  }
}

async function main() {
  if (!hasDatabaseUrl()) throw Object.assign(new Error('DATABASE_URL is missing'), { code: 'NO_DATABASE_URL' });
  console.log('Preparing the database...');
  await migrate();

  console.log('Accounts (hashing passwords takes a few seconds):');
  const graderId = await ensureUser(GRADER, GRADER.password, { resetPassword: true });
  const brandId = await ensureUser(DEMO_BRAND, DEMO_PASSWORD);
  const bottleBrandId = await ensureUser(DEMO_BOTTLE_BRAND, DEMO_PASSWORD);
  const people = new Map();
  for (const person of DEMO_PEOPLE) people.set(person.username, await ensureUser(person, DEMO_PASSWORD));

  console.log('Campaigns and ideas:');
  for (const spec of DEMO_CAMPAIGNS) {
    const organizers = { grader: graderId, brand: brandId, bottle: bottleBrandId };
    await ensureCampaign(spec, organizers[spec.organizer], people);
  }

  const { rows } = await query(
    'SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM campaigns) AS campaigns, (SELECT count(*)::int FROM submissions) AS ideas',
  );
  console.log(`\nDone. The database now has ${rows[0].users} users, ${rows[0].campaigns} campaigns and ${rows[0].ideas} ideas.`);
  console.log(`Grader login:  ${GRADER.username} / ${GRADER.password}`);
  console.log(`Demo logins:   any demo username (e.g. maya_makes) / ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(explainStartupError(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
