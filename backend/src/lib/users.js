// The ONLY user fields that ever leave the server (Rule 1).
// password_hash and token_version are not in this list, and every response that
// contains a user is built by publicUser(), never by sending a database row as-is.
export const PUBLIC_USER_COLUMNS = 'id, username, email, created_at, updated_at';

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
