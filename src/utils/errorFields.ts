/** An error's message, or the thrown value as text when it is not an `Error`. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A thrown value's numeric `status` (an HTTP status), if it has one. */
export const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  typeof error.status === 'number'
    ? error.status
    : undefined

/** A thrown value's string `code` (`ECONNRESET`), if it has one. */
export const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined
