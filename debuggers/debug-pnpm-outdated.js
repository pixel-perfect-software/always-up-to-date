const { exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");

const execPromise = promisify(exec);

async function testPnpmOutdated() {
  const testPath = path.join(__dirname, "../test-monorepos/test-pnpm-catalog");

  console.log("🔍 Testing pnpm outdated commands...\n");

  // Test different pnpm outdated commands
  const commands = [
    "pnpm outdated --format json",
    "pnpm outdated --format json --recursive",
  ];

  for (const command of commands) {
    console.log(`\n📦 Testing: ${command}`);
    console.log("=".repeat(50));

    try {
      const { stdout, stderr } = await execPromise(command, { cwd: testPath });

      console.log("✅ Command succeeded");
      console.log("📤 STDOUT length:", stdout.length);
      console.log("⚠️  STDERR length:", stderr.length);

      if (stderr) {
        console.log("⚠️  STDERR content:");
        console.log(stderr);
        console.log("---");
      }

      console.log("📤 STDOUT (first 200 chars):");
      console.log(stdout.substring(0, 200));

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(stdout);
        console.log("✅ JSON parsing succeeded");
        console.log("📊 Number of packages:", Object.keys(parsed).length);

        for (const [pkg, info] of Object.entries(parsed)) {
          console.log(`  ${pkg}: ${info.current} -> ${info.latest}`);
        }
      } catch (parseError) {
        console.log("❌ JSON parsing failed:", parseError.message);
        console.log("📤 Raw stdout:");
        console.log(JSON.stringify(stdout));
      }
    } catch (error) {
      console.log("❌ Command failed:");
      console.log("Error message:", error.message);
      console.log("Exit code:", error.code);

      if (error.stdout) {
        console.log("📤 Error stdout:");
        console.log(error.stdout);
      }

      if (error.stderr) {
        console.log("⚠️  Error stderr:");
        console.log(error.stderr);
      }
    }
  }
}

testPnpmOutdated().catch(console.error);
