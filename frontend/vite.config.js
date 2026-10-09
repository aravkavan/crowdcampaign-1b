import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// strictPort: if 5173 is busy, stop with an error instead of silently moving to 5174,
// because the backend only accepts requests from the origins listed in CORS_ORIGINS.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
