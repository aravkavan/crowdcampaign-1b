// One shared pool of PostgreSQL connections for the whole server.
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export function hasDatabaseUrl() {
  return Boolean(config.databaseUrl) && !config.databaseUrl.includes('REPLACE_WITH');
}

// Neon's connection strings say sslmode=require. node-postgres already treats that as
// "encrypt AND verify the server certificate", then prints a long notice about it.
// Writing verify-full keeps exactly that secure behaviour without the notice.
function normalizeConnectionString(url) {
  return url.replace(/([?&])sslmode=require(?=&|$)/, '$1sslmode=verify-full');
}

export const pool = new Pool({
  connectionString: hasDatabaseUrl() ? normalizeConnectionString(config.databaseUrl) : undefined,
  max: 5,
  idleTimeoutMillis: 30_000,
  // Neon's free tier sleeps after 5 idle minutes; waking up takes a moment.
  connectionTimeoutMillis: 15_000,
});

// Neon closes idle connections from time to time. Without this listener that would
// crash the server; with it, the pool simply opens a fresh connection next time.
pool.on('error', (err) => {
  console.error('[db] an idle connection was closed:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

// Runs several statements as one all-or-nothing unit.
export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
