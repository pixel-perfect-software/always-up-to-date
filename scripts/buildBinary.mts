/**
 * `pnpm run build:binary`: standalone binaries of dist/index.cjs (#265).
 *
 * Run `pnpm run build` first: the esbuild bundle and its startup and externals
 * checks stay the one source of what ships, and Bun compiles that bundle
 * (`@inquirer/prompts`, external in the npm bundle, is compiled in from
 * node_modules). Runs on Node's type stripping, so it keeps to erasable syntax.
 *
 *   pnpm run build:binary                      all five targets
 *   pnpm run build:binary --target host        this machine's target only
 *   pnpm run build:binary --target bun-linux-x64 --target aarch64-apple-darwin
 *
 * Writes dist-binary/always-up-to-date-<version>-<triple>.tar.gz (.zip for
 * Windows), each holding `autd` (`autd.exe`), LICENSE, third-party-licenses.txt (the npm
 * packages compiled in) and BUN-LICENSE.md (packaging/bun/LICENSE.md, Bun's
 * own notice, vendored per Bun version), and
 * dist-binary/SHA256SUMS for the archives it built. dist-binary/ is emptied
 * first. Darwin binaries are signed ad hoc with a fixed identifier when this
 * machine runs macOS. Every command is an argument array: no shell.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { build } from 'esbuild'
import {
  ARCHIVE_FILES,
  archiveName,
  BINARY_NAME,
  BUN_LICENSE_FILE,
  binaryFileName,
  CHECKSUMS_FILE,
  checksumLines,
  pinnedBunVersion,
  SIGNING_IDENTIFIER,
  selectTargets,
  type Target,
  THIRD_PARTY_FILE,
  thirdPartyHeader,
  UsageError,
} from './binary.ts'
import { GuardError, licenseNotices, OUTFILE, readJson } from './guards.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(ROOT, 'dist-binary')
const run = promisify(execFile)

async function exec(
  file: string,
  args: string[],
  cwd: string = ROOT,
): Promise<string> {
  try {
    // COPYFILE_DISABLE: macOS tar would otherwise add `._*` AppleDouble
    // entries for files with extended attributes.
    const { stdout } = await run(file, args, {
      cwd,
      maxBuffer: 1 << 26,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    return stdout
  } catch (error) {
    const { code, stderr } = error as NodeJS.ErrnoException & {
      stderr?: string
    }
    if (code === 'ENOENT') throw new GuardError(`\`${file}\` is not on PATH.`)
    throw new GuardError(
      `\`${[file, ...args].join(' ')}\` failed: ${String(stderr ?? error).trim()}`,
    )
  }
}

function versionOf(manifest: unknown): string {
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? manifest.version
      : undefined
  if (typeof version !== 'string' || version === '') {
    throw new GuardError('package.json has no version.')
  }
  return version
}

/** Bun on PATH must be the version `.tool-versions` pins: it is the runtime inside the binary. */
async function checkBun(): Promise<string> {
  const pinned = pinnedBunVersion(
    readFileSync(path.join(ROOT, '.tool-versions'), 'utf8'),
  )
  if (!pinned) throw new GuardError('.tool-versions has no `bun` line.')
  const found = (await exec('bun', ['--version'])).trim()
  if (found !== pinned) {
    throw new GuardError(
      `bun ${found} is on PATH, but .tool-versions pins ${pinned}.`,
    )
  }
  return pinned
}

/**
 * The notices of every npm package compiled into the binary: the packages
 * dist/index.cjs bundles plus `@inquirer/prompts` and its dependencies, which
 * Bun compiles in. A metafile-only esbuild build of src/index.ts with
 * build.mts's options and nothing external lists them; `writeLicenses`'s logic
 * (`licenseNotices`) turns it into the text.
 */
async function writeThirdParty(pinnedBun: string, file: string) {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/index.ts'],
    outfile: OUTFILE,
    write: false,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22.23',
    tsconfig: 'tsconfig.json',
    metafile: true,
    logLevel: 'silent',
  })
  const output = Object.values(result.metafile.outputs)[0]
  if (!output) throw new GuardError('The licenses build has no output.')
  const { count, text } = licenseNotices(output, ROOT)
  writeFileSync(file, `${thirdPartyHeader(pinnedBun)}${text}\n`)
  return count
}

async function buildTarget(
  target: Target,
  version: string,
  stage: string,
  notices: string,
): Promise<{ file: string; sha256: string }> {
  const dir = path.join(stage, target.triple)
  mkdirSync(dir, { recursive: true })
  const binary = binaryFileName(target)

  await exec('bun', [
    'build',
    '--compile',
    '--minify',
    `--target=${target.bun}`,
    OUTFILE,
    '--outfile',
    path.join(dir, binary),
  ])

  if (target.os === 'darwin' && process.platform !== 'darwin') {
    // Bun's own ad-hoc linker signature runs on Apple Silicon; only the
    // identifier (`a.out`) differs. Releases sign on a macOS runner.
    console.warn(
      `${target.bun}: not re-signed (no codesign on ${process.platform}); it keeps Bun's ad-hoc signature, identifier a.out`,
    )
  }
  if (target.os === 'darwin' && process.platform === 'darwin') {
    await exec('codesign', [
      '--force',
      '--sign',
      '-',
      '--identifier',
      SIGNING_IDENTIFIER,
      path.join(dir, binary),
    ])
  }

  copyFileSync(path.join(ROOT, 'LICENSE'), path.join(dir, 'LICENSE'))
  copyFileSync(notices, path.join(dir, THIRD_PARTY_FILE))
  copyFileSync(
    path.join(ROOT, 'packaging', 'bun', 'LICENSE.md'),
    path.join(dir, BUN_LICENSE_FILE),
  )

  const file = archiveName(version, target)
  const archive = path.join(OUT_DIR, file)
  if (target.os === 'windows' && process.platform === 'win32') {
    // A Windows runner may have no `zip`, but Windows ships bsdtar, which
    // writes a zip with -a. Named by its path, since Git's GNU tar (no zip)
    // can come first on PATH.
    const bsdtar = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'tar.exe',
    )
    await exec(bsdtar, ['-a', '-cf', archive, binary, ...ARCHIVE_FILES], dir)
  } else if (target.os === 'windows') {
    await exec('zip', ['-q', archive, binary, ...ARCHIVE_FILES], dir)
  } else {
    await exec('tar', ['-czf', archive, binary, ...ARCHIVE_FILES], dir)
  }

  const sha256 = createHash('sha256')
    .update(readFileSync(archive))
    .digest('hex')
  console.log(`${target.bun}: ${path.relative(ROOT, archive)}`)
  return { file, sha256 }
}

async function main() {
  let names: string[]
  try {
    const { values } = parseArgs({
      options: { target: { type: 'string', multiple: true } },
      strict: true,
    })
    names = values.target ?? []
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const targets = selectTargets(names)
  const version = versionOf(readJson(path.join(ROOT, 'package.json')))

  if (!existsSync(path.join(ROOT, OUTFILE))) {
    throw new GuardError(`${OUTFILE} is missing. Run \`pnpm run build\` first.`)
  }
  const bun = await checkBun()

  rmSync(OUT_DIR, { recursive: true, force: true })
  const stage = path.join(OUT_DIR, '.stage')
  mkdirSync(stage, { recursive: true })

  const notices = path.join(stage, THIRD_PARTY_FILE)
  const packages = await writeThirdParty(bun, notices)
  console.log(`${THIRD_PARTY_FILE}: ${packages} npm packages`)

  const sums = []
  for (const target of targets) {
    sums.push(await buildTarget(target, version, stage, notices))
  }
  rmSync(stage, { recursive: true, force: true })

  writeFileSync(path.join(OUT_DIR, CHECKSUMS_FILE), checksumLines(sums))
  console.log(
    `${sums.length} archive(s) of ${BINARY_NAME} ${version} on bun ${bun}, and ${CHECKSUMS_FILE}, in ${path.relative(ROOT, OUT_DIR)}/`,
  )
}

try {
  await main()
} catch (error) {
  if (!(error instanceof GuardError) && !(error instanceof UsageError)) {
    throw error
  }
  console.error(`build:binary: ${error.message}`)
  process.exitCode = 1
}
