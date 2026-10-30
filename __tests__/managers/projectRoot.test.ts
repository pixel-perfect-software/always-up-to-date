import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm, { pnpmWorkspaceRoot } from '@/managers/pnpm'
import { packageJsonWorkspaceRoot } from '@/managers/workspaces'
import yarn, { isYarnBerry } from '@/managers/yarn'
import { berryProjectRoot } from '@/managers/yarn/berry'
import { StepError } from '@/stepError'

// Each manager's project root for a directory (#123), on real temp directories.
describe('projectRoot', () => {
  let tmp: string
  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (file: string, content = '') => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const manifest = (dir: string[], fields: Record<string, unknown> = {}) =>
    write(at(...dir, 'package.json'), JSON.stringify({ name: 'p', ...fields }))

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autd-root-')))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('packageJsonWorkspaceRoot (npm, yarn v1, bun)', () => {
    beforeEach(() => {
      manifest([], { workspaces: ['packages/*'] })
      manifest(['packages', 'a'])
      manifest(['tools', 'x'])
    })

    it('is the listing ancestor for a member, else the directory', () => {
      expect(packageJsonWorkspaceRoot(at('packages', 'a'))).toBe(tmp)
      expect(packageJsonWorkspaceRoot(at('tools', 'x'))).toBe(at('tools', 'x'))
      expect(packageJsonWorkspaceRoot(tmp)).toBe(tmp)
    })

    it.each([npm, bun])('is the adapter rule for $name', (adapter) => {
      expect(adapter.projectRoot(at('packages', 'a'))).toBe(tmp)
    })
  })

  describe('pnpmWorkspaceRoot', () => {
    it('is the yaml directory when its packages list the directory', () => {
      manifest([])
      write(at('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
      manifest(['packages', 'a'])

      expect(pnpmWorkspaceRoot(at('packages', 'a'))).toBe(tmp)
      expect(pnpm.projectRoot(at('packages', 'a'))).toBe(tmp)
    })

    it('is the directory itself when the yaml does not list it', () => {
      manifest([])
      write(at('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
      manifest(['tools', 'x'])

      expect(pnpmWorkspaceRoot(at('tools', 'x'))).toBe(at('tools', 'x'))
    })

    it('is the directory itself when the root yaml is catalog-only', () => {
      manifest([])
      write(at('pnpm-workspace.yaml'), 'catalog:\n  ms: ^2\n')
      manifest(['packages', 'a'])

      expect(pnpmWorkspaceRoot(at('packages', 'a'))).toBe(at('packages', 'a'))
    })

    it("is the member itself when it has its own yaml, even with 'packages: []'", () => {
      manifest([])
      write(at('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
      manifest(['packages', 'a'])
      write(at('packages', 'a', 'pnpm-workspace.yaml'), 'packages: []\n')

      expect(pnpmWorkspaceRoot(at('packages', 'a'))).toBe(at('packages', 'a'))
    })

    it('is the root for the root', () => {
      manifest([])
      write(at('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')

      expect(pnpmWorkspaceRoot(tmp)).toBe(tmp)
    })
  })

  describe('berryProjectRoot', () => {
    beforeEach(() => {
      manifest([], {
        workspaces: ['packages/*'],
        packageManager: 'yarn@4.12.0',
      })
      write(at('yarn.lock'))
      manifest(['packages', 'a'])
    })

    it('is the directory with the yarn.lock, from a member', () => {
      expect(berryProjectRoot(at('packages', 'a'))).toBe(tmp)
      expect(berryProjectRoot(tmp)).toBe(tmp)
    })

    it('is the member itself when it has a yarn.lock of its own', () => {
      write(at('packages', 'a', 'yarn.lock'))

      expect(berryProjectRoot(at('packages', 'a'))).toBe(at('packages', 'a'))
    })

    it('fails the detect step for a directory the root does not list', () => {
      manifest(['tools', 'x'])

      const call = () => berryProjectRoot(at('tools', 'x'))
      expect(call).toThrow(StepError)
      expect(call).toThrow(
        /tools\/x is not listed in "workspaces" of .*package\.json/,
      )
      try {
        call()
      } catch (error) {
        expect((error as StepError).step).toBe('detect')
      }
    })

    it('is what the yarn adapter uses once berry is identified', () => {
      expect(yarn.projectRoot(at('packages', 'a'))).toBe(tmp)
      manifest(['tools', 'x'])
      expect(() => yarn.projectRoot(at('tools', 'x'))).toThrow(StepError)
    })
  })

  describe('isYarnBerry', () => {
    it('is true for a member of a yarn@4 root', () => {
      manifest([], {
        workspaces: ['packages/*'],
        packageManager: 'yarn@4.12.0',
      })
      manifest(['packages', 'a'])

      expect(isYarnBerry(at('packages', 'a'))).toBe(true)
      expect(isYarnBerry(tmp)).toBe(true)
    })

    it('is true for a member of a root with only a .yarnrc.yml', () => {
      manifest([], { workspaces: ['packages/*'] })
      write(at('.yarnrc.yml'), 'nodeLinker: node-modules\n')
      manifest(['packages', 'a'])

      expect(isYarnBerry(at('packages', 'a'))).toBe(true)
    })

    it('is false for a member of a yarn@1 root with a stray .yarnrc.yml', () => {
      manifest([], {
        workspaces: ['packages/*'],
        packageManager: 'yarn@1.22.22',
      })
      write(at('.yarnrc.yml'), 'nodeLinker: node-modules\n')
      manifest(['packages', 'a'])

      expect(isYarnBerry(at('packages', 'a'))).toBe(false)
      expect(isYarnBerry(tmp)).toBe(false)
    })

    it('is false for a member declaring yarn@1 under a berry root', () => {
      manifest([], {
        workspaces: ['packages/*'],
        packageManager: 'yarn@4.12.0',
      })
      write(at('yarn.lock'))
      manifest(['packages', 'a'], { packageManager: 'yarn@1.22.22' })

      expect(isYarnBerry(at('packages', 'a'))).toBe(false)
    })

    it('does not look above a directory no root lists', () => {
      write(at('.yarnrc.yml'), 'nodeLinker: node-modules\n')
      manifest([], { workspaces: ['packages/*'] })
      manifest(['tools', 'x'])

      expect(isYarnBerry(at('tools', 'x'))).toBe(false)
    })

    it('is false for a plain directory', () => {
      manifest([])

      expect(isYarnBerry(tmp)).toBe(false)
    })
  })
})
