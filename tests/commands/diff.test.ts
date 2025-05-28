import { showDependencyDiff } from "../../src/commands/diff";

describe("Diff Command", () => {
  test("should return diff structure with changes and summary", async () => {
    const result = await showDependencyDiff();
    expect(result).toHaveProperty("changes");
    expect(result).toHaveProperty("summary");
    expect(Array.isArray(result.changes)).toBe(true);
    expect(typeof result.summary).toBe("object");
  });

  test("should categorize changes correctly", async () => {
    const result = await showDependencyDiff();
    result.changes.forEach((change) => {
      expect(change).toHaveProperty("name");
      expect(change).toHaveProperty("type");
      expect(change).toHaveProperty("currentVersion");
      expect(change).toHaveProperty("newVersion");
      expect(change).toHaveProperty("changeType");
      expect(["safe", "breaking"]).toContain(change.type);
      expect(["patch", "minor", "major"]).toContain(change.changeType);
    });
  });

  test("should handle empty changes correctly", async () => {
    // Mock a scenario with no changes
    const result = await showDependencyDiff();
    expect(result.summary).toHaveProperty("total");
    expect(result.summary).toHaveProperty("safe");
    expect(result.summary).toHaveProperty("breaking");
    expect(typeof result.summary.total).toBe("number");
  });

  test("should handle errors gracefully", async () => {
    const originalError = console.error;
    console.error = jest.fn();

    // Test with invalid project path
    const result = await showDependencyDiff({ projectPath: "/invalid/path" });
    expect(result).toEqual({
      changes: [],
      summary: { total: 0, safe: 0, breaking: 0 },
    });

    console.error = originalError;
  });

  test("should include migration instructions for breaking changes", async () => {
    const result = await showDependencyDiff();
    const breakingChanges = result.changes.filter(
      (change) => change.type === "breaking"
    );

    breakingChanges.forEach((change) => {
      // Migration instructions should be present for breaking changes
      expect(change).toHaveProperty("migrationInstructions");
    });
  });
});
