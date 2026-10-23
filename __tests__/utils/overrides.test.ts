import fs from 'fs'
import os from 'os'
import path from 'path'
import { findControllingOverrides } from '@/utils/overrides'

describe('findControllingOverrides', () => {
  let cwd: string

  const write = (manifest: Record<string, unknown>, workspaceYaml?: string) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))
    if (workspaceYaml !== undefined) {
      fs.writeFileSync(path.join(cwd, 'pnpm-workspace.yaml'), workspaceYaml)
    }
  }

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-overrides-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  describe('npm overrides', () => {
    it('finds packages pinned by name, by name@range and by "." in an object', () => {
      write({
        overrides: {
          dayjs: '1.11.9',
          'react@^18': '18.2.0',
          '@types/node': '20.2.5',
          lodash: { '.': '4.17.20', 'some-dep': '1.0.0' },
        },
      })

      expect(findControllingOverrides(cwd, 'npm')).toEqual({
        dayjs: { field: 'overrides', range: '1.11.9' },
        react: { field: 'overrides', range: '18.2.0' },
        '@types/node': { field: 'overrides', range: '20.2.5' },
        lodash: { field: 'overrides', range: '4.17.20' },
      })
    })

    it("skips overrides that only reach a package's dependencies, or follow its own spec", () => {
      write({
        overrides: {
          express: { qs: '6.11.0' },
          zod: '$zod',
          '@scope/pkg@^1': { '.': '$@scope/pkg' },
        },
      })

      expect(findControllingOverrides(cwd, 'npm')).toEqual({})
    })

    it('ignores fields npm does not read', () => {
      write({
        resolutions: { dayjs: '1.11.9' },
        pnpm: { overrides: { ms: '2' } },
      })

      expect(findControllingOverrides(cwd, 'npm')).toEqual({})
    })
  })

  describe('yarn resolutions (berry)', () => {
    it('finds top-level and **/ patterns, scoped or not', () => {
      write({
        packageManager: 'yarn@4.18.1',
        resolutions: {
          ms: '2.1.1',
          '**/dayjs': '1.11.9',
          '@types/react': '18.2.6',
          '**/@scope/pkg': '1.0.0',
        },
      })

      expect(findControllingOverrides(cwd, 'yarn')).toEqual({
        ms: { field: 'resolutions', range: '2.1.1' },
        dayjs: { field: 'resolutions', range: '1.11.9' },
        '@types/react': { field: 'resolutions', range: '18.2.6' },
        '@scope/pkg': { field: 'resolutions', range: '1.0.0' },
      })
    })

    it('skips a resolution nested under another package', () => {
      write({
        packageManager: 'yarn@4.18.1',
        resolutions: { 'express/qs': '6.11.0', 'a/@scope/pkg': '1.0.0' },
      })

      expect(findControllingOverrides(cwd, 'yarn')).toEqual({})
    })

    it('holds nothing on yarn v1, which does not apply resolutions to a direct dependency', () => {
      // yarn 1.22.22: dayjs "^1.11.9" with resolutions { dayjs: "1.11.9" }
      // still moved to 1.11.23 on upgrade.
      write({ resolutions: { dayjs: '1.11.9' } })

      expect(findControllingOverrides(cwd, 'yarn')).toEqual({})
    })
  })

  describe('pnpm', () => {
    it('reads overrides from pnpm-workspace.yaml, quoted keys and version selectors included', () => {
      write(
        { name: 'p' },
        [
          'packages:',
          '  - "packages/*"',
          'overrides:',
          '  ms: 2.1.1',
          '  "dayjs@<2": 1.11.9',
          "  '@types/node': 20.2.5",
          "  'express>qs': 6.11.0",
          'catalog:',
          '  react: ^18.2.0',
        ].join('\n'),
      )

      expect(findControllingOverrides(cwd, 'pnpm')).toEqual({
        ms: { field: 'overrides in pnpm-workspace.yaml', range: '2.1.1' },
        dayjs: { field: 'overrides in pnpm-workspace.yaml', range: '1.11.9' },
        '@types/node': {
          field: 'overrides in pnpm-workspace.yaml',
          range: '20.2.5',
        },
      })
    })

    it('ignores package.json fields, which pnpm 12 no longer reads', () => {
      // pnpm 12.14.0 installed ms 2.1.3 with either field set to 2.1.1.
      write({
        pnpm: { overrides: { ms: '2.1.1' } },
        resolutions: { dayjs: '1.11.9' },
      })

      expect(findControllingOverrides(cwd, 'pnpm')).toEqual({})
    })
  })

  it('reads both overrides and resolutions for bun', () => {
    write({ overrides: { ms: '2.1.1' }, resolutions: { dayjs: '1.11.9' } })

    expect(findControllingOverrides(cwd, 'bun')).toEqual({
      ms: { field: 'overrides', range: '2.1.1' },
      dayjs: { field: 'resolutions', range: '1.11.9' },
    })
  })

  it('returns nothing when the manifest cannot be read', () => {
    expect(findControllingOverrides(cwd, 'npm')).toEqual({})
  })
})
