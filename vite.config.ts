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
  },
})
