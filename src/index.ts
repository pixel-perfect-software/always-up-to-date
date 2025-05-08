import { run } from "./cli";

// Main entry point for the application
const main = async () => {
  try {
    await run();
  } catch (error) {
    console.error("An error occurred:", error);
    process.exit(1);
  }
};

// Execute if run directly
if (require.main === module) {
  main();
}

// Export for use as a library
export { run, main };
