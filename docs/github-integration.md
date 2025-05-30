# GitHub Integration

## Authentication

Authentication is handled automatically! The tool detects credentials from multiple sources in order of priority:

1. Command line (`--token` flag)
2. VS Code GitHub authentication
3. Environment variables (`GITHUB_TOKEN`)
4. Environment files (`.env`)

## Setup Methods

### Option 1: Environment Variable

```bash
export GITHUB_TOKEN="your_token_here"
npx alwaysuptodate auto --createIssue
```

### Option 2: Environment File

Create a `.env` file in your project root:

```bash
echo "GITHUB_TOKEN=your_token_here" > .env
```

### Option 3: Command Line Flag

```bash
npx alwaysuptodate auto --createIssue --token your_token_here
```

### Option 4: VS Code Integration

If you're using VS Code with GitHub authentication, the tool will automatically detect and use those credentials.

## Creating a GitHub Token

1. Go to [GitHub Settings > Personal Access Tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Give it a descriptive name like "always-up-to-date"
4. Select the following scopes:
   - `repo` (Full control of private repositories)
   - `workflow` (Update GitHub Action workflows)
5. Click "Generate token"
6. Copy the token immediately (you won't see it again)

## Pull Request Features

### Automatic PR Creation

```bash
npx alwaysuptodate auto --createIssue
```

This will:

- Create a new branch for updates
- Update dependencies based on your configuration
- Generate detailed PR description with:
  - List of updated packages
  - Migration guides for popular packages
  - Breaking change warnings
  - Security vulnerability fixes

### Repository Detection

The tool automatically detects your GitHub repository from:

- Git remote URLs
- Package.json repository field
- Current directory git configuration

You can override with the `--repository` flag:

```bash
npx alwaysuptodate auto --createIssue --repository "owner/repo-name"
```

### Batch Updates

Control how many packages are updated per PR:

```bash
# Update 5 packages per batch
npx alwaysuptodate auto --createIssue --batch-size 5

# Create separate PRs for each major update
npx alwaysuptodate auto --createIssue --separate-prs
```

## CI/CD Integration

### GitHub Actions Workflow

Create `.github/workflows/update-dependencies.yml`:

```yaml
name: Update Dependencies
on:
  schedule:
    - cron: "0 9 * * 1" # Weekly on Monday at 9 AM
  workflow_dispatch: # Allow manual triggering

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "18"

      - name: Update Dependencies
        run: npx always-up-to-date auto --createIssue
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Advanced Workflow

For more control over the update process:

```yaml
name: Automated Dependency Updates
on:
  schedule:
    - cron: "0 9 * * 1"

jobs:
  check:
    runs-on: ubuntu-latest
    outputs:
      has-updates: ${{ steps.check.outputs.has-updates }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - id: check
        run: |
          result=$(npx always-up-to-date check --format json)
          if [ "$result" != "[]" ]; then
            echo "has-updates=true" >> $GITHUB_OUTPUT
          else
            echo "has-updates=false" >> $GITHUB_OUTPUT
          fi

  update:
    needs: check
    if: needs.check.outputs.has-updates == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npx always-up-to-date auto --createIssue --separate-prs
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Security Considerations

- **Token Scope**: Only grant the minimum required scopes (`repo` and `workflow`)
- **Token Rotation**: Regularly rotate your GitHub tokens
- **Organization Settings**: Ensure your organization allows token access if working in an org
- **Branch Protection**: Consider your branch protection rules when auto-creating PRs
