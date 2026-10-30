jest.mock('@/utils/logger')

import fs from 'fs'
import os from 'os'
import path from 'path'
import detectPackageManager from '@/detectPackageManager'
import { StepError } from '@/stepError'
import logger from '@/utils/logger'

describe('detectPackageManager', () => {
  let cwd: string

  const write = (file: string, content = '') =>
    fs.writeFileSync(path.join(cwd, file), content)
  const manifest = (fields: Record<string, unknown>) =>
    write('package.json', JSON.stringify({ name: 'project', ...fields }))
  const debugLines = () => jest.mocked(logger.debug).mock.calls.map(([l]) => l)

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-detect-'))
    manifest({})
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  describe('from the lockfile, when package.json declares nothing', () => {
    it.each([
      ['package-lock.json', 'npm'],
      ['yarn.lock', 'yarn'],
      ['pnpm-lock.yaml', 'pnpm'],
      ['bun.lock', 'bun'],
    ])('detects %s as %s', (lockfile, pm) => {
      write(lockfile)

      expect(detectPackageManager(cwd)).toBe(pm)
      expect(debugLines()).toEqual([`Using ${pm}: ${lockfile}`])
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('fails the detect step when there is no lockfile either', () => {
      const detect = () => detectPackageManager(cwd)

      expect(detect).toThrow(StepError)
      expect(detect).toThrow(
        'No package manager detected in the current directory: package.json declares none and there is no lockfile. Pass --pm npm|yarn|pnpm|bun to choose one.',
      )
    })

    it('names the lockfile it chose when there are several', () => {
      write('package-lock.json')
      write('pnpm-lock.yaml')

      expect(detectPackageManager(cwd)).toBe('pnpm')
      expect(logger.warn).toHaveBeenCalledWith(
        'Found package-lock.json, pnpm-lock.yaml; using pnpm (pnpm-lock.yaml), since autd prefers bun, pnpm, yarn, then npm. Set "packageManager" in package.json or pass --pm to choose.',
      )
    })

    it('reads the lockfile when package.json cannot be parsed', () => {
      write('package.json', '{ not json')
      write('yarn.lock')

      expect(detectPackageManager(cwd)).toBe('yarn')
    })
  })

  describe('from packageManager', () => {
    it('ignores a stray lockfile from another manager', () => {
      // Before: the stray yarn.lock won and yarn v1 refused to run.
      manifest({ packageManager: 'npm@11.19.1' })
      write('package-lock.json')
      write('yarn.lock')

      expect(detectPackageManager(cwd)).toBe('npm')
      expect(logger.warn).not.toHaveBeenCalled()
      expect(debugLines()).toEqual([
        'Using npm: packageManager in package.json',
        'Ignoring yarn.lock: package.json declares npm.',
      ])
    })

    it('needs no lockfile', () => {
      manifest({ packageManager: 'pnpm@12.14.0' })

      expect(detectPackageManager(cwd)).toBe('pnpm')
    })

    it('reads the name before a Corepack hash', () => {
      manifest({ packageManager: 'yarn@4.12.0+sha512.abc123' })

      expect(detectPackageManager(cwd)).toBe('yarn')
    })

    it('wins over devEngines.packageManager', () => {
      manifest({
        packageManager: 'bun@1.4.0',
        devEngines: { packageManager: { name: 'npm' } },
      })

      expect(detectPackageManager(cwd)).toBe('bun')
    })

    it('fails the detect step for a manager autd does not support', () => {
      manifest({ packageManager: ' deno@2.5.0 ' })
      write('package-lock.json')

      expect(() => detectPackageManager(cwd)).toThrow(
        'package.json declares packageManager deno@2.5.0, and autd supports npm, yarn, pnpm, bun. Pass --pm to choose one.',
      )
    })

    it('falls through to devEngines when it names an unsupported manager', () => {
      manifest({
        packageManager: 'deno@2.5.0',
        devEngines: { packageManager: [{ name: 'deno' }, { name: 'pnpm' }] },
      })

      expect(detectPackageManager(cwd)).toBe('pnpm')
    })

    it('warns when the declared manager has no lockfile but another has', () => {
      manifest({ packageManager: 'pnpm@12.14.0' })
      write('package-lock.json')

      expect(detectPackageManager(cwd)).toBe('pnpm')
      expect(logger.warn).toHaveBeenCalledWith(
        'package.json declares pnpm in packageManager, but the only lockfile is package-lock.json. Using pnpm.',
      )
    })
  })

  describe('from devEngines.packageManager', () => {
    it('reads a single entry over a stray lockfile', () => {
      manifest({
        devEngines: { packageManager: { name: 'bun', onFail: 'error' } },
      })
      write('bun.lock')
      write('package-lock.json')

      expect(detectPackageManager(cwd)).toBe('bun')
      expect(logger.warn).not.toHaveBeenCalled()
      expect(debugLines()).toEqual([
        'Using bun: devEngines.packageManager in package.json',
        'Ignoring package-lock.json: package.json declares bun.',
      ])
    })

    it('picks the accepted manager the project has a lockfile for', () => {
      manifest({
        devEngines: { packageManager: [{ name: 'pnpm' }, { name: 'npm' }] },
      })
      write('package-lock.json')

      expect(detectPackageManager(cwd)).toBe('npm')
    })

    it('picks the first accepted manager when none has a lockfile', () => {
      manifest({
        devEngines: { packageManager: [{ name: 'pnpm' }, { name: 'npm' }] },
      })

      expect(detectPackageManager(cwd)).toBe('pnpm')
    })

    it('skips accepted managers autd does not support', () => {
      manifest({
        devEngines: { packageManager: [{ name: 'deno' }, { name: 'yarn' }] },
      })

      expect(detectPackageManager(cwd)).toBe('yarn')
    })

    it('fails the detect step when it accepts no supported manager', () => {
      manifest({ devEngines: { packageManager: { name: 'deno' } } })

      expect(() => detectPackageManager(cwd)).toThrow(
        'package.json declares devEngines.packageManager {"name":"deno"}, and autd supports npm, yarn, pnpm, bun. Pass --pm to choose one.',
      )
    })

    it('falls back to the lockfile when the entries name nothing', () => {
      manifest({ devEngines: { packageManager: [] } })
      write('bun.lock')

      expect(detectPackageManager(cwd)).toBe('bun')
    })
  })

  describe('from --pm', () => {
    it('overrides packageManager and every lockfile, with a warning', () => {
      manifest({ packageManager: 'npm@11.19.1' })
      write('package-lock.json')
      write('yarn.lock')

      expect(detectPackageManager(cwd, 'yarn')).toBe('yarn')
      expect(logger.warn).toHaveBeenCalledWith(
        '--pm yarn overrides packageManager npm@11.19.1 in package.json. With Corepack enabled, yarn may refuse to run here.',
      )
      expect(debugLines()).toEqual([
        'Using yarn: --pm yarn',
        'Ignoring package-lock.json: --pm yarn.',
      ])
    })

    it('does not warn when it agrees with package.json', () => {
      manifest({
        packageManager: 'pnpm@12.14.0',
        devEngines: { packageManager: [{ name: 'npm' }, { name: 'pnpm' }] },
      })

      expect(detectPackageManager(cwd, 'pnpm')).toBe('pnpm')
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('needs neither a declaration nor a lockfile', () => {
      expect(detectPackageManager(cwd, 'bun')).toBe('bun')
    })
  })

  // A workspace member's run detects at the workspace root (#123).
  describe('from a workspace member', () => {
    let member: string
    const writeMember = (fields: Record<string, unknown> = {}) => {
      fs.mkdirSync(member, { recursive: true })
      fs.writeFileSync(
        path.join(member, 'package.json'),
        JSON.stringify({ name: 'member', ...fields }),
      )
    }

    beforeEach(() => {
      member = path.join(cwd, 'packages', 'a')
    })

    it("reads the root's packageManager", () => {
      manifest({ packageManager: 'yarn@4.12.0' })
      writeMember()

      expect(detectPackageManager(cwd, undefined, { from: member })).toBe(
        'yarn',
      )
      expect(debugLines()).toEqual([
        'Using yarn: packageManager in ../../package.json',
      ])
    })

    it("reads the root's lockfile", () => {
      write('pnpm-lock.yaml')
      writeMember()

      expect(detectPackageManager(cwd, undefined, { from: member })).toBe(
        'pnpm',
      )
      expect(debugLines()).toEqual(['Using pnpm: pnpm-lock.yaml'])
    })

    it("prefers the member's own declaration, labelled package.json", () => {
      manifest({ packageManager: 'yarn@4.12.0' })
      writeMember({ packageManager: 'pnpm@12.14.0' })

      expect(detectPackageManager(cwd, undefined, { from: member })).toBe(
        'pnpm',
      )
      expect(debugLines()).toEqual([
        'Using pnpm: packageManager in package.json',
      ])
    })

    it('names the declaring file when --pm contradicts it', () => {
      manifest({ packageManager: 'npm@11.19.1' })
      writeMember()

      expect(detectPackageManager(cwd, 'bun', { from: member })).toBe('bun')
      expect(logger.warn).toHaveBeenCalledWith(
        '--pm bun overrides packageManager npm@11.19.1 in ../../package.json. With Corepack enabled, bun may refuse to run here.',
      )
    })

    it('names the root when nothing is declared or locked', () => {
      writeMember()
      fs.rmSync(path.join(cwd, 'package.json'))

      expect(() =>
        detectPackageManager(cwd, undefined, { from: member }),
      ).toThrow(
        `No package manager detected in ${cwd}: package.json declares none`,
      )
    })
  })

  // Messages are read from the directory the user ran in, which can sit
  // below the member (#123).
  describe('from a directory inside a member', () => {
    let member: string
    let inside: string

    beforeEach(() => {
      member = path.join(cwd, 'packages', 'a')
      inside = path.join(member, 'src')
      fs.mkdirSync(inside, { recursive: true })
      fs.writeFileSync(
        path.join(member, 'package.json'),
        JSON.stringify({ name: 'member' }),
      )
    })

    it('labels the declaring file relative to the cwd', () => {
      manifest({ packageManager: 'yarn@4.12.0' })

      expect(
        detectPackageManager(cwd, undefined, { from: member, cwd: inside }),
      ).toBe('yarn')
      expect(debugLines()).toEqual([
        'Using yarn: packageManager in ../../../package.json',
      ])
    })

    it("labels the member's own declaration relative to the cwd", () => {
      fs.writeFileSync(
        path.join(member, 'package.json'),
        JSON.stringify({ name: 'member', packageManager: 'pnpm@12.14.0' }),
      )

      detectPackageManager(cwd, 'bun', { from: member, cwd: inside })

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('pnpm@12.14.0 in ../package.json.'),
      )
    })

    it('names the searched directory when it is not the cwd', () => {
      expect(() =>
        detectPackageManager(member, undefined, { from: member, cwd: inside }),
      ).toThrow(`No package manager detected in ${member}: package.json`)
    })
  })
})
