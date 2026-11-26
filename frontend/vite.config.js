import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dashboard dev server on :5173. The gateway URL comes from VITE_GATEWAY (default http://127.0.0.1:8100).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 5173, host: '127.0.0.1' },
});
