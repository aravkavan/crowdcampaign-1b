// Password hashing with scrypt, built into Node (no native add-on to compile).
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// OWASP Password Storage Cheat Sheet: scrypt with N=2^17, r=8, p=1.
// One hash needs ~128 MiB of memory and a noticeable fraction of a second. That cost
// is the point: it makes guessing passwords from a stolen database very slow.
const COST = { N: 2 ** 17, r: 8, p: 1 };
const KEY_BYTES = 64;
const SALT_BYTES = 16;

function derive(password, salt, { N, r, p }, keyBytes) {
  // Node refuses to run scrypt above `maxmem`; scrypt needs about 128 * N * r bytes.
  return scrypt(password.normalize('NFKC'), salt, keyBytes, { N, r, p, maxmem: 256 * N * r });
}

// Stored format: scrypt$N$r$p$<salt, base64>$<hash, base64>
// A new random salt per password means two people with the same password still get
// different hashes. Keeping the cost next to the hash lets us raise it later.
export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST, KEY_BYTES);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!salt.length || !expected.length) return false;
  const actual = await derive(password, salt, { N, r, p }, expected.length);
  // Constant-time comparison: how long it takes reveals nothing about the hash.
  return crypto.timingSafeEqual(actual, expected);
}

// True when a stored hash used older (weaker) settings; login upgrades it quietly.
export function needsRehash(stored) {
  const parts = String(stored).split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) !== COST.N || Number(parts[2]) !== COST.r || Number(parts[3]) !== COST.p;
}

// When a username doesn't exist we still do one full scrypt, so "no such user" and
// "wrong password" take the same time and an attacker can't tell them apart.
let timingDummy = null;
export async function spendVerifyTime(password) {
  timingDummy ??= await hashPassword('crowdcampaign-timing-dummy');
  await verifyPassword(password, timingDummy);
  return false;
}
