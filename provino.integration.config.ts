import { defineConfig } from 'provino/config'

// The integration matrix: real package managers, network, minutes. Never part of `pnpm test` or coverage.
export default defineConfig({
  include: ['__tests__/integration/**/*.test.ts'],
  setupFiles: ['./__tests__/setup.ts'],
  timeouts: { test: 10 * 60 * 1000 },
  resolve: { aliases: { '@/*': './src/*' } },
})
