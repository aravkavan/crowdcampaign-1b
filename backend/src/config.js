// Reads every setting from environment variables (.env and .env.local).
// The full list, with explanations, is in backend/.env.example.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env.local is loaded first so its values win (dotenv never overwrites a variable
// that is already set). It holds personal keys and is ignored by git.
dotenv.config({ path: path.join(BACKEND_ROOT, '.env.local'), quiet: true });
dotenv.config({ path: path.join(BACKEND_ROOT, '.env'), quiet: true });

const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

function list(value, fallback) {
  const items = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(value ?? '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

// The token-signing key is a real secret, so it never goes into git.
//   Deployed: set JWT_SECRET.
//   Local:    generate a random key on first start and keep it in
//             backend/.secrets/jwt-secret (git-ignored), so logins survive restarts.
function resolveJwtSecret() {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters. Delete the line to let the server generate one.');
    }
    return fromEnv;
  }
  const file = path.join(BACKEND_ROOT, '.secrets', 'jwt-secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {
    // First start on this machine: no key yet.
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  console.log('[config] Created a token-signing key in backend/.secrets/jwt-secret (git-ignored).');
  return secret;
}

let jwtSecret = null;

export const config = {
  root: BACKEND_ROOT,
  port: positiveInt(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
  corsOrigins: list(process.env.CORS_ORIGINS, DEFAULT_ORIGINS),
  tokenTtlSeconds: positiveInt(process.env.TOKEN_TTL_SECONDS, 2 * 60 * 60),

  // Resolved on first use, so scripts that never sign tokens (like the seed) skip it.
  get jwtSecret() {
    jwtSecret ??= resolveJwtSecret();
    return jwtSecret;
  },

  ai: {
    provider: (process.env.AI_PROVIDER ?? 'auto').trim().toLowerCase(),
    anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() ?? '',
    anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5-20251001',
    geminiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
    geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
    timeoutMs: positiveInt(process.env.AI_TIMEOUT_SECONDS, 45) * 1000,
  },
};
