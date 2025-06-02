import { WorkspaceManager } from "../../src/utils/workspace-manager";
import { WorkspaceInfo, WorkspacePackage } from "../../src/types/workspace";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("WorkspaceManager", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `workspace-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Single Package Detection", () => {
    it("should detect a single package project", async () => {
      const packageJson = {
        name: "test-package",
        version: "1.0.0",
        dependencies: {
          lodash: "^4.17.21",
        },
      };

      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify(packageJson, null, 2)
      );

      const workspaceInfo = await WorkspaceManager.detect(testDir);

      expect(workspaceInfo.isMonorepo).toBe(false);
      expect(workspaceInfo.packages).toHaveLength(1);
      expect(workspaceInfo.packages[0].name).toBe("test-package");
      expect(workspaceInfo.packages[0].isRoot).toBe(true);
      expect(workspaceInfo.packages[0].dependencies.lodash).toBe("^4.17.21");
    });
  });

  describe("Monorepo Detection", () => {
    it("should detect npm/yarn workspaces", async () => {
      // Root package.json with workspaces
      const rootPackageJson = {
        name: "monorepo-root",
        private: true,
        workspaces: ["packages/*"],
        dependencies: {
          typescript: "^5.0.0",
        },
      };

      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create workspace packages
      const packagesDir = join(testDir, "packages");
      mkdirSync(packagesDir, { recursive: true });

      // Package A
      const packageADir = join(packagesDir, "package-a");
      mkdirSync(packageADir);
      const packageAJson = {
        name: "@monorepo/package-a",
        version: "1.0.0",
        dependencies: {
          lodash: "^4.17.21",
        },
      };
      writeFileSync(
        join(packageADir, "package.json"),
        JSON.stringify(packageAJson, null, 2)
      );

      // Package B
      const packageBDir = join(packagesDir, "package-b");
      mkdirSync(packageBDir);
      const packageBJson = {
        name: "@monorepo/package-b",
        version: "1.0.0",
        dependencies: {
          express: "^4.18.0",
          "@monorepo/package-a": "^1.0.0", // internal dependency
        },
      };
      writeFileSync(
        join(packageBDir, "package.json"),
        JSON.stringify(packageBJson, null, 2)
      );

      const workspaceInfo = await WorkspaceManager.detect(testDir);

      expect(workspaceInfo.isMonorepo).toBe(true);
      expect(workspaceInfo.packages).toHaveLength(3); // root + 2 packages
      expect(workspaceInfo.workspacePatterns).toEqual(["packages/*"]);

      // Check root package
      const rootPackage = workspaceInfo.packages.find((p) => p.isRoot);
      expect(rootPackage).toBeDefined();
      expect(rootPackage!.name).toBe("monorepo-root");

      // Check workspace packages
      const packageA = workspaceInfo.packages.find(
        (p) => p.name === "@monorepo/package-a"
      );
      const packageB = workspaceInfo.packages.find(
        (p) => p.name === "@monorepo/package-b"
      );

      expect(packageA).toBeDefined();
      expect(packageA!.isRoot).toBe(false);
      expect(packageA!.dependencies.lodash).toBe("^4.17.21");

      expect(packageB).toBeDefined();
      expect(packageB!.isRoot).toBe(false);
      expect(packageB!.dependencies.express).toBe("^4.18.0");
      expect(packageB!.dependencies["@monorepo/package-a"]).toBe("^1.0.0");
    });

    it("should detect pnpm workspaces", async () => {
      // Root package.json
      const rootPackageJson = {
        name: "pnpm-monorepo",
        private: true,
      };

      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // pnpm-workspace.yaml
      const pnpmWorkspace = `packages:
  - "apps/*"
  - "libs/*"
`;
      writeFileSync(join(testDir, "pnpm-workspace.yaml"), pnpmWorkspace);
      writeFileSync(join(testDir, "pnpm-lock.yaml"), "");

      // Create workspace packages
      const appsDir = join(testDir, "apps");
      const libsDir = join(testDir, "libs");
      mkdirSync(appsDir, { recursive: true });
      mkdirSync(libsDir, { recursive: true });

      // App package
      const appDir = join(appsDir, "web-app");
      mkdirSync(appDir);
      const appJson = {
        name: "@company/web-app",
        version: "1.0.0",
        dependencies: {
          react: "^18.0.0",
        },
      };
      writeFileSync(
        join(appDir, "package.json"),
        JSON.stringify(appJson, null, 2)
      );

      // Lib package
      const libDir = join(libsDir, "shared-utils");
      mkdirSync(libDir);
      const libJson = {
        name: "@company/shared-utils",
        version: "1.0.0",
        dependencies: {
          lodash: "^4.17.21",
        },
      };
      writeFileSync(
        join(libDir, "package.json"),
        JSON.stringify(libJson, null, 2)
      );

      const workspaceInfo = await WorkspaceManager.detect(testDir);

      expect(workspaceInfo.isMonorepo).toBe(true);
      expect(workspaceInfo.packages).toHaveLength(2); // no root deps
      expect(workspaceInfo.workspacePatterns).toEqual(["apps/*", "libs/*"]);
      expect(workspaceInfo.packageManager).toBe("pnpm");

      const webApp = workspaceInfo.packages.find(
        (p) => p.name === "@company/web-app"
      );
      const sharedUtils = workspaceInfo.packages.find(
        (p) => p.name === "@company/shared-utils"
      );

      expect(webApp).toBeDefined();
      expect(sharedUtils).toBeDefined();
    });
  });

  describe("Helper Methods", () => {
    it("should correctly identify internal dependencies", () => {
      const packages = [
        {
          name: "@company/app",
          path: "",
          packageJson: {},
          dependencies: {},
          devDependencies: {},
          isRoot: false,
        },
        {
          name: "@company/lib",
          path: "",
          packageJson: {},
          dependencies: {},
          devDependencies: {},
          isRoot: false,
        },
      ];

      expect(
        WorkspaceManager.isInternalDependency("@company/app", packages)
      ).toBe(true);
      expect(
        WorkspaceManager.isInternalDependency("@company/lib", packages)
      ).toBe(true);
      expect(WorkspaceManager.isInternalDependency("react", packages)).toBe(
        false
      );
      expect(WorkspaceManager.isInternalDependency("lodash", packages)).toBe(
        false
      );
    });

    it("should find version conflicts across workspaces", () => {
      const packages = [
        {
          name: "package-a",
          path: "",
          packageJson: {},
          dependencies: { lodash: "^4.17.20", react: "^18.0.0" },
          devDependencies: {},
          isRoot: false,
        },
        {
          name: "package-b",
          path: "",
          packageJson: {},
          dependencies: { lodash: "^4.17.21", express: "^4.18.0" },
          devDependencies: {},
          isRoot: false,
        },
        {
          name: "package-c",
          path: "",
          packageJson: {},
          dependencies: { react: "^18.0.0" }, // same version, no conflict
          devDependencies: {},
          isRoot: false,
        },
      ] as WorkspacePackage[];

      const conflicts = WorkspaceManager.findVersionConflicts(packages);

      expect(conflicts).toHaveProperty("lodash");
      expect(conflicts.lodash).toEqual(
        expect.arrayContaining(["^4.17.20", "^4.17.21"])
      );
      expect(conflicts).not.toHaveProperty("react"); // same version across workspaces
      expect(conflicts).not.toHaveProperty("express"); // only in one workspace
    });
  });
});
