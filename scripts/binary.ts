/**
 * The pure parts of `scripts/buildBinary.mts`, apart from it so
 * `__tests__/scripts/binary.test.ts` can run them without Bun: the targets,
 * the archive names, the target selection, the pinned Bun version and the
 * checksum file.
 *
 * Runs on Node's type stripping, so it keeps to erasable syntax.
 */

export type Target = {
  /** Bun's `--target` value. */
  bun: string
  /** The triple in the archive name, env-router's naming. */
  triple: string
  os: 'darwin' | 'linux' | 'windows'
  /** `process.platform` and `process.arch` of the machine that runs it natively. */
  platform: NodeJS.Platform
  arch: string
}

export const TARGETS: readonly Target[] = [
  {
    bun: 'bun-darwin-arm64',
    triple: 'aarch64-apple-darwin',
    os: 'darwin',
    platform: 'darwin',
    arch: 'arm64',
  },
  {
    bun: 'bun-darwin-x64',
    triple: 'x86_64-apple-darwin',
    os: 'darwin',
    platform: 'darwin',
    arch: 'x64',
  },
  {
    bun: 'bun-linux-x64',
    triple: 'x86_64-unknown-linux-gnu',
    os: 'linux',
    platform: 'linux',
    arch: 'x64',
  },
  {
    bun: 'bun-linux-arm64',
    triple: 'aarch64-unknown-linux-gnu',
    os: 'linux',
    platform: 'linux',
    arch: 'arm64',
  },
  {
    bun: 'bun-windows-x64',
    triple: 'x86_64-pc-windows-msvc',
    os: 'windows',
    platform: 'win32',
    arch: 'x64',
  },
]

/** The archive and formula name (decided with the issue, 2026-11-19). */
export const ARCHIVE_PREFIX = 'always-up-to-date'

/** The CLI's file name inside every archive. */
export const BINARY_NAME = 'autd'

export const THIRD_PARTY_FILE = 'third-party-licenses.txt'

/** Bun's own notice, vendored from the release `.tool-versions` pins. */
export const BUN_LICENSE_FILE = 'BUN-LICENSE.md'

/** What every archive holds besides the binary. */
export const ARCHIVE_FILES = ['LICENSE', THIRD_PARTY_FILE, BUN_LICENSE_FILE]

export const SIGNING_IDENTIFIER = 'ca.pixel-perfect.alwaysuptodate'

export const CHECKSUMS_FILE = 'SHA256SUMS'

/** The command line or the machine asks for something the script cannot build. */
export class UsageError extends Error {}

export const binaryFileName = (target: Target): string =>
  target.os === 'windows' ? `${BINARY_NAME}.exe` : BINARY_NAME

export const archiveName = (version: string, target: Target): string =>
  `${ARCHIVE_PREFIX}-${version}-${target.triple}.${target.os === 'windows' ? 'zip' : 'tar.gz'}`

export const hostTarget = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Target => {
  const host = TARGETS.find(
    (target) => target.platform === platform && target.arch === arch,
  )
  if (!host) {
    throw new UsageError(
      `No binary target for ${platform} ${arch}. The targets are ${TARGETS.map((target) => target.bun).join(', ')}.`,
    )
  }
  return host
}

/**
 * The targets a `--target` list names, in the order of `TARGETS`. Each name is
 * a Bun target (`bun-linux-x64`), a triple, or `host`; no names selects all.
 */
export function selectTargets(
  names: readonly string[],
  host: () => Target = hostTarget,
): Target[] {
  if (names.length === 0) return [...TARGETS]
  const chosen = new Set<Target>()
  for (const name of names) {
    const target =
      name === 'host'
        ? host()
        : TARGETS.find((each) => each.bun === name || each.triple === name)
    if (!target) {
      throw new UsageError(
        `Unknown target "${name}". Use host, ${TARGETS.map((each) => each.bun).join(', ')}, or a triple.`,
      )
    }
    chosen.add(target)
  }
  return TARGETS.filter((target) => chosen.has(target))
}

/** The `bun` version `.tool-versions` pins, or null when it has no `bun` line. */
export function pinnedBunVersion(toolVersions: string): string | null {
  for (const line of toolVersions.split('\n')) {
    const [tool, version] = line.trim().split(/\s+/)
    if (tool === 'bun' && version) return version
  }
  return null
}

/** `sha256sum`'s format (hash, two spaces, name), sorted by name, one trailing newline. */
export const checksumLines = (
  sums: ReadonlyArray<{ file: string; sha256: string }>,
): string =>
  `${[...sums]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map(({ file, sha256 }) => `${sha256}  ${file}`)
    .join('\n')}\n`

/** The top of third-party-licenses.txt: what the file covers, and the Bun runtime's notice. */
export const thirdPartyHeader = (bunVersion: string): string =>
  `Third-party licenses\n\nThis binary compiles in the npm packages below. Their licenses follow.\n\nIt also includes the Bun ${bunVersion} runtime. Bun's license notice is in ${BUN_LICENSE_FILE}.\n\n`
