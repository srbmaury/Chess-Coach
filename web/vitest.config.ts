import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The Supabase Edge Function (../supabase/functions) is tested from here; resolve its
    // npm import from this package, as Deno does through the function's import map.
    alias: { standardwebhooks: fileURLToPath(new URL('./node_modules/standardwebhooks', import.meta.url)) },
  },
  server: { fs: { allow: ['..'] } },
  test: {
    environment: 'jsdom',
  },
})
