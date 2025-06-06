export class AlwaysUpToDateError extends Error {
  constructor(
    message: string,
    public code: string,
    public originalError?: Error,
  ) {
    super(message)
    this.name = "AlwaysUpToDateError"
  }
}

export class PackageManagerError extends AlwaysUpToDateError {
  constructor(
    message: string,
    public packageManager: string,
    originalError?: Error,
  ) {
    super(message, "PACKAGE_MANAGER_ERROR", originalError)
    this.name = "PackageManagerError"
  }
}

export class GitError extends AlwaysUpToDateError {
  constructor(message: string, originalError?: Error) {
    super(message, "GIT_ERROR", originalError)
    this.name = "GitError"
  }
}

export class NetworkError extends AlwaysUpToDateError {
  constructor(message: string, originalError?: Error) {
    super(message, "NETWORK_ERROR", originalError)
    this.name = "NetworkError"
  }
}

export class ConfigurationError extends AlwaysUpToDateError {
  constructor(message: string, originalError?: Error) {
    super(message, "CONFIGURATION_ERROR", originalError)
    this.name = "ConfigurationError"
  }
}

export class DependencyError extends AlwaysUpToDateError {
  constructor(
    message: string,
    public packageName: string,
    originalError?: Error,
  ) {
    super(message, "DEPENDENCY_ERROR", originalError)
    this.name = "DependencyError"
  }
}

export function wrapError<T extends Error>(
  error: T,
  context: string,
): AlwaysUpToDateError {
  if (error instanceof AlwaysUpToDateError) {
    return error
  }

  // Detect specific error types and wrap appropriately
  if (error.message.includes("git")) {
    return new GitError(`${context}: ${error.message}`, error)
  }

  if (error.message.includes("network") || error.message.includes("fetch")) {
    return new NetworkError(`${context}: ${error.message}`, error)
  }

  if (
    error.message.includes("npm") ||
    error.message.includes("yarn") ||
    error.message.includes("pnpm")
  ) {
    return new PackageManagerError(
      `${context}: ${error.message}`,
      "unknown",
      error,
    )
  }

  return new AlwaysUpToDateError(
    `${context}: ${error.message}`,
    "UNKNOWN_ERROR",
    error,
  )
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delay: number = 1000,
): Promise<T> {
  let lastError: Error

  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error

      if (i === retries - 1) {
        throw error
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)))
    }
  }

  throw lastError!
}
