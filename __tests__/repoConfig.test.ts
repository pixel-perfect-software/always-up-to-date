import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { toPosix } from '@/managers/workspaces'
import jestConfig from '../jest.config'
import { tempDir, write } from './fixtures/files'
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

  it('installs the release formula with a real Homebrew on both OSes', () => {
    const job = /^ {2}homebrew-formula:\n((?:(?: {4}.*)?\n)+)/m.exec(
      workflow,
    )?.[1]
    expect(job).toMatch(/os: \[ ?macos-15, ubuntu-24\.04 ?\]/)
    expect(job).toMatch(/^\s+pnpm run build:binary$/m)
    expect(job).toMatch(/shellcheck packaging\/homebrew\/render\.sh/)
    expect(job).toMatch(/render\.sh .*"file:\/\/\$PWD\/dist-binary"/s)
    expect(job).toMatch(/brew tap-new --no-git local\/autd/)
    expect(job).toMatch(/brew install local\/autd\/always-up-to-date/)
    expect(job).toMatch(/brew test local\/autd\/always-up-to-date/)
    expect(job).toMatch(/for name in autd alwaysuptodate always-up-to-date/)
    expect(job).toMatch(/HOMEBREW_NO_AUTO_UPDATE: 1/)
    // API mode: turning it off makes the install clone homebrew/core (#268's first CI run).
    expect(job).not.toMatch(/HOMEBREW_NO_INSTALL_FROM_API:/)
    expect(job).toMatch(/\/home\/linuxbrew\/\.linuxbrew\/bin/)
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

  it('renders the Homebrew formula once the archives are on the release', () => {
    const homebrew = job('homebrew')
    expect(homebrew).toMatch(/^ {4}needs: \[ check, binaries-release \]$/m)
    expect(homebrew).toMatch(/^ {4}permissions:\n {6}contents: read$/m)
    expect(homebrew).not.toMatch(/write/)
    expect(homebrew).toMatch(/repository: pixel-perfect-software\/homebrew-tap/)
    expect(homebrew).toMatch(/packaging\/homebrew\/render\.sh/)
    expect(homebrew).toMatch(/dist-binary\/SHA256SUMS/)
    expect(homebrew).toMatch(/--message "always-up-to-date \$VERSION"/)
    // The tap's token reaches the tap checkout only, never the built-in token's jobs.
    expect(homebrew.match(/TAP_TOKEN/g)).toHaveLength(1)
    expect(homebrew).toMatch(
      /token: \$\{\{ secrets\.TAP_TOKEN \}\}\n\s+path: tap/,
    )
    expect(workflow.match(/TAP_TOKEN/g)?.length).toBeGreaterThan(
      homebrew.match(/TAP_TOKEN/g)?.length ?? 0,
    ) // the header comment names it too
    // A tap failure can't hold up npm, the release or the binaries.
    for (const name of ['publish', 'binaries', 'binaries-release']) {
      expect(job(name)).not.toMatch(/homebrew|TAP_TOKEN/)
    }
    expect(workflow).not.toMatch(/needs: .*homebrew/)
  })

  it('never downgrades the tap when an older tag reruns', () => {
    const homebrew = job('homebrew')
    const guard = homebrew.indexOf('sort -V')
    expect(guard).toBeGreaterThan(-1)
    expect(homebrew.indexOf('packaging/homebrew/render.sh')).toBeGreaterThan(
      guard,
    )
    expect(homebrew).toMatch(/releases\/download\/v/)
  })
})

// render.sh is POSIX sh, with sed and awk: the unit suite also runs on Windows, which has none.
;(process.platform === 'win32' ? describe.skip : describe)(
  'Homebrew formula',
  () => {
    const render = path.join(repoRoot, 'packaging/homebrew/render.sh')
    const version = '9.9.9'
    const triples = [
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
    ]
    const hashes = Object.fromEntries(
      triples.map((triple, index) => [
        triple,
        String.fromCharCode(97 + index).repeat(64),
      ]),
    )
    // sha256sum's format: `<hash>  <name>`, the archives and the Windows zip.
    const sumsLines = (omit?: string): string[] => [
      ...triples
        .filter((triple) => triple !== omit)
        .map(
          (triple) =>
            `${hashes[triple]}  always-up-to-date-${version}-${triple}.tar.gz`,
        ),
      `${'e'.repeat(64)}  always-up-to-date-${version}-x86_64-pc-windows-msvc.zip`,
    ]

    const run = (omit?: string) => {
      const root = tempDir('autd-formula-')
      const sums = path.join(root, 'SHA256SUMS')
      write(sums, `${sumsLines(omit).join('\n')}\n`)
      const tap = path.join(root, 'tap')
      const result = spawnSync('sh', [render, version, sums, tap], {
        encoding: 'utf8',
      })
      return { result, tap }
    }

    // The block opened by `on_<name> do` in the formula.
    const block = (source: string, name: string): string =>
      new RegExp(`^ {2}${name} do\\n((?: {4}.*\\n)+)`, 'm').exec(source)?.[1] ??
      ''

    it('puts each archive and its checksum in its own platform block', () => {
      const { result, tap } = run()
      expect(result.status).toBe(0)
      const formula = fs.readFileSync(
        path.join(tap, 'Formula/always-up-to-date.rb'),
        'utf8',
      )
      expect(formula).toMatch(/^class AlwaysUpToDate < Formula$/m)
      expect(formula).not.toMatch(/@\w+@/)
      const macos = block(formula, 'on_macos')
      const linux = block(formula, 'on_linux')
      const entry = (source: string, arch: string, triple: string): string => {
        const inner = new RegExp(
          `^ {4}${arch} do\\n((?: {6}.*\\n)+)`,
          'm',
        ).exec(source)?.[1]
        expect(inner).toBe(
          `      url "https://github.com/pixel-perfect-software/always-up-to-date/releases/download/v${version}/always-up-to-date-${version}-${triple}.tar.gz"\n` +
            `      sha256 "${hashes[triple]}"\n`,
        )
        return inner ?? ''
      }
      entry(macos, 'on_arm', 'aarch64-apple-darwin')
      entry(macos, 'on_intel', 'x86_64-apple-darwin')
      entry(linux, 'on_intel', 'x86_64-unknown-linux-gnu')
      entry(linux, 'on_arm', 'aarch64-unknown-linux-gnu')
    })

    it('installs autd with both aliases and the three license files', () => {
      const { tap } = run()
      const formula = fs.readFileSync(
        path.join(tap, 'Formula/always-up-to-date.rb'),
        'utf8',
      )
      expect(formula).toContain('bin.install "autd"')
      expect(formula).toContain(
        'bin.install_symlink "autd" => "alwaysuptodate"',
      )
      expect(formula).toContain(
        'bin.install_symlink "autd" => "always-up-to-date"',
      )
      expect(formula).toContain(
        'prefix.install "LICENSE", "third-party-licenses.txt", "BUN-LICENSE.md"',
      )
      expect(formula).toContain('strategy :github_latest')
    })

    it('takes the archives from a base URL when given one', () => {
      const root = tempDir('autd-formula-')
      const sums = path.join(root, 'SHA256SUMS')
      write(sums, `${sumsLines().join('\n')}\n`)
      const tap = path.join(root, 'tap')
      const base = 'file:///work/dist-binary'
      const result = spawnSync('sh', [render, version, sums, tap, base], {
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      const formula = fs.readFileSync(
        path.join(tap, 'Formula/always-up-to-date.rb'),
        'utf8',
      )
      const urls = formula.match(/^\s+url ".*"$/gm) ?? []
      expect(urls).toHaveLength(4)
      for (const triple of triples) {
        expect(formula).toContain(
          `url "${base}/always-up-to-date-${version}-${triple}.tar.gz"`,
        )
      }
      expect(formula).not.toContain('/releases/download/')
    })

    it.each(['1.2', 'v1.2.3', '1.2.3/../x', '1.2.3&x', '1.2.3 4', ''])(
      'refuses the version %j and writes nothing',
      (bad) => {
        const root = tempDir('autd-formula-')
        const sums = path.join(root, 'SHA256SUMS')
        write(sums, `${sumsLines().join('\n')}\n`)
        const tap = path.join(root, 'tap')
        const result = spawnSync('sh', [render, bad, sums, tap], {
          encoding: 'utf8',
        })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('invalid version')
        expect(fs.existsSync(tap)).toBe(false)
      },
    )

    it('accepts a prerelease version', () => {
      const root = tempDir('autd-formula-')
      const sums = path.join(root, 'SHA256SUMS')
      write(
        sums,
        `${sumsLines()
          .map((line) => line.replace(version, '10.0.0-rc.1'))
          .join('\n')}\n`,
      )
      const result = spawnSync(
        'sh',
        [render, '10.0.0-rc.1', sums, path.join(root, 'tap')],
        { encoding: 'utf8' },
      )
      expect(result.status).toBe(0)
    })

    it.each(triples)(
      'fails, naming the archive, without the %s line',
      (triple) => {
        const { result, tap } = run(triple)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(
          `no checksum for always-up-to-date-${version}-${triple}.tar.gz`,
        )
        expect(
          fs.existsSync(path.join(tap, 'Formula/always-up-to-date.rb')),
        ).toBe(false)
      },
    )
  },
)

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
