import fs from 'fs'
import os from 'os'
import path from 'path'
import type { PackageInfo } from '@/types'
import { toManifestNames } from '@/utils/manifestNames'

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
