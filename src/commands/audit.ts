import { getVulnerabilities } from "../services/vulnerability-scanner";
import { logger } from "../utils/logger";

export interface AuditResult {
  vulnerabilities: any[];
}

export const auditDependencies = async (): Promise<AuditResult | undefined> => {
  try {
    const vulnerabilities = await getVulnerabilities();

    if (vulnerabilities.length === 0) {
      logger.info("No vulnerabilities found in dependencies.");
      return { vulnerabilities: [] };
    } else {
      logger.warn(`${vulnerabilities.length} vulnerabilities found:`);
      vulnerabilities.forEach((vuln) => {
        logger.warn(
          `- ${vuln.name}@${vuln.version}: ${vuln.severity} severity. ${vuln.recommendation}`
        );
      });
      return { vulnerabilities };
    }
  } catch (error) {
    logger.error(
      `An error occurred while auditing dependencies: ${
        (error as Error).message
      }`
    );
    console.error(error);
    return undefined;
  }
};

// For backwards compatibility
export const audit = auditDependencies;
