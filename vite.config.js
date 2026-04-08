import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Force single copy of @strudel/web to avoid duplicate soundMap instances
// (the pre-built bundle inlines @strudel/core, causing register/lookup mismatches)
const strudelWeb = resolve(
  __dirname,
  'node_modules/@strudel/web/web.mjs',
)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      '@strudel/web': strudelWeb,
    },
  },
  define: {
    // Pass shell env vars to the client (Vite only reads VITE_* from .env files)
    ...(process.env.VITE_RELAY_URL ? { 'import.meta.env.VITE_RELAY_URL': JSON.stringify(process.env.VITE_RELAY_URL) } : {}),
    ...(process.env.VITE_API_URL ? { 'import.meta.env.VITE_API_URL': JSON.stringify(process.env.VITE_API_URL) } : {}),
    ...(process.env.VITE_PI_URL ? { 'import.meta.env.VITE_PI_URL': JSON.stringify(process.env.VITE_PI_URL) } : {}),
    ...(process.env.VITE_APP_TITLE ? { 'import.meta.env.VITE_APP_TITLE': JSON.stringify(process.env.VITE_APP_TITLE) } : {}),
    ...(process.env.VITE_CLIENT_SLUG ? { 'import.meta.env.VITE_CLIENT_SLUG': JSON.stringify(process.env.VITE_CLIENT_SLUG) } : {}),
    ...(process.env.VITE_ROOMS_URL ? { 'import.meta.env.VITE_ROOMS_URL': JSON.stringify(process.env.VITE_ROOMS_URL) } : {}),
  },
  server: {
    watch: {
      usePolling: false,
    },
    hmr: true,
  },
  cacheDir: '/tmp/vite-cache-npc',
})
