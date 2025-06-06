export interface WorkspacePackage {
  name: string
  path: string
  packageJson: any
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  isRoot: boolean
}

export interface WorkspaceInfo {
  isMonorepo: boolean
  rootPath: string
  packages: WorkspacePackage[]
  workspacePatterns: string[]
  packageManager: "npm" | "yarn" | "pnpm"
  catalog?: Record<string, string> // pnpm catalog versions
}

export interface ResolvedDependency {
  name: string
  version: string
  source: "direct" | "catalog"
  originalSpecifier: string
}

export interface VersionInfo {
  specified: string
  resolved: string
  source: "direct" | "catalog"
  workspace: string
}
