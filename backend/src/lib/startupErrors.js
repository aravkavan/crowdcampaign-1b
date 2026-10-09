// Turns common setup mistakes into instructions a person can act on.
import { config } from '../config.js';

export function explainStartupError(err) {
  const code = err?.code;
  const message = err?.message ?? String(err);

  if (code === 'NO_DATABASE_URL') {
    return 'x DATABASE_URL is not set.\n  Open backend/.env and paste your Neon connection string after DATABASE_URL=';
  }
  if (code === 'EADDRINUSE') {
    return `x Port ${config.port} is already in use, probably by another copy of the backend.\n  Close the other terminal (Ctrl+C), or set PORT=4001 in backend/.env and VITE_API_URL=http://localhost:4001 in frontend/.env.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'x Could not find the database server. Check that DATABASE_URL was copied completely and that you are online.';
  }
  if (code === '28P01') {
    return 'x The database rejected the password inside DATABASE_URL. Copy the connection string again from the Neon dashboard.';
  }
  if (code === '3D000') {
    return 'x The database named in DATABASE_URL does not exist. Copy the connection string again from the Neon dashboard.';
  }
  if (code === 'ECONNREFUSED') {
    return 'x The database refused the connection. Check the host and port in DATABASE_URL.';
  }
  if (/timeout/i.test(message)) {
    return 'x Timed out connecting to the database. A sleeping Neon database wakes up in a few seconds; try again. Also check your internet connection.';
  }
  return `x Could not start: ${message}`;
}
