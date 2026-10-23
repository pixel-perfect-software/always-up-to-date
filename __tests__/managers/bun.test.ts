import fs from 'fs'
import os from 'os'
import path from 'path'
import BunManager from '@/managers/bun'
import { exitError, readFixture } from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils/config')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

describe('BunManager.checkPackageVersions', () => {
  let manager: BunManager

  beforeEach(() => {
    manager = new BunManager()
  })

  it('carries wanted from the Update column', async () => {
    mockedRunProcess.mockResolvedValue({
      stdout: readFixture('bun/outdated-ranges.stdout'),
      stderr: '',
    })

    const result = await manager.checkPackageVersions('/project')

    expect(result.react).toMatchObject({
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    })
    expect(result.minimist).toMatchObject({ current: '1.2.7', wanted: '1.2.7' })
  })

  it('lists outdated packages when bun exits 0 with its table', async () => {
    mockedRunProcess.mockResolvedValue({
      stdout: readFixture('bun/outdated.stdout'),
      stderr: '',
    })

    const result = await manager.checkPackageVersions('/project')

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.dayjs).toEqual({
      name: 'dayjs',
      current: '1.11.9',
      wanted: '1.11.9',
      latest: '1.11.23',
    })
  })

  it('fails when bun exits 1, even though it printed part of a report', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(
        1,
        readFixture('bun/outdated-error.stdout'),
        readFixture('bun/outdated-error.stderr'),
      ),
    )

    await expect(manager.checkPackageVersions('/project')).rejects.toThrow(
      /ConnectionRefused/,
    )
  })

  it('passes the workspace filter as a bare * argument', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-bun-'))
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    )
    mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })

    try {
      await manager.checkPackageVersions(cwd)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }

    // Before argument arrays this was the shell string `--filter '*'`.
    expect(mockedRunProcess).toHaveBeenCalledWith(
      'bun',
      ['outdated', '--filter', '*'],
      { cwd },
    )
  })
})
