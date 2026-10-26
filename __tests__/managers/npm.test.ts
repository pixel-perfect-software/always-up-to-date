import fs from 'fs'
import os from 'os'
import path from 'path'
import { readLockedVersions } from '@/managers/npm'

jest.mock('@/utils/logger')

describe('readLockedVersions', () => {
  it('reads every install path package-lock.json records', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-lock-'))
    fs.copyFileSync(
      path.join(__dirname, '../fixtures/npm/no-node-modules.package-lock.json'),
      path.join(cwd, 'package-lock.json'),
    )

    try {
      expect(readLockedVersions(cwd)).toMatchObject({
        'node_modules/chalk': '4.0.0',
        'node_modules/ms': '2.1.1',
      })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('is empty without a readable lockfile', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-lock-'))

    try {
      expect(readLockedVersions(cwd)).toEqual({})
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
