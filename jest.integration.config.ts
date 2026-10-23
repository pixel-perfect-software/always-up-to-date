import base from './jest.config.ts'

// The integration matrix: real package managers, network, minutes. Never part of `pnpm test` or coverage.
export default {
  ...base,
  roots: ['<rootDir>/__tests__/integration'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverage: false,
  testTimeout: 10 * 60 * 1000,
}
