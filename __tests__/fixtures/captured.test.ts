import fs from 'fs'
import os from 'os'
import path from 'path'
import semver from 'semver'
import {
  capturedPackage,
  capturedRegistry,
  installPackages,
  readRegistryBody,
} from './index'

describe('capturedPackage', () => {
  it('builds the package from the deps.dev capture and the dist-tags', () => {
    const dayjs = capturedPackage('dayjs')
    expect(dayjs.source).toBe('deps.dev')
    expect(dayjs.latest).toBe(
      JSON.parse(readRegistryBody('dayjs.dist-tags')).latest,
    )
    expect(dayjs.versions.at(-1)?.publishedAt).toBeDefined()
  })

  it('builds it from the packument capture', () => {
    expect(capturedPackage('yarn', { source: 'packument' })).toMatchObject({
      source: 'packument',
      latest: '1.22.22',
    })
  })

  it('reads a gzipped capture as its verbatim body', () => {
    expect(capturedPackage('typescript').versions.length).toBeGreaterThan(1000)
  })

  it('maps a scoped name to its capture file', () => {
    expect(capturedPackage('@types/ms').name).toBe('@types/ms')
  })

  it('drops versions published after asOf and moves latest to the highest surviving stable', () => {
    const full = capturedPackage('dayjs')
    const cutoff = full.versions.find((v) => v.version === '1.10.8')
      ?.publishedAt as string
    const earlier = capturedPackage('dayjs', { asOf: cutoff })

    expect(earlier.versions.at(-1)?.version).toBe('1.10.8')
    expect(earlier.latest).toBe('1.10.8')
    expect(
      earlier.versions.every(
        (v) => Date.parse(v.publishedAt as string) <= Date.parse(cutoff),
      ),
    ).toBe(true)
  })

  it('keeps the captured latest when it survives asOf', () => {
    const full = capturedPackage('dayjs')
    expect(capturedPackage('dayjs', { asOf: '2099-01-01T00:00:00Z' })).toEqual(
      full,
    )
  })

  it('cannot apply asOf to a packument, which has no publish times', () => {
    expect(() =>
      capturedPackage('yarn', {
        source: 'packument',
        asOf: '2025-01-01T00:00:00Z',
      }),
    ).toThrow(/no publish times/)
  })

  it('fails when nothing survives asOf', () => {
    expect(() =>
      capturedPackage('dayjs', { asOf: '2000-01-01T00:00:00Z' }),
    ).toThrow(/no version as of/)
  })

  it('picks a stable latest when the captured one is gone', () => {
    const { latest } = capturedPackage('dayjs', {
      asOf: capturedPackage('dayjs').versions[10].publishedAt,
    })
    expect(semver.prerelease(latest)).toBeNull()
  })
})

describe('capturedRegistry', () => {
  it('answers from captures and rejects any other name', async () => {
    const registry = capturedRegistry(['ms'])

    await expect(registry.lookup('ms')).resolves.toMatchObject({
      ok: true,
      package: { name: 'ms' },
    })
    await expect(registry.lookup('dayjs')).rejects.toThrow(
      /no registry capture was planned for dayjs/,
    )
  })

  it('still fails loudly on the rest of the session', () => {
    expect(() => capturedRegistry([]).releaseTimes('ms')).toThrow(/unexpected/)
  })
})

describe('installPackages', () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-install-fixture-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('writes node_modules entries under the root and a member, scoped names included', () => {
    installPackages(cwd, '.', { ms: '2.1.1', '@types/ms': '2.1.0' })
    installPackages(cwd, 'packages/a', { ms: '2.1.2' })

    const read = (file: string) =>
      JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'))
    expect(read('node_modules/ms/package.json')).toEqual({
      name: 'ms',
      version: '2.1.1',
    })
    expect(read('node_modules/@types/ms/package.json').version).toBe('2.1.0')
    expect(read('packages/a/node_modules/ms/package.json').version).toBe(
      '2.1.2',
    )
  })
})
