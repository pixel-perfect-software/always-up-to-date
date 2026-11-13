import fs from 'fs'
import path from 'path'
import { runProcess } from '@/utils/runProcess'
import { tempDir } from '../fixtures/files'

// The real scripts/ directory run by Node's type stripping, as `pnpm run
// build` runs it, on a project of its own in a temp directory (so the repo's
// dist/ is never touched). esbuild is linked from this repository.
const repoRoot = path.resolve(__dirname, '..', '..')

describe('scripts/build.mts', () => {
  let tmp: string
  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(at(file)), { recursive: true })
      fs.writeFileSync(at(file), content)
    }
  }

  beforeEach(() => {
    tmp = tempDir('autd-build-', { real: true })
    fs.cpSync(path.join(repoRoot, 'scripts'), at('scripts'), {
      recursive: true,
    })
    write({
      'package.json': '{"name":"fixture","dependencies":{}}',
      'tsconfig.json': '{}',
      'src/index.ts': "import('./cli')",
      'src/cli.ts': "console.log('cli')",
    })
    fs.mkdirSync(at('node_modules'))
    fs.symlinkSync(
      fs.realpathSync(path.join(repoRoot, 'node_modules', 'esbuild')),
      at('node_modules', 'esbuild'),
      'junction',
    )
  })

  async function runBuild(): Promise<{
    code: number
    stdout: string
    stderr: string
  }> {
    try {
      const { stdout, stderr } = await runProcess(
        process.execPath,
        ['scripts/build.mts'],
        { cwd: tmp },
      )
      return { code: 0, stdout, stderr }
    } catch (error) {
      const { code, stdout, stderr } = error as {
        code: number
        stdout: string
        stderr: string
      }
      return { code, stdout, stderr }
    }
  }

  it('writes the bundle and the licenses and prints one summary line', async () => {
    const { code, stdout } = await runBuild()

    expect(code).toBe(0)
    expect(stdout.trim()).toMatch(
      /^dist\/index\.cjs: \d+\.\d KB, 2 inputs on the startup path, 0 bundled packages licensed$/,
    )
    expect(fs.existsSync(at('dist', 'index.cjs'))).toBe(true)
    expect(fs.existsSync(at('dist', 'third-party-licenses.txt'))).toBe(true)
  })

  it('runs without a module-type warning from Node', async () => {
    const { code, stderr } = await runBuild()

    expect(code).toBe(0)
    expect(stderr).not.toContain('MODULE_TYPELESS_PACKAGE_JSON')
  })

  it('empties dist/ before it bundles', async () => {
    write({ 'dist/left-from-another-branch.js': 'stale' })

    expect((await runBuild()).code).toBe(0)

    expect(fs.existsSync(at('dist', 'left-from-another-branch.js'))).toBe(false)
  })

  it('fails a check with the chain on stderr and leaves no dist/', async () => {
    write({
      'src/index.ts': "import('./cli')\nimport './pipeline'",
      'src/pipeline.ts': "console.log('pipeline')",
    })

    const { code, stderr } = await runBuild()

    expect(code).toBe(1)
    expect(stderr).toContain(
      'build: src/pipeline.ts loads at startup: src/index.ts → src/pipeline.ts',
    )
    expect(fs.existsSync(at('dist'))).toBe(false)
  })

  it('does not report a failure that is not a check as one', async () => {
    write({ 'src/cli.ts': 'const = ;' })

    const { code, stderr } = await runBuild()

    expect(code).not.toBe(0)
    expect(stderr).not.toMatch(/^build: /m)
  })
})
