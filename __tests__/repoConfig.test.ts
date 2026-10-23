import fs from 'fs'
import path from 'path'
import jestConfig from '../jest.config'

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
const isIgnoredForCoverage = (file: string): boolean =>
  jestConfig.coveragePathIgnorePatterns.some((pattern) =>
    new RegExp(pattern.replace('<rootDir>', repoRoot)).test(
      path.join(repoRoot, file),
    ),
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
      'src/utils/index.ts',
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
})
