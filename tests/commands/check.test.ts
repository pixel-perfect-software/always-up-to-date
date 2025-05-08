import { checkDependencies } from "../../src/commands/check";

describe("Check Command", () => {
  test("should identify updatable dependencies", async () => {
    const result = await checkDependencies();
    expect(result).toHaveProperty("updatable");
    expect(Array.isArray(result.updatable)).toBe(true);
  });

  test("should handle no updatable dependencies", async () => {
    const result = await checkDependencies();
    expect(result.updatable.length).toBe(0);
  });

  test("should return breaking changes if present", async () => {
    const result = await checkDependencies();
    expect(result).toHaveProperty("breakingChanges");
    expect(Array.isArray(result.breakingChanges)).toBe(true);
  });

  test("should provide migration instructions for breaking changes", async () => {
    const result = await checkDependencies();
    if (result.breakingChanges.length > 0) {
      expect(result.breakingChanges[0]).toHaveProperty("migrationInstructions");
    }
  });
});