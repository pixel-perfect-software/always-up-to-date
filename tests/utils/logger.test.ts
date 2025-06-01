// filepath: /always-up-to-date/always-up-to-date/tests/utils/logger.test.ts
import { logger, log } from "../../src/utils/logger";
import Logger from "../../src/utils/logger";
import { AlwaysUpToDateError } from "../../src/utils/errors";
import fs from "fs";

// Mock fs module
jest.mock("fs");
const mockAppendFile = fs.appendFile as jest.MockedFunction<
  typeof fs.appendFile
>;

describe("Logger Utility", () => {
  let mockConsoleLog: jest.SpyInstance;
  let mockConsoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConsoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
    mockConsoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
  });

  describe("Basic logging functionality", () => {
    test("should log messages at info level", () => {
      logger.info("This is an info message");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[INFO]")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("This is an info message")
      );
    });

    test("should log messages at warning level", () => {
      logger.warn("This is a warning message");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[WARN]")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("This is a warning message")
      );
    });

    test("should log messages at error level", () => {
      logger.error("This is an error message");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[ERROR]")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("This is an error message")
      );
    });

    test("should log messages at debug level", () => {
      logger.setLevel("debug");
      logger.debug("This is a debug message");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[DEBUG]")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("This is a debug message")
      );
    });

    test("should use generic log method", () => {
      logger.log("Generic log message", "info");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[INFO]")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Generic log message")
      );
    });

    test("should default to info level for generic log", () => {
      logger.log("Default level message");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[INFO]")
      );
    });
  });

  describe("Log level filtering", () => {
    test("should handle different log levels", () => {
      logger.setLevel("warn");

      logger.info("This should not be logged");
      expect(mockConsoleLog).not.toHaveBeenCalled();

      logger.warn("This should be logged");
      expect(mockConsoleLog).toHaveBeenCalled();
    });

    test("should respect error level filtering", () => {
      logger.setLevel("error");

      logger.debug("Debug message");
      logger.info("Info message");
      logger.warn("Warning message");
      expect(mockConsoleLog).not.toHaveBeenCalled();

      logger.error("Error message");
      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    });

    test("should show all messages at debug level", () => {
      logger.setLevel("debug");

      logger.error("Error message");
      logger.warn("Warning message");
      logger.info("Info message");
      logger.debug("Debug message");

      expect(mockConsoleLog).toHaveBeenCalledTimes(4);
    });
  });

  describe("Message formatting", () => {
    test("should format Error objects", () => {
      const error = new Error("Test error message");
      logger.error(error);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Test error message")
      );
    });

    test("should format Error objects with stack trace in debug mode", () => {
      logger.setLevel("debug");
      const error = new Error("Test error with stack");
      error.stack = "Error: Test error\n    at somewhere";

      logger.error(error);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Test error with stack")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Stack:")
      );
    });

    test("should format AlwaysUpToDateError objects", () => {
      const customError = new AlwaysUpToDateError(
        "Custom error message",
        "CUSTOM_CODE"
      );

      logger.error(customError);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Custom error message")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[CUSTOM_CODE]")
      );
    });

    test("should format AlwaysUpToDateError with original error in debug mode", () => {
      logger.setLevel("debug");
      const originalError = new Error("Original error");
      originalError.stack = "Error: Original\n    at somewhere";

      const customError = new AlwaysUpToDateError(
        "Wrapper error",
        "WRAPPER_CODE",
        originalError
      );

      logger.error(customError);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Wrapper error")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Original error: Original error")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Stack: Error: Original")
      );
    });

    test("should format object messages as JSON", () => {
      const testObject = { key: "value", nested: { prop: 123 } };
      logger.info(testObject);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('"key": "value"')
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('"nested": {')
      );
    });

    test("should include timestamp in log output", () => {
      logger.info("Test message");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringMatching(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/)
      );
    });
    test("should handle unknown log levels gracefully", () => {
      // Unknown levels don't have a numeric value, so they won't be logged
      // unless we modify the comparison logic
      logger.log("Unknown level message", "unknown");

      // Should not log unknown levels
      expect(mockConsoleLog).not.toHaveBeenCalled();
      // Should not crash and use default color function
    });
  });

  describe("Static logToFile method", () => {
    test("should write to log file successfully", () => {
      mockAppendFile.mockImplementation((path, data, callback) => {
        if (typeof callback === "function") {
          callback(null);
        }
      });

      Logger.logToFile("Test file message", "info");

      expect(mockAppendFile).toHaveBeenCalledWith(
        expect.stringContaining("always-up-to-date.log"),
        expect.stringContaining("[INFO]: Test file message"),
        expect.any(Function)
      );
    });

    test("should handle file write errors", () => {
      const writeError = new Error("Write permission denied");
      mockAppendFile.mockImplementation((path, data, callback) => {
        if (typeof callback === "function") {
          callback(writeError);
        }
      });

      Logger.logToFile("Test error message", "error");

      expect(mockConsoleError).toHaveBeenCalledWith(
        "Failed to write to log file:",
        writeError
      );
    });

    test("should default to info level for file logging", () => {
      mockAppendFile.mockImplementation((path, data, callback) => {
        if (typeof callback === "function") {
          callback(null);
        }
      });

      Logger.logToFile("Default level file message");

      expect(mockAppendFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("[INFO]:"),
        expect.any(Function)
      );
    });

    test("should include timestamp in file log", () => {
      mockAppendFile.mockImplementation((path, data, callback) => {
        if (typeof callback === "function") {
          callback(null);
        }
      });

      Logger.logToFile("Timestamp test", "debug");

      expect(mockAppendFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(
          /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/
        ),
        expect.any(Function)
      );
    });
  });

  describe("Exported convenience functions", () => {
    test("should use log function for backwards compatibility", () => {
      log("Compatibility test message", "warn");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[WARN]")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compatibility test message")
      );
    });

    test("should default to info level in log function", () => {
      log("Default level test");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[INFO]")
      );
    });
  });

  describe("Logger constructor", () => {
    test("should accept custom log level in constructor", () => {
      const customLogger = new Logger("error");

      customLogger.info("Should not appear");
      expect(mockConsoleLog).not.toHaveBeenCalled();

      customLogger.error("Should appear");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[ERROR]")
      );
    });

    test("should default to info level when no level provided", () => {
      const defaultLogger = new Logger();

      defaultLogger.debug("Should not appear");
      expect(mockConsoleLog).not.toHaveBeenCalled();

      defaultLogger.info("Should appear");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[INFO]")
      );
    });
  });

  describe("setLevel method", () => {
    test("should change log level dynamically", () => {
      logger.setLevel("error");
      logger.info("Should not appear");
      expect(mockConsoleLog).not.toHaveBeenCalled();

      logger.setLevel("info");
      logger.info("Should appear now");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[INFO]")
      );
    });
  });

  describe("Edge cases", () => {
    test("should handle null and undefined messages", () => {
      logger.info(null);
      logger.info(undefined);

      expect(mockConsoleLog).toHaveBeenCalledTimes(2);
    });
    test("should handle empty string messages", () => {
      logger.info("");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("[INFO]")
      );
    });

    test("should handle numeric messages", () => {
      logger.info(42);
      logger.warn(0);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("42")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("0"));
    });

    test("should handle boolean messages", () => {
      logger.info(true);
      logger.error(false);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("true")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("false")
      );
    });

    test("should handle array messages", () => {
      const testArray = [1, "test", { key: "value" }];
      logger.info(testArray);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('"test"')
      );
    });
  });
});
