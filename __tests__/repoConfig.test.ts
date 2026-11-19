import fs from 'fs'
import path from 'path'
import { toPosix } from '@/managers/workspaces'
import jestConfig from '../jest.config'
import { escapeRegExp } from './integration/lockfiles'

const repoRoot = path.resolve(__dirname, '..')

const sourceFiles = (dir: string): string[] =>
  fs
    .readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(dir, entry.name)
      if (entry.isDirectory()) {
        return entry.name === '__mocks__' ? [] : sourceFiles(relative)
      }
      return relative.endsWith('.ts') && !relative.endsWith('.d.ts')
        ? [relative]
        : []
    })

// Jest substitutes <rootDir> and matches each pattern against the full path.
// Both sides use `/`, as the patterns do, so Windows backslashes don't matter.
const isIgnoredForCoverage = (file: string): boolean =>
  jestConfig.coveragePathIgnorePatterns.some((pattern) =>
    new RegExp(
      pattern.replace('<rootDir>', escapeRegExp(toPosix(repoRoot))),
    ).test(toPosix(path.join(repoRoot, file))),
  )

describe('coverage configuration', () => {
  it('measures all four managers and the CLI entry', () => {
    for (const file of [
      'src/index.ts',
      'src/managers/bun/index.ts',
      'src/managers/npm/index.ts',
      'src/managers/pnpm/index.ts',
      'src/managers/yarn/index.ts',
    ]) {
      expect({ file, ignored: isIgnoredForCoverage(file) }).toEqual({
        file,
        ignored: false,
      })
    }
  })

  it('ignores only the re-export barrels', () => {
    expect(sourceFiles('src').filter(isIgnoredForCoverage).sort()).toEqual([
      'src/commands/index.ts',
      'src/managers/index.ts',
    ])
  })
})

describe('CI workflow', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/ci.yml'),
    'utf8',
  )

  // The top-level `on:` block: its indented lines up to the next top-level key.
  const triggers = (/^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(workflow)?.[1] ?? '')
    .split('\n')
    .map((line) => /^ {2}(\w+):/.exec(line)?.[1])
    .filter(Boolean)

  it('runs on pull requests as well as pushes to main', () => {
    expect(triggers).toEqual(expect.arrayContaining(['push', 'pull_request']))
  })

  it('runs Biome', () => {
    expect(workflow).toMatch(/^\s+run: pnpm run format-and-lint\s*$/m)
  })

  it('runs the unit suite on Linux and Windows', () => {
    expect(workflow).toMatch(/os: \[ ?ubuntu-latest, windows-latest ?\]/)
  })

  it('runs the integration matrix per manager in CI', () => {
    expect(workflow).toMatch(/pm: \[ ?npm, pnpm, yarn, berry, bun ?\]/)
    expect(workflow).toMatch(/^\s+run: pnpm run test:integration\s*$/m)
  })

  it('runs the matrix against the compiled binary, and the binary without Node', () => {
    expect(workflow).toMatch(/cli: \[ ?bundle, binary ?\]/)
    expect(workflow).toMatch(/os: macos-latest, pm: bun, cli: binary/)
    expect(workflow).toMatch(/^\s+pnpm run build:binary --target host\s*$/m)
    expect(workflow).toMatch(/AUTD_INTEGRATION_CLI=/)
    const job = /^ {2}binary-without-node:\n((?:(?: {4}.*)?\n)+)/m.exec(
      workflow,
    )?.[1]
    // The run proves Node is absent before it starts the binary.
    expect(job).toMatch(/command -v "\$name"/)
    expect(job).toMatch(/bun install --frozen-lockfile/)
    expect(job).not.toMatch(/continue-on-error/)
  })

  it('enforces the perf gate per target', () => {
    expect(workflow).toMatch(
      /target: \[ ?startup, npm, pnpm, yarn, berry, berry-nm, bun ?\]/,
    )
    expect(workflow).toMatch(/^\s+run: pnpm run bench:gate\s*$/m)
    // A red result must fail the leg: nothing in the job may swallow it.
    const perfJob = /^ {2}perf:\n((?:(?: {4}.*)?\n)+)/m.exec(workflow)?.[1]
    expect(perfJob).toMatch(/run: pnpm run bench:gate/)
    expect(perfJob).not.toMatch(/continue-on-error/)
    expect(workflow).toMatch(
      /AUTD_BENCH_GATE_TARGET: \$\{\{ matrix\.target \}\}/,
    )
  })
})

describe('release workflow', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/release.yml'),
    'utf8',
  )

  const job = (name: string): string =>
    new RegExp(`^ {2}${name}:\\n((?:(?: {4}.*)?\\n)+)`, 'm').exec(
      workflow,
    )?.[1] ?? ''

  it("keeps its name: it is npm's trusted publisher", () => {
    expect(workflow).toMatch(/^name: Release$/m)
  })

  it('keeps the read-only default and restores no cache', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(workflow).not.toMatch(/^\s+cache: /m)
    expect(workflow).not.toMatch(/actions\/cache@/)
  })

  it('builds all five binaries on macOS, beside the publish', () => {
    const binaries = job('binaries')
    expect(binaries).toMatch(/^ {4}needs: check$/m)
    expect(binaries).toMatch(/^ {4}runs-on: macos-15$/m)
    expect(binaries).toMatch(/^\s+- run: pnpm run build:binary$/m)
    expect(binaries).toMatch(/package-manager-cache: false/)
    expect(binaries).toMatch(/dist-binary\/SHA256SUMS/)
    // Nothing the npm publish or the release needs waits on the binaries.
    expect(job('publish')).toMatch(/^ {4}needs: check$/m)
    expect(job('publish')).not.toMatch(/binaries/)
  })

  it('smokes every target on a runner of its own OS and architecture', () => {
    const smoke = job('binaries-smoke')
    expect(smoke).toMatch(/needs: \[ check, binaries \]/)
    for (const [os, triple] of [
      ['macos-15', 'aarch64-apple-darwin'],
      ['macos-15-intel', 'x86_64-apple-darwin'],
      ['ubuntu-24.04', 'x86_64-unknown-linux-gnu'],
      ['ubuntu-24.04-arm', 'aarch64-unknown-linux-gnu'],
      ['windows-latest', 'x86_64-pc-windows-msvc'],
    ]) {
      expect(smoke).toContain(`{ os: ${os}, triple: ${triple} }`)
    }
    expect(smoke).toMatch(/^ {4}permissions:\n {6}contents: read$/m)
    expect(smoke).toMatch(/Identifier=ca\.pixel-perfect\.alwaysuptodate/)
    expect(smoke).not.toMatch(/continue-on-error/)
  })

  it('attests the archives before it uploads any, once the release exists', () => {
    const release = job('binaries-release')
    expect(release).toMatch(/needs: \[ publish, binaries-smoke \]/)
    expect(release).toMatch(/contents: write/)
    expect(release).toMatch(/id-token: write/)
    expect(release).toMatch(/attestations: write/)
    expect(release).toMatch(/subject-checksums: dist-binary\/SHA256SUMS/)
    const attest = release.indexOf('actions/attest-build-provenance@')
    const upload = release.indexOf('gh release upload')
    expect(attest).toBeGreaterThan(-1)
    expect(upload).toBeGreaterThan(attest)
    expect(release).toMatch(/--json assets/)
  })
})

describe('integration matrix', () => {
  it('stays out of pnpm test', () => {
    expect(jestConfig.testPathIgnorePatterns).toContain(
      '<rootDir>/__tests__/integration/',
    )
  })
})

describe('workflows', () => {
  const workflowDir = path.join(repoRoot, '.github/workflows')

  it('pins every action to a release commit', () => {
    const unpinned = fs
      .readdirSync(workflowDir)
      .flatMap((file) =>
        fs
          .readFileSync(path.join(workflowDir, file), 'utf8')
          .split(/\r?\n/)
          .filter((line) => /\buses:/.test(line))
          .map((line) => ({ file, line: line.trim() })),
      )
      .filter(
        ({ line }) =>
          !/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/.test(
            line,
          ),
      )

    expect(unpinned).toEqual([])
  })
})
