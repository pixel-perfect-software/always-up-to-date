#!/bin/bash

# Pre-publishing verification script
echo "🔍 Running pre-publishing verification..."

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
  echo "❌ Not in a valid npm project directory"
  exit 1
fi

# Check if package.json has required fields
echo "📦 Checking package.json..."
if ! grep -q '"name"' package.json; then
  echo "❌ Missing 'name' field in package.json"
  exit 1
fi

if ! grep -q '"version"' package.json; then
  echo "❌ Missing 'version' field in package.json"
  exit 1
fi

if ! grep -q '"bin"' package.json; then
  echo "❌ Missing 'bin' field in package.json"
  exit 1
fi

# Build the project
echo "🔨 Building project..."
pnpm run build
if [ $? -ne 0 ]; then
  echo "❌ Build failed"
  exit 1
fi

# Check if CLI executable exists and is executable
if [ ! -f "dist/cli.js" ]; then
  echo "❌ CLI executable not found at dist/cli.js"
  exit 1
fi

# Test CLI functionality
echo "🧪 Testing CLI functionality..."
node dist/cli.js --version >/dev/null
if [ $? -ne 0 ]; then
  echo "❌ CLI version check failed"
  exit 1
fi

node dist/cli.js --help >/dev/null
if [ $? -ne 0 ]; then
  echo "❌ CLI help check failed"
  exit 1
fi

# Check if all required files exist
echo "📁 Checking required files..."
required_files=("README.md" "LICENSE" "package.json")
for file in "${required_files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "❌ Missing required file: $file"
    exit 1
  fi
done

# Run tests
echo "🔬 Running tests..."
pnpm test
if [ $? -ne 0 ]; then
  echo "❌ Tests failed"
  exit 1
fi

# Check package contents
echo "📋 Checking package contents..."
npm pack --dry-run >/dev/null
if [ $? -ne 0 ]; then
  echo "❌ Package check failed"
  exit 1
fi

echo "✅ All checks passed! Ready for publishing."
echo ""
echo "🚀 To publish:"
echo "   npm login"
echo "   npm publish"
echo ""
echo "📝 To create a release:"
echo "   git tag v\$(node -p \"require('./package.json').version\")"
echo "   git push origin --tags"
