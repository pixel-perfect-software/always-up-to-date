import fs from 'fs'
import path from 'path'

/**
 * Real package-manager output captured on the 40-dependency benchmark
 * project (Node 24). Paths are relative to this directory.
 */
export const readFixture = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, relativePath), 'utf8')

/**
 * Builds the error a child process rejects with when it exits non-zero,
 * carrying the exit code and both streams like Node's own error does.
 */
export const exitError = (
  code: number,
  stdout: string,
  stderr: string,
): Error & { code: number; stdout: string; stderr: string } =>
  Object.assign(new Error(`Command failed with exit code ${code}`), {
    code,
    stdout,
    stderr,
  })
