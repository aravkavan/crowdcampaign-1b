// Starts the API: check settings -> create/verify tables -> listen.
import http from 'node:http';
import { describeJudge } from './ai/evaluator.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { hasDatabaseUrl, pool } from './db.js';
import { explainStartupError } from './lib/startupErrors.js';
import { migrate } from './migrate.js';

async function main() {
  if (!hasDatabaseUrl()) throw Object.assign(new Error('DATABASE_URL is missing'), { code: 'NO_DATABASE_URL' });
  void config.jwtSecret; // fails fast on a bad JWT_SECRET, or creates the local key

  console.log('Connecting to the database...');
  await migrate();
  console.log('Database ready: tables checked (and created if missing).');

  const server = http.createServer(createApp());
  server.on('error', (err) => {
    console.error(explainStartupError(err));
    process.exit(1);
  });
  server.listen(config.port, () => {
    console.log(`\nCrowdCampaign API is running at http://localhost:${config.port}`);
    console.log(`  Health check:     http://localhost:${config.port}/healthz`);
    console.log(`  Allowed origins:  ${config.corsOrigins.join(', ')}`);
    console.log(`  AI judge:         ${describeJudge().label}`);
    console.log('  Stop with Ctrl+C\n');
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(explainStartupError(err));
  process.exit(1);
});
