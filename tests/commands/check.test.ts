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

  test("should handle preview mode correctly", async () => {
    const result = await checkDependencies({ preview: true });
    expect(result).toHaveProperty("updatable");
    expect(result).toHaveProperty("breakingChanges");
  });

  test("should handle interactive mode correctly", async () => {
    // Mock user input to avoid hanging in interactive mode
    const mockConsoleLog = jest
      .spyOn(console, "log")
      .mockImplementation(() => {});

    const result = await checkDependencies({ interactive: true });
    expect(result).toHaveProperty("updatable");
    expect(result).toHaveProperty("breakingChanges");

    mockConsoleLog.mockRestore();
  });

  test("should handle errors gracefully", async () => {
    const originalError = console.error;
    console.error = jest.fn();

    // Test with invalid project path
    const result = await checkDependencies({ projectPath: "/invalid/path" });
    expect(result).toEqual({ updatable: [], breakingChanges: [] });

    console.error = originalError;
  });
});
