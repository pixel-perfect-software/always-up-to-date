import { defineConfig } from 'provino/config'

export default defineConfig({
  include: ['__tests__/**/*.test.ts'],
  // The integration matrix runs under provino.integration.config.ts, never in `pnpm test` or coverage.
  exclude: ['**/node_modules/**', '__tests__/integration/**'],
  setupFiles: ['./__tests__/setup.ts'],
  timeouts: { test: 15000 },
  resolve: { aliases: { '@/*': './src/*' } },
  coverage: {
    // Istanbul, as Jest's default provider was, so the badges keep measuring statements the same way.
    provider: 'istanbul',
    // Only the re-export barrels are left out. Every other file, including each manager's
    // index.ts and the CLI entry, is measured.
    include: [
      'src/**/*.ts',
      '!src/**/*.d.ts',
      '!src/commands/index.ts',
      '!src/managers/index.ts',
    ],
    reporters: ['text', 'lcov', 'html', 'json-summary'],
  },
})
