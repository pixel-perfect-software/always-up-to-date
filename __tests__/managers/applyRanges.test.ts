import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { update } from '@/pipeline'
import type { PackageInfo } from '@/types'
import { isolateNpmConfig, projectFor } from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

// react ^18.2.0 can move to 18.3.1 within its range; dayjs is pinned.
const manifest = { dependencies: { react: '^18.2.0', dayjs: '1.11.9' } }
const outdated: Record<string, PackageInfo> = {
  react: {
    name: 'react',
    current: '18.2.0',
    wanted: '18.3.1',
    latest: '19.3.1',
  },
  dayjs: {
    name: 'dayjs',
    current: '1.11.9',
    wanted: '1.11.9',
    latest: '1.11.23',
  },
}

// Keep the developer's own npm configuration out of every case.
let npmConfigDir: string
let restoreNpmConfig: () => void
beforeEach(() => {
  npmConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-config-'))
  restoreNpmConfig = isolateNpmConfig(npmConfigDir)
})
afterEach(() => {
  restoreNpmConfig()
  fs.rmSync(npmConfigDir, { recursive: true, force: true })
})

describe.each([
  {
    pm: 'npm',
    adapter: npm,
    inRange: ['update', 'react'],
    mixed: ['update', 'react', 'dayjs'],
    autdWritesManifest: true,
  },
  {
    pm: 'pnpm',
    adapter: pnpm,
    inRange: ['update', 'react'],
    mixed: ['update', 'react', 'dayjs'],
    autdWritesManifest: true,
  },
  {
    pm: 'yarn',
    adapter: yarn,
    inRange: ['upgrade', 'react@^18.2.0'],
    mixed: ['upgrade', 'react@^18.2.0', 'dayjs@1.11.23'],
    autdWritesManifest: false,
  },
  {
    pm: 'bun',
    adapter: bun,
    inRange: ['update', 'react'],
    mixed: ['update', 'react', 'dayjs'],
    autdWritesManifest: true,
  },
] as const)(
  '$pm apply',
  ({ pm, adapter, inRange, mixed, autdWritesManifest }) => {
    let cwd: string

    const writeManifest = (content: Record<string, unknown>) =>
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(content))

    const readManifest = () =>
      JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))

    beforeEach(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-apply-${pm}-`))
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))
      mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })
    })

    afterEach(() => {
      fs.rmSync(cwd, { recursive: true, force: true })
    })

    it('hands an in-range update to the manager without touching package.json', async () => {
      const results = await update(projectFor(adapter, cwd), {
        discovered: outdated,
      })

      expect(mockedRunProcess).toHaveBeenCalledTimes(1)
      expect(mockedRunProcess).toHaveBeenCalledWith(pm, [...inRange], { cwd })
      expect(readManifest()).toEqual(manifest)
      expect(results.find((r) => r.name === 'dayjs')).toMatchObject({
        updated: false,
        reason: 'patch beyond the range',
      })
    })

    it("holds a package its manager's override field controls", async () => {
      // Each manager's own field, as its current version reads it.
      const pinReact: Record<string, () => void> = {
        npm: () =>
          writeManifest({ ...manifest, overrides: { react: '18.2.0' } }),
        yarn: () =>
          writeManifest({
            ...manifest,
            packageManager: 'yarn@4.18.1',
            resolutions: { react: '18.2.0' },
          }),
        bun: () =>
          writeManifest({ ...manifest, overrides: { react: '18.2.0' } }),
        pnpm: () =>
          fs.writeFileSync(
            path.join(cwd, 'pnpm-workspace.yaml'),
            'overrides:\n  react: 18.2.0\n',
          ),
      }
      pinReact[pm]()

      const results = await update(projectFor(adapter, cwd), {
        discovered: outdated,
      })

      expect(results.find((r) => r.name === 'react')).toMatchObject({
        updated: false,
        reason: expect.stringMatching(/^controlled by /),
      })
      expect(mockedRunProcess).not.toHaveBeenCalled()
    })

    it('writes the new spec only for packages moving past their range', async () => {
      // allowMinorUpdates lets the pinned dayjs move by a patch.
      await update(projectFor(adapter, cwd, { allowMinorUpdates: true }), {
        discovered: outdated,
      })

      expect(mockedRunProcess).toHaveBeenCalledWith(pm, [...mixed], { cwd })
      expect(readManifest().dependencies).toEqual(
        autdWritesManifest
          ? { react: '^18.2.0', dayjs: '1.11.23' }
          : manifest.dependencies,
      )
    })
  },
)
