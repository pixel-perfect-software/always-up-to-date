# Troubleshooting Guide

Common issues and solutions for Always Up To Date.

## Installation Issues

### Permission Errors During Global Install

**Problem**: `EACCES` permission errors when installing globally

**Solution**:

```bash
# Configure npm to use a different directory
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH

# Add to your shell profile (.bashrc, .zshrc, etc.)
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
```

### Package Not Found

**Problem**: `command not found: autd`

**Solutions**:

1. **Use npx**: `npx @pixel-perfect-software/always-up-to-date check`
2. **Check PATH**: Ensure global npm bin is in PATH
3. **Reinstall**: `npm uninstall -g @pixel-perfect-software/always-up-to-date && npm install -g @pixel-perfect-software/always-up-to-date`

## Package Manager Detection Issues

### Wrong Package Manager Detected

**Problem**: Tool detects wrong package manager or fails to detect

**Solutions**:

1. **Check lock files**: Ensure only one type of lock file exists:
   - `package-lock.json` for npm
   - `yarn.lock` for yarn
   - `pnpm-lock.yaml` for pnpm
   - `bun.lock` for bun
2. **Remove conflicting lock files**: Delete unused lock files
3. **Verify package.json**: Ensure valid package.json exists

### No Package Manager Detected

**Problem**: "No package manager detected in the current directory"

**Solutions**:

1. **Check working directory**: Ensure you're in a Node.js project directory
2. **Verify lock file exists**: At least one lock file must be present
3. **Check file permissions**: Ensure lock files are readable

## Update Issues

### Command Execution Fails

**Problem**: Package manager commands fail during check/update

**Solutions**:

1. **Check package manager installation**: Verify npm/yarn/pnpm/bun is installed
2. **Test manually**: Try running the same command manually
3. **Check permissions**: Ensure you have write permissions to the project
4. **Clear cache**: Clear your package manager's cache

### Dependency Resolution Errors

**Problem**: `ERESOLVE unable to resolve dependency tree`

**Solutions**:

1. **Use legacy resolver**: `npm install --legacy-peer-deps`
2. **Clear cache**: `npm cache clean --force`
3. **Delete node_modules**: `rm -rf node_modules package-lock.json && npm install`

### Network Issues

**Problem**: Package manager cannot reach registry

**Solutions**:

1. **Check network connection**: Verify internet connectivity
2. **Check registry**: `npm config get registry`
3. **Try different registry**: `npm config set registry https://registry.npmjs.org/`

## Workspace Issues

### Workspace Not Detected

**Problem**: npm workspace not detected even though it exists

**Solutions**:

1. **Check package.json**: Ensure `workspaces` field is present and valid
2. **Verify workspace structure**: Ensure workspace packages have valid package.json files
3. **Test workspace**: Run `npm ls --workspaces` to verify workspace setup

### Workspace Updates Fail

**Problem**: Updates fail in workspace environment

**Solutions**:

1. **Check workspace permissions**: Ensure write access to all workspace packages
2. **Verify workspace patterns**: Check that workspace patterns in package.json are correct
3. **Test individual packages**: Try updating individual workspace packages manually

## Command Issues

### Check Command Shows No Output

**Problem**: `check` command runs but shows no outdated packages

**Solutions**:

1. **All packages up to date**: This may be normal - all dependencies are current
2. **Check command execution**: Verify the underlying package manager command works
3. **Manual verification**: Run `npm outdated` (or equivalent) manually

### Update Command Does Nothing

**Problem**: `update` command runs but doesn't update packages

**Solutions**:

1. **No outdated packages**: Check command first to see if updates are available
2. **Update filtering**: The tool filters updates for safety - some may be skipped
3. **Check permissions**: Ensure write permissions to package.json and lock files

## Common Error Messages

### `ENOENT: no such file or directory`

**Cause**: Missing package.json or working in wrong directory

**Solution**: Ensure you're in a valid Node.js project directory with package.json

### `Command execution failed`

**Cause**: Underlying package manager command failed

**Solution**: Check the error message and try running the package manager command manually

### `An error occurred while checking for outdated packages`

**Cause**: Package manager command failed or returned invalid output

**Solution**: Verify package manager installation and project structure

### `An unknown error occurred while running the command`

**Cause**: Unexpected error during command execution

**Solution**: Check the detailed error message and verify project setup

## Performance Issues

### Slow Command Execution

**Problem**: Commands take a long time to complete

**Solutions**:

1. **Network speed**: Package manager needs to check registry for latest versions
2. **Large projects**: More dependencies = longer check times
3. **Registry issues**: Try different npm registry if available

### Memory Issues

**Problem**: Out of memory errors

**Solutions**:

1. **Increase memory**: `NODE_OPTIONS="--max-old-space-size=4096"`
2. **Large monorepos**: Consider checking smaller subsets of packages

## Getting Debug Information

### Enable Verbose Output

Currently, the tool provides basic logging. For debugging:

1. **Check command output**: Look for error messages in the console
2. **Test manually**: Run the underlying package manager commands manually
3. **Verify project structure**: Ensure valid package.json and lock files

### Manual Testing

Test the underlying commands that the tool uses:

```bash
# For npm projects
npm outdated --json
npm outdated --json --workspaces  # For workspaces

# For yarn projects (coming soon)
yarn outdated --json

# For pnpm projects (coming soon)
pnpm outdated --format json

# For bun projects (coming soon)
bun outdated
```

## Getting Help

If you're still experiencing issues:

1. **Check existing issues**: [GitHub Issues](https://github.com/pixel-perfect-software/always-up-to-date/issues)
2. **Create new issue**: Include error message, OS, Node.js version, and package manager
3. **Provide context**: Include your project structure and relevant config files

### Useful Information for Bug Reports

When reporting issues, include:

```bash
# System information
node --version
npm --version
autd --version

# Project information
ls -la package*.json *.lock *.yaml
cat package.json | head -20

# Package manager test
npm outdated --json  # or yarn/pnpm equivalent
```

## Feature Limitations

Current limitations of the tool:

- Only npm workspaces are fully supported (yarn, pnpm, bun coming soon)
- No configuration file support yet
- No GitHub integration yet
- No interactive selection mode yet
- No rollback functionality yet
- Basic error handling and logging

These features are planned for future releases.
