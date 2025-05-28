// filepath: /always-up-to-date/always-up-to-date/tests/utils/logger.test.ts
import { logger } from "../../src/utils/logger";

describe("Logger Utility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should log messages at info level", () => {
    const mockConsoleLog = jest
      .spyOn(console, "log")
      .mockImplementation(() => {});
    logger.info("This is an info message");
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("[INFO]")
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("This is an info message")
    );
    mockConsoleLog.mockRestore();
  });

  test("should log messages at warning level", () => {
    const mockConsoleLog = jest
      .spyOn(console, "log")
      .mockImplementation(() => {});
    logger.warn("This is a warning message");
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("[WARN]")
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("This is a warning message")
    );
    mockConsoleLog.mockRestore();
  });

  test("should log messages at error level", () => {
    const mockConsoleLog = jest
      .spyOn(console, "log")
      .mockImplementation(() => {});
    logger.error("This is an error message");
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("[ERROR]")
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("This is an error message")
    );
    mockConsoleLog.mockRestore();
  });

  test("should handle different log levels", () => {
    logger.setLevel("warn");
    const mockConsoleLog = jest
      .spyOn(console, "log")
      .mockImplementation(() => {});
    logger.info("This should not be logged");
    expect(mockConsoleLog).not.toHaveBeenCalled();

    logger.warn("This should be logged");
    expect(mockConsoleLog).toHaveBeenCalled();
    mockConsoleLog.mockRestore();
  });
});
