import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/extension/manifest'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }

          if (id.includes('react')) {
            return 'vendor-react'
          }

          if (id.includes('dexie')) {
            return 'vendor-dexie'
          }

          return 'vendor'
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.ts'],
  },
})
