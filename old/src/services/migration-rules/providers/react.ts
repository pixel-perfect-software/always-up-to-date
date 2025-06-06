import { MigrationRuleProvider, PackageMigrationInfo } from "../types"

export class ReactMigrationProvider implements MigrationRuleProvider {
  getPackageName(): string {
    return "react"
  }

  getMigrationInfo(): PackageMigrationInfo {
    return {
      name: "react",
      tags: ["framework", "ui"],
      rules: [
        {
          fromVersion: "17.x.x",
          toVersion: "18.x.x",
          priority: 1,
          instructions: `## React 18 Migration Guide

### Key Changes:
1. **Automatic Batching**: Updates are now batched by default
2. **Strict Mode**: New behaviors for useEffect in development
3. **New Root API**: ReactDOM.render is deprecated

### Migration Steps:
1. Update your root element:
   \`\`\`jsx
   // Before
   ReactDOM.render(<App />, document.getElementById('root'));

   // After
   const root = ReactDOM.createRoot(document.getElementById('root'));
   root.render(<App />);
   \`\`\`

2. Update your tests to use the new testing utilities
3. Review useEffect dependencies for double-execution in Strict Mode

### Resources:
- [React 18 Upgrade Guide](https://react.dev/blog/2022/03/08/react-18-upgrade-guide)`,
          breakingChanges: [
            "ReactDOM.render deprecated",
            "Automatic batching changes",
            "Strict Mode behavior changes",
          ],
          automatedFixes: [
            "Replace ReactDOM.render with createRoot",
            "Update test utilities imports",
          ],
        },
        {
          fromVersion: "18.x.x",
          toVersion: "19.x.x",
          priority: 1,
          instructions: `## React 19 Migration Guide

### Key Changes:
1. **React Compiler**: New optimizing compiler
2. **Actions**: Built-in support for async transitions
3. **New Hooks**: useActionState, useOptimistic

### Migration Steps:
1. Enable React Compiler (optional):
   \`\`\`js
   // babel.config.js
   const ReactCompilerConfig = {};

   module.exports = {
     plugins: [
       ['babel-plugin-react-compiler', ReactCompilerConfig],
     ],
   };
   \`\`\`

2. Update form handling with Actions:
   \`\`\`jsx
   function MyForm() {
     const [state, formAction] = useActionState(updateName, null);
     return <form action={formAction}>...</form>;
   }
   \`\`\`

### Resources:
- [React 19 Release Notes](https://react.dev/blog/2024/04/25/react-19)`,
          breakingChanges: [
            "Some legacy APIs removed",
            "StrictMode behavior changes",
            "ref callback timing changes",
          ],
        },
      ],
      repositoryUrl: "https://github.com/facebook/react",
      changelogUrl: "https://github.com/facebook/react/blob/main/CHANGELOG.md",
      documentationUrl: "https://react.dev",
    }
  }
}
