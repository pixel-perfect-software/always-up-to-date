import { auditDependencies } from "../../src/commands/audit";

describe("Audit Command", () => {
  test("should identify vulnerabilities in dependencies", async () => {
    const result = await auditDependencies();
    expect(result).toHaveProperty("vulnerabilities");
    expect(Array.isArray(result.vulnerabilities)).toBe(true);
  });

  test("should return an empty array if no vulnerabilities are found", async () => {
    const result = await auditDependencies();
    expect(result.vulnerabilities).toEqual([]);
  });

  test("should handle errors gracefully", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await auditDependencies();
    expect(console.error).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});