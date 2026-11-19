import fs from 'fs'
import path from 'path'
import {
  ARCHIVE_FILES,
  archiveName,
  binaryFileName,
  checksumLines,
  hostTarget,
  pinnedBunVersion,
  selectTargets,
  TARGETS,
  thirdPartyHeader,
  UsageError,
} from '../../scripts/binary'

const byBun = (name: string) => {
  const target = TARGETS.find((each) => each.bun === name)
  if (!target) throw new Error(`no target ${name}`)
  return target
}

describe('scripts/binary.ts', () => {
  describe('archiveName', () => {
    it('names every target by its triple, .zip for Windows only', () => {
      expect(TARGETS.map((target) => archiveName('4.1.1', target))).toEqual([
        'always-up-to-date-4.1.1-aarch64-apple-darwin.tar.gz',
        'always-up-to-date-4.1.1-x86_64-apple-darwin.tar.gz',
        'always-up-to-date-4.1.1-x86_64-unknown-linux-gnu.tar.gz',
        'always-up-to-date-4.1.1-aarch64-unknown-linux-gnu.tar.gz',
        'always-up-to-date-4.1.1-x86_64-pc-windows-msvc.zip',
      ])
    })
  })

  describe('binaryFileName', () => {
    it('adds .exe on Windows only', () => {
      expect(binaryFileName(byBun('bun-windows-x64'))).toBe('autd.exe')
      expect(binaryFileName(byBun('bun-linux-x64'))).toBe('autd')
    })
  })

  describe('selectTargets', () => {
    it('selects all five with no names', () => {
      expect(selectTargets([])).toHaveLength(5)
    })

    it('selects by Bun target or triple, in table order, once', () => {
      expect(
        selectTargets([
          'x86_64-unknown-linux-gnu',
          'bun-darwin-arm64',
          'bun-linux-x64',
        ]).map((target) => target.bun),
      ).toEqual(['bun-darwin-arm64', 'bun-linux-x64'])
    })

    it('resolves host through the host lookup', () => {
      expect(selectTargets(['host'], () => byBun('bun-linux-arm64'))).toEqual([
        byBun('bun-linux-arm64'),
      ])
    })

    it('rejects an unknown name', () => {
      expect(() => selectTargets(['bun-freebsd-x64'])).toThrow(UsageError)
    })
  })

  describe('hostTarget', () => {
    it('maps platform and arch, and rejects the unsupported', () => {
      expect(hostTarget('darwin', 'arm64').bun).toBe('bun-darwin-arm64')
      expect(hostTarget('win32', 'x64').bun).toBe('bun-windows-x64')
      expect(() => hostTarget('win32', 'arm64')).toThrow(UsageError)
    })
  })

  describe('pinnedBunVersion', () => {
    it('reads the bun line of .tool-versions', () => {
      expect(
        pinnedBunVersion('pnpm 12.21.0\nnodejs 24.22.1\nbun 1.4.4\n'),
      ).toBe('1.4.4')
      expect(pinnedBunVersion('nodejs 24.22.1\n')).toBeNull()
    })
  })

  describe('checksumLines', () => {
    it('writes sha256sum lines sorted by file name', () => {
      expect(
        checksumLines([
          { file: 'b.zip', sha256: '22' },
          { file: 'a.tar.gz', sha256: '11' },
        ]),
      ).toBe('11  a.tar.gz\n22  b.zip\n')
    })
  })

  describe('the Bun notice', () => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    const read = (...parts: string[]) =>
      fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')

    // A Bun bump fails here until packaging/bun/LICENSE.md is refreshed from
    // that release and VERSION is updated.
    it('is vendored from the bun version .tool-versions pins', () => {
      expect(read('packaging', 'bun', 'VERSION').trim()).toBe(
        pinnedBunVersion(read('.tool-versions')),
      )
      expect(read('packaging', 'bun', 'LICENSE.md')).toMatch(/MIT/)
    })

    it('ships in every archive beside the licenses file, which names Bun', () => {
      expect(ARCHIVE_FILES).toEqual([
        'LICENSE',
        'third-party-licenses.txt',
        'BUN-LICENSE.md',
      ])
      expect(thirdPartyHeader('1.4.4')).toContain(
        "includes the Bun 1.4.4 runtime. Bun's license notice is in BUN-LICENSE.md",
      )
    })
  })
})
