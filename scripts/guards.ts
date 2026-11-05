/**
 * The checks `scripts/build.mts` runs on the bundle it just wrote, apart from
 * the build itself so `__tests__/scripts/guards.test.ts` can run them on
 * metafiles esbuild produced for small fixture projects.
 *
 * Runs on Node's type stripping (see `scripts/package.json` for why this is a
 * `.ts` file), so it keeps to erasable syntax.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import type { Metafile } from 'esbuild'

export const OUTFILE = 'dist/index.js'
const LICENSES_FILE = 'dist/third-party-licenses.txt'

/**
 * Every source file the CLI initializes before it parses its arguments:
 * the entry, `src/cli.ts`, the command definitions (commander only, each
 * action loads with `await import()`), the manager names and package.json,
 * which esbuild inlines. A file reached from these by `import` or `require`
 * and not listed here is on the startup path, which `autd --version` pays
 * for. A new command's definition file belongs here; never add any other
 * file to make the check pass: load it from an action.
 */
const STARTUP_SOURCES: ReadonlySet<string> = new Set([
  'src/index.ts',
  'src/cli.ts',
  'src/commands/index.ts',
  'src/commands/check.ts',
  'src/commands/update.ts',
  'src/commands/help.ts',
  'src/commands/init.ts',
  'src/commands/options.ts',
  'src/managers/names.ts',
  'package.json',
])

/** The bundled packages the startup path may reach. */
const STARTUP_PACKAGES: ReadonlySet<string> = new Set(['commander'])

/** `src/index.ts` loads `src/cli.ts` with `await import()`, so each starts a walk. */
const STARTUP_ENTRIES = ['src/index.ts', 'src/cli.ts']

/** A check of the bundle failed. The message says what and how to fix it. */
export class GuardError extends Error {}

export type Output = Metafile['outputs'][string]

export const toPosix = (file: string): string => file.replaceAll('\\', '/')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(file, 'utf8'))

/** `@scope/name` or `name` from a specifier or from the path after `node_modules/`. */
const packageNameOf = (specifier: string): string =>
  specifier.split('/', specifier.startsWith('@') ? 2 : 1).join('/')

/**
 * The package a bundled file belongs to and the directory that holds it.
 * The last `node_modules/` segment decides, which also handles pnpm's
 * `node_modules/.pnpm/<name>@<version>/node_modules/<name>/` layout. Only a
 * whole segment counts: `src/vendor_node_modules/x.ts` is a source file.
 */
export function packageOf(file: string): { name: string; dir: string } | null {
  const posix = toPosix(file)
  const marker = 'node_modules/'
  let at = posix.lastIndexOf(marker)
  while (at > 0 && posix[at - 1] !== '/') {
    at = posix.lastIndexOf(marker, at - 1)
  }
  if (at === -1) return null
  const name = packageNameOf(posix.slice(at + marker.length))
  return { name, dir: `${posix.slice(0, at + marker.length)}${name}` }
}

export function dependencyNames(manifest: unknown): string[] {
  if (!isRecord(manifest) || !isRecord(manifest.dependencies)) {
    throw new GuardError('package.json has no "dependencies" object.')
  }
  return Object.keys(manifest.dependencies)
}

/**
 * Walks the metafile from the entry points along `import` and `require`
 * edges, the ones that run when a module initializes, and fails on the first
 * input that is not on the startup list. Returns how many inputs it reached.
 */
export function checkStartup(metafile: Metafile): number {
  const inputs = new Map(
    Object.entries(metafile.inputs).map(([file, input]) => [
      toPosix(file),
      input,
    ]),
  )
  const parents = new Map<string, string | null>(
    STARTUP_ENTRIES.map((entry) => [entry, null]),
  )
  const queue = [...STARTUP_ENTRIES]

  const fail = (file: string, subject: string): never => {
    const chain: string[] = []
    for (
      let step: string | null | undefined = file;
      step;
      step = parents.get(step)
    ) {
      chain.unshift(step)
    }
    throw new GuardError(
      `${subject} loads at startup: ${chain.join(' → ')}\n` +
        'Load it from a command action with await import(), so `autd --version` and the commands that do not use it do not pay for it.',
    )
  }

  for (const file of queue) {
    const input = inputs.get(file)
    if (!input) {
      throw new GuardError(
        `${file} is not in the bundle, but the startup check starts from it.`,
      )
    }
    for (const edge of input.imports) {
      if (edge.kind !== 'import-statement' && edge.kind !== 'require-call') {
        continue
      }
      const target = toPosix(edge.path)
      if (edge.external) {
        if (!isBuiltin(target)) {
          parents.set(target, file)
          fail(target, `${target} (not bundled)`)
        }
        continue
      }
      const owner = packageOf(target)
      const allowed = owner
        ? STARTUP_PACKAGES.has(owner.name)
        : STARTUP_SOURCES.has(target)
      if (!allowed) {
        parents.set(target, file)
        fail(target, target)
      }
      if (!parents.has(target)) {
        parents.set(target, file)
        queue.push(target)
      }
    }
  }
  return queue.length
}

/**
 * Every import the bundle leaves for Node to resolve must be a builtin or a
 * runtime dependency, and a dependency must load with `import()`: the
 * dependencies are ESM-only, which `require()` cannot load on every
 * supported Node, and a static import would load at startup.
 */
export function checkExternals(
  output: Output,
  dependencies: readonly string[],
) {
  for (const edge of output.imports) {
    if (!edge.external || isBuiltin(edge.path)) continue
    const name = packageNameOf(edge.path)
    if (!dependencies.includes(name)) {
      throw new GuardError(
        `${OUTFILE} imports ${edge.path}, which is not in "dependencies", so it is not installed with autd. Bundle it (a devDependency) or add it to "dependencies".`,
      )
    }
    if (edge.kind !== 'dynamic-import') {
      throw new GuardError(
        `${OUTFILE} loads ${edge.path} statically (${edge.kind} in the bundle). Load it with await import() from the code that needs it: the package is ESM-only, and a static import runs at startup.`,
      )
    }
  }
}

/** The text of the package's license files, or a failure when it has none. */
function licenseText(name: string, dir: string, root: string): string {
  const files = readdirSync(path.join(root, dir))
    .filter((file) => /^(licen[cs]e|copying)/i.test(file))
    .filter((file) => statSync(path.join(root, dir, file)).isFile())
    .sort()
  if (files.length === 0) {
    throw new GuardError(
      `${name} is bundled into ${OUTFILE} and has no license file in ${dir}. Its license requires the notice to travel with the code.`,
    )
  }
  return files
    .map((file) => readFileSync(path.join(root, dir, file), 'utf8').trim())
    .join('\n\n')
}

/**
 * Writes the notice of every package bundled into dist/index.js, under
 * `root` (the repository). MIT and ISC require it in copies, and bundling
 * leaves no installed copy to carry it. Returns how many packages it covers.
 */
export function writeLicenses(output: Output, root: string): number {
  const packages = new Map<string, string>()
  for (const file of Object.keys(output.inputs)) {
    const owner = packageOf(file)
    if (!owner) continue
    const manifest = readJson(path.join(root, owner.dir, 'package.json'))
    if (
      !isRecord(manifest) ||
      typeof manifest.version !== 'string' ||
      typeof manifest.license !== 'string'
    ) {
      throw new GuardError(
        `${owner.dir}/package.json has no "version" or no "license" string.`,
      )
    }
    const heading = `${owner.name} ${manifest.version} (${manifest.license})`
    packages.set(
      heading,
      `${heading}\n${'-'.repeat(heading.length)}\n\n${licenseText(owner.name, owner.dir, root)}`,
    )
  }
  // Code-unit order, not localeCompare: the file is the same on every machine.
  const notices = [...packages.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, notice]) => notice)
  writeFileSync(
    path.join(root, LICENSES_FILE),
    `Third-party licenses\n\n${OUTFILE} bundles the packages below. Their licenses follow.\n\n${notices.join('\n\n\n')}\n`,
  )
  return packages.size
}
