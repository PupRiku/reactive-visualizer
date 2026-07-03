import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // localhost is a secure context, so getDisplayMedia system-audio capture
    // works without any deployment.
    host: 'localhost',
    port: 5173,
    // Proxy /api to the local recognition backend so the browser calls it
    // same-origin (no CORS) and never sees the AudD token. Keep this target's
    // port in sync with PORT in server/.env (default 8787).
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
