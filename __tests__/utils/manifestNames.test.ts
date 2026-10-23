import fs from 'fs'
import os from 'os'
import path from 'path'
import type { PackageInfo } from '@/types'
import { toEntryManifestNames, toManifestNames } from '@/utils/manifestNames'

const info = (name: string): PackageInfo => ({
  name,
  current: '1.0.0',
  wanted: '1.0.0',
  latest: '1.0.1',
})

describe('toManifestNames', () => {
  let cwd: string

  const write = (manifest: Record<string, unknown>) =>
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-names-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it("re-keys npm's alias key and a target name to the manifest key", () => {
    write({
      dependencies: { dj: 'npm:dayjs@1.11.9', ui: 'npm:@scope/ui@^2.0.0' },
    })

    const renamed = toManifestNames(cwd, {
      'dj:dayjs@1.11.9': info('dj:dayjs@1.11.9'),
      '@scope/ui': info('@scope/ui'),
    })

    expect(Object.keys(renamed)).toEqual(['dj', 'ui'])
    expect(renamed.ui.name).toBe('ui')
  })

  it('keeps a name the manifest lists directly, even if an alias targets it', () => {
    write({ dependencies: { dayjs: '^1.11.9', dj: 'npm:dayjs@1.11.9' } })

    expect(Object.keys(toManifestNames(cwd, { dayjs: info('dayjs') }))).toEqual(
      ['dayjs'],
    )
  })

  it('leaves the report alone when package.json cannot be read', () => {
    const report = { 'dj:dayjs@1.11.9': info('dj:dayjs@1.11.9') }

    expect(toManifestNames(cwd, report)).toBe(report)
  })
})

describe('toEntryManifestNames', () => {
  it("re-keys an alias only a member declares by that member's key", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-entry-names-'))
    try {
      fs.mkdirSync(path.join(cwd, 'packages/a'), { recursive: true })
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ dependencies: { dayjs: '1.11.9' } }),
      )
      fs.writeFileSync(
        path.join(cwd, 'packages/a/package.json'),
        JSON.stringify({ dependencies: { dj: 'npm:dayjs@1.11.9' } }),
      )
      const entry = (name: string, workspace: string) => ({
        name,
        workspace,
        current: '1.11.9',
        wanted: '1.11.9',
        latest: '1.11.23',
      })

      const renamed = toEntryManifestNames(cwd, [
        entry('dayjs', '.'),
        entry('dayjs', 'packages/a'),
        entry('dj:dayjs@1.11.9', 'packages/a'),
      ])

      expect(renamed.map((e) => [e.workspace, e.name])).toEqual([
        ['.', 'dayjs'],
        ['packages/a', 'dj'],
        ['packages/a', 'dj'],
      ])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('leaves names alone for a manifest it cannot read', () => {
    const renamed = toEntryManifestNames('/does/not/exist', [
      {
        name: 'ms',
        workspace: 'packages/a',
        current: '1',
        wanted: '1',
        latest: '2',
      },
    ])

    expect(renamed[0].name).toBe('ms')
  })
})
