// filepath: /always-up-to-date/always-up-to-date/src/utils/args.ts
import { parse } from "ts-command-line-args";

interface Args {
  mode?: string;
  repository?: string;
  verbose?: boolean;
  createIssue?: boolean;
  token?: string;
  projectPath?: string;
}

export function parseArgs(): Args {
  try {
    // Remove the first arguments which are typically node and script path
    // Also filter out any subcommands (check, audit, auto) that Commander handles
    const filteredArgs = process.argv
      .filter((arg, index) => index > 1) // Skip node and script path
      .filter((arg) => !["check", "audit", "auto"].includes(arg)); // Skip Commander subcommands

    const args = parse<Args>(
      {
        mode: { type: String, optional: true },
        repository: { type: String, optional: true },
        verbose: { type: Boolean, optional: true, defaultValue: false },
        createIssue: { type: Boolean, optional: true, defaultValue: false },
        token: { type: String, optional: true },
        projectPath: { type: String, optional: true },
      },
      {
        argv: filteredArgs,
        partial: true, // Allow partial parsing to ignore unknown arguments
      }
    );

    return args;
  } catch (error) {
    // If parsing fails, return default empty object
    // to let Commander handle the arguments
    return {};
  }
}
