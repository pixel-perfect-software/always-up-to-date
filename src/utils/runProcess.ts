import { exec, execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

// cmd.exe reads these as operators unless they sit inside double quotes.
const CMD_OPERATORS = /[\s&|<>^()]/

/**
 * Joins a program and its arguments into one cmd.exe command line, double
 * quoting each argument that holds a cmd.exe operator (the `^` in `^1.2.3`,
 * the `>` in `>=1.2.3`). Package names and version specs never contain `"`.
 */
export const buildWindowsCommand = (file: string, args: string[]): string =>
  [file, ...args]
    .map((arg) => (CMD_OPERATORS.test(arg) ? `"${arg}"` : arg))
    .join(' ')

/**
 * Runs a program with an argument array: no shell between autd and the
 * package manager, and no cap on how much output it may print.
 *
 * Windows is the exception. npm, pnpm and yarn are `.cmd` shims there, and
 * Node only starts those through cmd.exe, so the command line is built with
 * `buildWindowsCommand` and run through the shell.
 */
export const runProcess = (
  file: string,
  args: string[],
  { cwd }: { cwd: string },
): Promise<{ stdout: string; stderr: string }> => {
  const options = {
    cwd,
    encoding: 'utf8' as const,
    // Explicit, because under Jest `process.env` is a sandbox copy that
    // child_process would otherwise not see.
    env: process.env,
    maxBuffer: Number.POSITIVE_INFINITY,
  }

  return process.platform === 'win32'
    ? execAsync(buildWindowsCommand(file, args), options)
    : execFileAsync(file, args, options)
}
