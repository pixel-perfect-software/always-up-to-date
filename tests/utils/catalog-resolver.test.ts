import { CatalogResolver } from "../../src/utils/catalog-resolver";
import { WorkspaceInfo } from "../../src/types/workspace";

describe("CatalogResolver", () => {
  describe("resolveDependencyVersion", () => {
    it("should resolve catalog references to actual versions", () => {
      const workspaceInfo: WorkspaceInfo = {
        isMonorepo: true,
        rootPath: "/test",
        packageManager: "pnpm",
        workspacePatterns: ["packages/*"],
        catalog: {
          react: "^18.2.0",
          typescript: "^5.3.0",
        },
        packages: [
          {
            name: "package-a",
            path: "/test/packages/a",
            packageJson: {},
            dependencies: {
              react: "catalog:",
            },
            devDependencies: {},
            isRoot: false,
          },
          {
            name: "package-b",
            path: "/test/packages/b",
            packageJson: {},
            dependencies: {
              react: "catalog:",
            },
            devDependencies: {},
            isRoot: false,
          },
        ],
      };

      const resolved = CatalogResolver.resolveDependencyVersion(
        "react",
        workspaceInfo
      );

      expect(resolved).toEqual({
        name: "react",
        version: "^18.2.0",
        source: "catalog",
        originalSpecifier: "catalog:",
      });
    });

    it("should prioritize direct versions over catalog references", () => {
      const workspaceInfo: WorkspaceInfo = {
        isMonorepo: true,
        rootPath: "/test",
        packageManager: "pnpm",
        workspacePatterns: ["packages/*"],
        catalog: {
          react: "^18.2.0",
        },
        packages: [
          {
            name: "package-a",
            path: "/test/packages/a",
            packageJson: {},
            dependencies: {
              react: "catalog:",
            },
            devDependencies: {},
            isRoot: false,
          },
          {
            name: "package-b",
            path: "/test/packages/b",
            packageJson: {},
            dependencies: {
              react: "18.3.0", // Direct specific version
            },
            devDependencies: {},
            isRoot: false,
          },
        ],
      };

      const resolved = CatalogResolver.resolveDependencyVersion(
        "react",
        workspaceInfo
      );

      expect(resolved).toEqual({
        name: "react",
        version: "18.3.0",
        source: "direct",
        originalSpecifier: "18.3.0",
      });
    });

    it("should prioritize specific versions over version ranges", () => {
      const workspaceInfo: WorkspaceInfo = {
        isMonorepo: true,
        rootPath: "/test",
        packageManager: "pnpm",
        workspacePatterns: ["packages/*"],
        catalog: {},
        packages: [
          {
            name: "package-a",
            path: "/test/packages/a",
            packageJson: {},
            dependencies: {
              react: "^18.2.0", // Version range
            },
            devDependencies: {},
            isRoot: false,
          },
          {
            name: "package-b",
            path: "/test/packages/b",
            packageJson: {},
            dependencies: {
              react: "18.3.0", // Specific version
            },
            devDependencies: {},
            isRoot: false,
          },
        ],
      };

      const resolved = CatalogResolver.resolveDependencyVersion(
        "react",
        workspaceInfo
      );

      expect(resolved).toEqual({
        name: "react",
        version: "18.3.0",
        source: "direct",
        originalSpecifier: "18.3.0",
      });
    });

    it("should return null if dependency not found", () => {
      const workspaceInfo: WorkspaceInfo = {
        isMonorepo: true,
        rootPath: "/test",
        packageManager: "pnpm",
        workspacePatterns: ["packages/*"],
        catalog: {},
        packages: [
          {
            name: "package-a",
            path: "/test/packages/a",
            packageJson: {},
            dependencies: {},
            devDependencies: {},
            isRoot: false,
          },
        ],
      };

      const resolved = CatalogResolver.resolveDependencyVersion(
        "react",
        workspaceInfo
      );

      expect(resolved).toBeNull();
    });
  });

  describe("getCatalogDependencies", () => {
    it("should return all dependencies using catalog references", () => {
      const workspaceInfo: WorkspaceInfo = {
        isMonorepo: true,
        rootPath: "/test",
        packageManager: "pnpm",
        workspacePatterns: ["packages/*"],
        catalog: {
          react: "^18.2.0",
          typescript: "^5.3.0",
        },
        packages: [
          {
            name: "package-a",
            path: "/test/packages/a",
            packageJson: {},
            dependencies: {
              react: "catalog:",
              lodash: "^4.17.0", // Direct dependency
            },
            devDependencies: {
              typescript: "catalog:",
            },
            isRoot: false,
          },
          {
            name: "package-b",
            path: "/test/packages/b",
            packageJson: {},
            dependencies: {
              react: "catalog:",
            },
            devDependencies: {},
            isRoot: false,
          },
        ],
      };

      const catalogDeps = CatalogResolver.getCatalogDependencies(workspaceInfo);

      expect(catalogDeps.size).toBe(2);
      expect(catalogDeps.get("react")).toEqual(
        new Set(["package-a", "package-b"])
      );
      expect(catalogDeps.get("typescript")).toEqual(new Set(["package-a"]));
      expect(catalogDeps.has("lodash")).toBe(false);
    });
  });

  describe("shouldUpdateCatalog", () => {
    it("should return true when highest priority is catalog", () => {
      const workspaceInfo: WorkspaceInfo = {
        isMonorepo: true,
        rootPath: "/test",
        packageManager: "pnpm",
        workspacePatterns: ["packages/*"],
        catalog: {
          react: "^18.2.0",
        },
        packages: [
          {
            name: "package-a",
            path: "/test/packages/a",
            packageJson: {},
            dependencies: {
              react: "catalog:",
            },
            devDependencies: {},
            isRoot: false,
          },
        ],
      };

      const shouldUpdate = CatalogResolver.shouldUpdateCatalog(
        "react",
        workspaceInfo
      );

      expect(shouldUpdate).toBe(true);
    });

    it("should return false when highest priority is direct", () => {
      const workspaceInfo: WorkspaceInfo = {
        isMonorepo: true,
        rootPath: "/test",
        packageManager: "pnpm",
        workspacePatterns: ["packages/*"],
        catalog: {
          react: "^18.2.0",
        },
        packages: [
          {
            name: "package-a",
            path: "/test/packages/a",
            packageJson: {},
            dependencies: {
              react: "catalog:",
            },
            devDependencies: {},
            isRoot: false,
          },
          {
            name: "package-b",
            path: "/test/packages/b",
            packageJson: {},
            dependencies: {
              react: "18.3.0", // Direct version takes priority
            },
            devDependencies: {},
            isRoot: false,
          },
        ],
      };

      const shouldUpdate = CatalogResolver.shouldUpdateCatalog(
        "react",
        workspaceInfo
      );

      expect(shouldUpdate).toBe(false);
    });
  });

  describe("getDirectUpdateWorkspaces", () => {
    it("should return workspaces with direct dependencies", () => {
      const workspaceInfo: WorkspaceInfo = {
        isMonorepo: true,
        rootPath: "/test",
        packageManager: "pnpm",
        workspacePatterns: ["packages/*"],
        catalog: {
          react: "^18.2.0",
        },
        packages: [
          {
            name: "package-a",
            path: "/test/packages/a",
            packageJson: {},
            dependencies: {
              react: "catalog:",
            },
            devDependencies: {},
            isRoot: false,
          },
          {
            name: "package-b",
            path: "/test/packages/b",
            packageJson: {},
            dependencies: {
              react: "^18.0.0", // Direct dependency
            },
            devDependencies: {},
            isRoot: false,
          },
          {
            name: "package-c",
            path: "/test/packages/c",
            packageJson: {},
            dependencies: {},
            devDependencies: {
              react: "18.3.0", // Direct dev dependency
            },
            isRoot: false,
          },
        ],
      };

      const directWorkspaces = CatalogResolver.getDirectUpdateWorkspaces(
        "react",
        workspaceInfo
      );

      expect(directWorkspaces).toEqual([
        "/test/packages/b",
        "/test/packages/c",
      ]);
    });
  });
});
