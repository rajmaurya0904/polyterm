import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.POLYTERM_API ?? 'http://localhost:4010';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true, rewrite: () => '/' },
    },
  },
});
