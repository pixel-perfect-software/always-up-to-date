// filepath: /always-up-to-date/always-up-to-date/tests/services/dependency-checker.test.ts
import { checkDependencies } from "../../src/services/dependency-checker";

describe("Dependency Checker Service", () => {
  test("should identify updatable dependencies", async () => {
    const dependencies = {
      "example-package": "1.0.0",
      "another-package": "2.1.0",
    };

    const updates = await checkDependencies(dependencies);
    
    expect(updates).toEqual([
      { name: "example-package", current: "1.0.0", latest: "1.1.0" },
      { name: "another-package", current: "2.1.0", latest: "2.2.0" },
    ]);
  });

  test("should handle breaking changes", async () => {
    const dependencies = {
      "breaking-package": "1.0.0",
    };

    const updates = await checkDependencies(dependencies);
    
    expect(updates).toEqual([
      {
        name: "breaking-package",
        current: "1.0.0",
        latest: "2.0.0",
        breaking: true,
        migrationInstructions: "Please refer to the breaking changes documentation.",
      },
    ]);
  });

  test("should return an empty array for up-to-date dependencies", async () => {
    const dependencies = {
      "up-to-date-package": "2.2.0",
    };

    const updates = await checkDependencies(dependencies);
    
    expect(updates).toEqual([]);
  });
});