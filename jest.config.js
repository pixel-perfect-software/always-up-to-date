module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/tests/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true }],
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coveragePathIgnorePatterns: ["node_modules/", "index.ts"],
  coverageReporters: ["text", "lcov", "html", "json-summary"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  clearMocks: true,
  restoreMocks: true,
  transformIgnorePatterns: ["node_modules/(?!(@octokit|@inquirer)/)"],
  extensionsToTreatAsEsm: [".ts"],
  testTimeout: 15000,
}
