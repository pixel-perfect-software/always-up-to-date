export interface MigrationRule {
  fromVersion: string;
  toVersion: string;
  instructions: string;
  breakingChanges: string[];
  automatedFixes?: string[];
  priority?: number; // Higher priority rules are checked first
}

export interface PackageMigrationInfo {
  name: string;
  rules: MigrationRule[];
  repositoryUrl?: string;
  changelogUrl?: string;
  documentationUrl?: string;
  tags?: string[]; // e.g., ['framework', 'testing', 'linting']
}

export interface MigrationRuleProvider {
  getPackageName(): string;
  getMigrationInfo(): PackageMigrationInfo;
}
