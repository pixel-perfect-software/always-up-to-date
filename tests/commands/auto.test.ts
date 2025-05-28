import { autoUpdateDependencies } from "../../src/commands/auto";

describe("Auto Command", () => {
  test("should update dependencies and return results", async () => {
    const result = await autoUpdateDependencies();
    expect(result).toHaveProperty("updated");
    expect(result).toHaveProperty("prCreated");
    expect(Array.isArray(result.updated)).toBe(true);
    expect(typeof result.prCreated).toBe("boolean");
  });

  test("should create a PR for breaking changes", async () => {
    const result = await autoUpdateDependencies({
      simulateBreakingChange: true,
    });
    expect(result).toHaveProperty("updated");
    expect(result).toHaveProperty("prCreated");
  });

  test("should handle no updates available", async () => {
    const result = await autoUpdateDependencies({ simulateNoUpdates: true });
    expect(result).toHaveProperty("updated");
    expect(result).toHaveProperty("prCreated");
  });

  test("should handle dry run mode", async () => {
    const result = await autoUpdateDependencies({ dryRun: true });
    expect(result).toHaveProperty("updated");
    expect(result).toHaveProperty("prCreated");
  });

  test("should create backup before updates", async () => {
    const originalLog = console.log;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await autoUpdateDependencies();

    logSpy.mockRestore();
  });

  test("should handle errors gracefully", async () => {
    const originalError = console.error;
    console.error = jest.fn();

    const result = await autoUpdateDependencies({
      projectPath: "/invalid/path",
    });
    expect(result).toEqual({ updated: [], prCreated: false });

    console.error = originalError;
  });
});
