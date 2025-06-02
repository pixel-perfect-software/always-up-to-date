module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/tests/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
      },
    ],
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coveragePathIgnorePatterns: ["node_modules/", "index.ts"],
  coverageReporters: ["text", "lcov", "html", "json-summary"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  clearMocks: true,
  restoreMocks: true,
  transformIgnorePatterns: ["node_modules/(?!(@octokit|@inquirer)/)"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^@octokit/rest$": "<rootDir>/tests/mocks/github-api.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testTimeout: 15000,
};
