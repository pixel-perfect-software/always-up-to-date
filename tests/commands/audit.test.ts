import { auditDependencies } from "../../src/commands/audit";
import { getVulnerabilities } from "../../src/services/vulnerability-scanner";

// Mock the vulnerability scanner
jest.mock("../../src/services/vulnerability-scanner");
jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockGetVulnerabilities = getVulnerabilities as jest.MockedFunction<
  typeof getVulnerabilities
>;

describe("Audit Command", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should identify vulnerabilities in dependencies", async () => {
    const mockVulnerabilities = [
      {
        name: "test-package",
        version: "1.0.0",
        severity: "high",
        vulnerableVersions: "<=1.0.0",
        recommendation: "Update to latest",
      },
    ];
    mockGetVulnerabilities.mockResolvedValue(mockVulnerabilities);

    const result = await auditDependencies();

    expect(result).toBeDefined();
    if (result) {
      expect(result).toHaveProperty("vulnerabilities");
      expect(result.vulnerabilities).toEqual(mockVulnerabilities);
    }
  });

  test("should return an empty array if no vulnerabilities are found", async () => {
    mockGetVulnerabilities.mockResolvedValue([]);

    const result = await auditDependencies();

    expect(result).toBeDefined();
    if (result) {
      expect(result.vulnerabilities).toEqual([]);
    }

    const { logger } = require("../../src/utils/logger");
    expect(logger.info).toHaveBeenCalledWith(
      "No vulnerabilities found in dependencies."
    );
  });

  test("should handle errors gracefully", async () => {
    mockGetVulnerabilities.mockRejectedValue(new Error("Test error"));

    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const result = await auditDependencies();

    expect(consoleSpy).toHaveBeenCalled();
    expect(result).toBeUndefined();

    const { logger } = require("../../src/utils/logger");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Test error")
    );

    consoleSpy.mockRestore();
  });
});
