import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/npc-no-more/',
  define: {
    // Pass shell env vars to the client (Vite only reads VITE_* from .env files)
    ...(process.env.VITE_RELAY_URL ? { 'import.meta.env.VITE_RELAY_URL': JSON.stringify(process.env.VITE_RELAY_URL) } : {}),
    ...(process.env.VITE_API_URL ? { 'import.meta.env.VITE_API_URL': JSON.stringify(process.env.VITE_API_URL) } : {}),
    ...(process.env.VITE_PI_URL ? { 'import.meta.env.VITE_PI_URL': JSON.stringify(process.env.VITE_PI_URL) } : {}),
  },
  server: {
    watch: {
      usePolling: false,
    },
    hmr: true,
  },
  cacheDir: '/tmp/vite-cache-npc',
})
