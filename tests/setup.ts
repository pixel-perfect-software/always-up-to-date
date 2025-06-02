/**
 * Jest global setup file for memory leak prevention
 */

// Global timeout tracking
const activeTimeouts = new Set<ReturnType<typeof setTimeout>>();
const activeIntervals = new Set<ReturnType<typeof setInterval>>();

// Store original timer functions
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;

// Override setTimeout to track timeouts
(global as any).setTimeout = (
  callback: (...args: any[]) => void,
  ms?: number,
  ...args: any[]
) => {
  const timeoutId = originalSetTimeout(callback, ms, ...args);
  activeTimeouts.add(timeoutId);
  return timeoutId;
};

// Override clearTimeout to track cleanup
(global as any).clearTimeout = (timeoutId: any) => {
  activeTimeouts.delete(timeoutId);
  return originalClearTimeout(timeoutId);
};

// Override setInterval to track intervals
(global as any).setInterval = (
  callback: (...args: any[]) => void,
  ms?: number,
  ...args: any[]
) => {
  const intervalId = originalSetInterval(callback, ms, ...args);
  activeIntervals.add(intervalId);
  return intervalId;
};

// Override clearInterval to track cleanup
(global as any).clearInterval = (intervalId: any) => {
  activeIntervals.delete(intervalId);
  return originalClearInterval(intervalId);
};

// Global cleanup after each test
afterEach(() => {
  // Clear all active timeouts
  activeTimeouts.forEach((timeoutId) => {
    originalClearTimeout(timeoutId);
  });
  activeTimeouts.clear();

  // Clear all active intervals
  activeIntervals.forEach((intervalId) => {
    originalClearInterval(intervalId);
  });
  activeIntervals.clear();

  // Force garbage collection if available
  if ((global as any).gc) {
    (global as any).gc();
  }
});

// Global cleanup after all tests
afterAll(() => {
  // Final cleanup of any remaining timers
  activeTimeouts.forEach((timeoutId) => {
    originalClearTimeout(timeoutId);
  });
  activeTimeouts.clear();

  activeIntervals.forEach((intervalId) => {
    originalClearInterval(intervalId);
  });
  activeIntervals.clear();

  // Force garbage collection if available
  if ((global as any).gc) {
    (global as any).gc();
  }
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.warn("Unhandled Promise Rejection at:", promise, "reason:", reason);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});
