import { autoUpdateDependencies } from "../../src/commands/auto";

describe("Auto Command", () => {
  test("should update dependencies without breaking changes", async () => {
    const result = await autoUpdateDependencies();
    expect(result).toHaveProperty("updated", true);
    expect(result).toHaveProperty("message", "Dependencies updated successfully.");
  });

  test("should create a PR for breaking changes", async () => {
    const result = await autoUpdateDependencies({ simulateBreakingChange: true });
    expect(result).toHaveProperty("updated", false);
    expect(result).toHaveProperty("prCreated", true);
    expect(result).toHaveProperty("message", "PR created for breaking changes. See PR for details.");
  });

  test("should handle no updates available", async () => {
    const result = await autoUpdateDependencies({ simulateNoUpdates: true });
    expect(result).toHaveProperty("updated", false);
    expect(result).toHaveProperty("message", "No updates available.");
  });
});