/**
 * Tests for args.ts utilities
 */
import { parseArgs } from "../../src/utils/args";

describe("Arguments Parser Utilities", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  test("should parse basic flags correctly", () => {
    process.argv = ["node", "index.js", "--mode=check"];

    const args = parseArgs();
    expect(args.mode).toBe("check");
  });

  test("should parse flags with values correctly", () => {
    process.argv = [
      "node",
      "index.js",
      "--mode",
      "audit",
      "--repository",
      "user/repo",
    ];

    const args = parseArgs();
    expect(args.mode).toBe("audit");
    expect(args.repository).toBe("user/repo");
  });

  test("should handle boolean flags correctly", () => {
    process.argv = ["node", "index.js", "--verbose"];

    const args = parseArgs();
    expect(args.verbose).toBe(true);
  });

  test("should handle mixed flags correctly", () => {
    process.argv = [
      "node",
      "index.js",
      "--mode",
      "auto",
      "--createIssue",
      "--token",
      "abc123",
    ];

    const args = parseArgs();
    expect(args.mode).toBe("auto");
    expect(args.createIssue).toBe(true);
    expect(args.token).toBe("abc123");
  });
});