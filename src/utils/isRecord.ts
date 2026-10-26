/** A plain JSON object: not null, not an array. Imports nothing, so any module may use it. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
