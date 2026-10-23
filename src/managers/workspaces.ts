import fs from 'fs'
import path from 'path'

/** The project's package.json, or undefined when it can't be read. */
export const readManifest = (
  cwd: string,
): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * npm, yarn and bun declare members in a `workspaces` field: an array of
 * globs, or an object with a `packages` field.
 */
export const hasWorkspacesField = (cwd: string): boolean => {
  const workspaces = readManifest(cwd)?.workspaces
  return (
    Array.isArray(workspaces) ||
    (typeof workspaces === 'object' &&
      workspaces !== null &&
      !!(workspaces as { packages?: unknown }).packages)
  )
}
