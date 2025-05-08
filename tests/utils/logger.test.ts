// filepath: /always-up-to-date/always-up-to-date/tests/utils/logger.test.ts
import { logger } from "../../src/utils/logger";

describe("Logger Utility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should log messages at info level", () => {
    console.log = jest.fn();
    logger.info("This is an info message");
    expect(console.log).toHaveBeenCalledWith("INFO: This is an info message");
  });

  test("should log messages at warning level", () => {
    console.warn = jest.fn();
    logger.warn("This is a warning message");
    expect(console.warn).toHaveBeenCalledWith("WARNING: This is a warning message");
  });

  test("should log messages at error level", () => {
    console.error = jest.fn();
    logger.error("This is an error message");
    expect(console.error).toHaveBeenCalledWith("ERROR: This is an error message");
  });

  test("should handle different log levels", () => {
    logger.setLevel("warn");
    console.log = jest.fn();
    logger.info("This should not be logged");
    expect(console.log).not.toHaveBeenCalled();

    logger.warn("This should be logged");
    expect(console.warn).toHaveBeenCalledWith("WARNING: This should be logged");
  });
});