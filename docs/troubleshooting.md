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

**Problem**: `command not found: alwaysuptodate`

**Solutions**:

1. **Use npx**: `npx always-up-to-date check`
2. **Check PATH**: Ensure global npm bin is in PATH
3. **Reinstall**: `npm uninstall -g always-up-to-date && npm install -g always-up-to-date`

## Authentication Issues

### GitHub Token Problems

**Problem**: `Authentication failed` or `Bad credentials`

**Solutions**:

1. **Verify token**: Check token exists and has correct scopes
2. **Test token**: `curl -H "Authorization: token YOUR_TOKEN" https://api.github.com/user`
3. **Regenerate token**: Create new token with `repo` and `workflow` scopes

### Token Detection Issues

**Problem**: Tool doesn't find your GitHub token

**Solutions**:

1. **Check environment**: `echo $GITHUB_TOKEN`
2. **Check .env file**: Ensure `.env` exists and contains `GITHUB_TOKEN=...`
3. **Use explicit flag**: `--token your_token_here`

## Update Issues

### Dependency Resolution Errors

**Problem**: `ERESOLVE unable to resolve dependency tree`

**Solutions**:

1. **Use legacy resolver**: `npm install --legacy-peer-deps`
2. **Clear cache**: `npm cache clean --force`
3. **Delete node_modules**: `rm -rf node_modules package-lock.json && npm install`

### Package Lock Conflicts

**Problem**: Lock file conflicts after updates

**Solutions**:

1. **Delete lock file**: Remove and regenerate lock file
2. **Use correct package manager**: Ensure using the same manager (npm/yarn/pnpm)
3. **Rollback**: `npx alwaysuptodate rollback`

## Configuration Issues

### Config File Not Found

**Problem**: Configuration not being applied

**Solutions**:

1. **Check location**: Ensure `.alwaysuptodate.json` is in project root
2. **Validate JSON**: Use JSON validator to check syntax
3. **Check spelling**: Ensure config keys are spelled correctly

### Package Rules Not Working

**Problem**: Package-specific rules not being applied

**Solutions**:

1. **Check patterns**: Ensure package names/patterns are correct
2. **Test patterns**: Use glob tester to verify patterns
3. **Check priority**: Later rules override earlier ones

## Performance Issues

### Slow Updates

**Problem**: Updates taking too long

**Solutions**:

1. **Reduce batch size**: `--batch-size 5`
2. **Disable parallel**: Set `"parallelUpdates": false`
3. **Use specific registry**: Configure npm registry

### Memory Issues

**Problem**: Out of memory errors

**Solutions**:

1. **Increase memory**: `NODE_OPTIONS="--max-old-space-size=4096"`
2. **Reduce scope**: Use `--only-direct` flag
3. **Process in batches**: Smaller batch sizes

## GitHub Integration Issues

### PR Creation Fails

**Problem**: Cannot create pull requests

**Solutions**:

1. **Check permissions**: Ensure token has `repo` scope
2. **Verify repository**: Confirm repository exists and accessible
3. **Check branch protection**: Ensure base branch allows PR creation

### Repository Detection Fails

**Problem**: Cannot detect GitHub repository

**Solutions**:

1. **Check git remote**: `git remote -v`
2. **Use explicit flag**: `--repository owner/repo`
3. **Check package.json**: Ensure repository field is set

## Package Manager Issues

### Wrong Package Manager Detected

**Problem**: Tool uses wrong package manager

**Solutions**:

1. **Remove other lock files**: Delete unused lock files
2. **Use explicit flag**: `--package-manager npm`
3. **Check detection logic**: Verify which lock files exist

### Lock File Corruption

**Problem**: Package manager complains about lock file

**Solutions**:

1. **Regenerate lock file**: Delete and reinstall
2. **Use package manager repair**: `npm audit fix` or `yarn install --check-files`
3. **Rollback changes**: `npx alwaysuptodate rollback`

## Common Error Messages

### `ENOENT: no such file or directory`

**Cause**: Missing package.json or invalid project path

**Solution**: Ensure you're in a valid Node.js project directory

### `Request failed with status code 404`

**Cause**: Package not found on npm registry

**Solution**: Check package name spelling or availability

### `EPERM: operation not permitted`

**Cause**: Permission issues on Windows

**Solution**: Run terminal as administrator or use different installation method

### `Cannot read property 'version' of undefined`

**Cause**: Malformed package.json

**Solution**: Validate package.json syntax and structure

## Getting Help

If you're still experiencing issues:

1. **Check existing issues**: [GitHub Issues](https://github.com/your-repo/always-up-to-date/issues)
2. **Create new issue**: Include error message, OS, Node.js version
3. **Enable verbose logging**: Use `--verbose` flag for detailed output
4. **Community support**: Join our Discord or discussions

### Useful Debug Information

When reporting issues, include:

```bash
# System information
node --version
npm --version
npx alwaysuptodate --version

# Project information
ls -la package*.json
cat package.json | head -20

# Error with verbose output
npx alwaysuptodate check --verbose
```
