// Input rules shared by all routes. Each *Problem() returns an error message or null.
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,50}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Trimmed string, or '' for anything that isn't a string.
export function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function usernameProblem(username) {
  return USERNAME_RE.test(username)
    ? null
    : 'Usernames are 3 to 50 characters: letters, numbers, dots, dashes or underscores.';
}

export function emailProblem(email) {
  return email.length <= 254 && EMAIL_RE.test(email) ? null : 'Enter a valid email address, like name@example.com.';
}

// OWASP: require a minimum length, allow long passphrases, no composition rules.
export function passwordProblem(password) {
  if (typeof password !== 'string' || !password) return 'Password is required.';
  if (password.length < PASSWORD_MIN) return `Passwords need at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Passwords can be at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function lengthProblem(label, value, min, max) {
  if (value.length < min) return `${label} needs at least ${min} characters.`;
  if (value.length > max) return `${label} can be at most ${max} characters.`;
  return null;
}
