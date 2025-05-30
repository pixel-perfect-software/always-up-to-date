import { MigrationAdvisor } from "../../src/services/migration-advisor";
import {
  MigrationRuleProvider,
  PackageMigrationInfo,
} from "../../src/services/migration-rules";

describe("Migration Advisor Modular System", () => {
  let advisor: MigrationAdvisor;

  beforeEach(() => {
    advisor = new MigrationAdvisor();
  });

  describe("Built-in Providers", () => {
    it("should load default providers", () => {
      const supportedPackages = advisor.getSupportedPackages();

      expect(supportedPackages).toContain("react");
      expect(supportedPackages).toContain("next");
      expect(supportedPackages).toContain("typescript");
      expect(supportedPackages).toContain("eslint");
      expect(supportedPackages).toContain("prettier");
      expect(supportedPackages).toContain("jest");
    });

    it("should provide migration instructions for React", async () => {
      const instructions = await advisor.getMigrationInstructions(
        "react",
        "17.0.0",
        "18.0.0"
      );

      expect(instructions).toContain("React 18 Migration Guide");
      expect(instructions).toContain("ReactDOM.createRoot");
      expect(instructions).toContain("Automatic Batching");
    });

    it("should provide migration instructions for Next.js", async () => {
      const instructions = await advisor.getMigrationInstructions(
        "next",
        "13.0.0",
        "14.0.0"
      );

      expect(instructions).toContain("Next.js 14 Migration Guide");
      expect(instructions).toContain("App Router");
      expect(instructions).toContain("Server Actions");
    });
  });

  describe("Custom Providers", () => {
    class TestMigrationProvider implements MigrationRuleProvider {
      getPackageName(): string {
        return "test-package";
      }

      getMigrationInfo(): PackageMigrationInfo {
        return {
          name: "test-package",
          tags: ["test", "custom"],
          rules: [
            {
              fromVersion: "1.x.x",
              toVersion: "2.x.x",
              priority: 1,
              instructions: "Test migration instructions",
              breakingChanges: ["API changed"],
              automatedFixes: ["Update imports"],
            },
          ],
          repositoryUrl: "https://github.com/test/test-package",
        };
      }
    }

    it("should register custom providers", () => {
      const customProvider = new TestMigrationProvider();
      advisor.registerCustomProvider(customProvider);

      const supportedPackages = advisor.getSupportedPackages();
      expect(supportedPackages).toContain("test-package");
    });

    it("should provide migration instructions from custom providers", async () => {
      const customProvider = new TestMigrationProvider();
      advisor.registerCustomProvider(customProvider);

      const instructions = await advisor.getMigrationInstructions(
        "test-package",
        "1.0.0",
        "2.0.0"
      );
      expect(instructions).toContain("Test migration instructions");
    });
  });

  describe("Tag Search", () => {
    it("should find providers by tag", () => {
      const frameworkPackages = advisor.searchProvidersByTag("framework");
      expect(frameworkPackages).toContain("react");
      expect(frameworkPackages).toContain("next");
    });

    it("should find testing packages", () => {
      const testingPackages = advisor.searchProvidersByTag("testing");
      expect(testingPackages).toContain("jest");
    });

    it("should find linting packages", () => {
      const lintingPackages = advisor.searchProvidersByTag("linting");
      expect(lintingPackages).toContain("eslint");
      expect(lintingPackages).toContain("prettier");
    });
  });

  describe("Priority Handling", () => {
    class PriorityTestProvider implements MigrationRuleProvider {
      getPackageName(): string {
        return "priority-test";
      }

      getMigrationInfo(): PackageMigrationInfo {
        return {
          name: "priority-test",
          rules: [
            {
              fromVersion: "1.x.x",
              toVersion: "2.x.x",
              priority: 1,
              instructions: "Low priority instruction",
              breakingChanges: [],
            },
            {
              fromVersion: "1.x.x",
              toVersion: "2.x.x",
              priority: 5,
              instructions: "High priority instruction",
              breakingChanges: [],
            },
          ],
        };
      }
    }

    it("should use highest priority rule", async () => {
      const provider = new PriorityTestProvider();
      advisor.registerCustomProvider(provider);

      const instructions = await advisor.getMigrationInstructions(
        "priority-test",
        "1.0.0",
        "2.0.0"
      );
      expect(instructions).toContain("High priority instruction");
    });
  });
});
