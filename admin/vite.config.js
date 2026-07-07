import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// The admin is served from the binary under /_/ (see src/admin/embed.ts), so the
// build must reference assets under that base and route there. In dev we proxy
// /api to a running `cogworks` server (default :8090).
export default defineConfig({
  base: '/_/',
  plugins: [tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8091', changeOrigin: true },
      // Readiness/health live at /_/… on the backend; proxy the exact paths so
      // they don't get swallowed by the SPA served under the /_/ base in dev.
      '/_/ready': { target: 'http://localhost:8091', changeOrigin: true },
      '/_/health': { target: 'http://localhost:8091', changeOrigin: true },
    },
  },
  build: {
    // Never inline fonts as data: URIs — the binary's CSP (default-src 'self',
    // no font-src) blocks data: fonts. Emit them as files served from 'self'.
    assetsInlineLimit: (filePath) => (filePath.endsWith('.woff2') ? false : undefined),
  },
})
