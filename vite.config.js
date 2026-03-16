import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/npc-no-more/',
  define: {
    // Pass shell env vars to the client (Vite only reads VITE_* from .env files)
    ...(process.env.VITE_RELAY_URL ? { 'import.meta.env.VITE_RELAY_URL': JSON.stringify(process.env.VITE_RELAY_URL) } : {}),
    ...(process.env.VITE_ADMIN_SECRET ? { 'import.meta.env.VITE_ADMIN_SECRET': JSON.stringify(process.env.VITE_ADMIN_SECRET) } : {}),
  },
  server: {
    watch: {
      usePolling: false,
    },
    hmr: true,
    proxy: {
      '/nim-api': {
        target: 'https://integrate.api.nvidia.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nim-api/, ''),
      },
    },
  },
  cacheDir: '/tmp/vite-cache-npc',
})
