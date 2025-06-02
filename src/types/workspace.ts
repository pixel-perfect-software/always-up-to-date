export interface WorkspacePackage {
  name: string;
  path: string;
  packageJson: any;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  isRoot: boolean;
}

export interface WorkspaceInfo {
  isMonorepo: boolean;
  rootPath: string;
  packages: WorkspacePackage[];
  workspacePatterns: string[];
  packageManager: "npm" | "yarn" | "pnpm";
}

export interface WorkspaceDependencyUpdate {
  name: string;
  currentVersion: string;
  installedVersion?: string;
  newVersion: string;
  hasBreakingChanges: boolean;
  migrationInstructions?: string;
  workspaceName: string;
  workspacePath: string;
  affectsOtherWorkspaces: boolean;
  internalDependency: boolean;
}

export interface WorkspaceConfig {
  // Monorepo behavior
  processAllWorkspaces: boolean;
  syncVersionsAcrossWorkspaces: boolean;
  createSeparatePRsPerWorkspace: boolean;

  // Workspace-specific rules
  workspaceRules: {
    pattern: string; // workspace name pattern
    ignoredPackages?: string[];
    updateStrategy?: "major" | "minor" | "patch" | "none";
    autoUpdate?: boolean;
  }[];

  // Internal dependency handling
  updateInternalDependencies: boolean;
  maintainWorkspaceVersionSync: boolean;
}
