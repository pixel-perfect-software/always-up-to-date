/**
 * `pnpm run build`: dist/index.js as one esbuild bundle.
 *
 * Runs on Node's type stripping, so it keeps to erasable syntax. In order it
 * empties dist/, bundles src/index.ts, fails on any esbuild warning, checks
 * what `--version` and `help` load (the startup check), checks the external
 * imports, and writes the licenses of the bundled packages. The checks live
 * in `scripts/guards.ts`.
 *
 * tsc only type-checks (`pnpm run check-types`); it emits nothing.
 */

import { rmSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import {
  checkExternals,
  checkStartup,
  dependencyNames,
  GuardError,
  OUTFILE,
  readJson,
  toPosix,
  writeLicenses,
} from './guards.ts'

const ROOT = path.resolve(import.meta.dirname, '..')

async function main() {
  const dependencies = dependencyNames(
    readJson(path.join(ROOT, 'package.json')),
  )

  rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true })

  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/index.ts'],
    outfile: OUTFILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22.23',
    tsconfig: 'tsconfig.json',
    external: dependencies,
    metafile: true,
    logLevel: 'warning',
  })
  if (result.warnings.length > 0) {
    throw new GuardError(
      `esbuild reported ${result.warnings.length} warning(s), printed above. A warning here can mean the CommonJS output does not work.`,
    )
  }

  const output = Object.entries(result.metafile.outputs).find(
    ([file]) => toPosix(file) === OUTFILE,
  )?.[1]
  if (!output) throw new GuardError(`The metafile has no output ${OUTFILE}.`)

  const startupInputs = checkStartup(result.metafile)
  checkExternals(output, dependencies)
  const licensed = writeLicenses(output, ROOT)

  console.log(
    `${OUTFILE}: ${(output.bytes / 1024).toFixed(1)} KB, ${startupInputs} inputs on the startup path, ${licensed} bundled packages licensed`,
  )
}

try {
  await main()
} catch (error) {
  if (!(error instanceof GuardError)) throw error
  console.error(`build: ${error.message}`)
  // esbuild has already written the bundle. Remove it, so no later step
  // (pack, the bench, the integration matrix) runs one that failed a check.
  rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true })
  process.exitCode = 1
}
