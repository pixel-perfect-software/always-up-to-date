import semver from 'semver'
import type { RegistryPackage } from '@/types'
import { wantedVersion } from '@/utils/wanted'
import { capturedPackage } from '../fixtures'

// Every case runs on both sources the reader can produce.
describe.each(['deps.dev', 'packument'] as const)(
  'wantedVersion (%s)',
  (source) => {
    describe('yarn: latest is below a higher stable version tagged berry', () => {
      const yarn = capturedPackage('yarn', { source })

      it('guards the capture', () => {
        expect(yarn.latest).toBe('1.22.22')
        expect(
          yarn.versions.find((v) => v.version === '2.4.3')?.deprecated,
        ).toBe(false)
      })

      it.each(['*', '>=1.0.0', '^1.0.0'])(
        'prefers latest over the higher 2.4.3 for %s',
        (range) => {
          expect(wantedVersion(range, yarn)).toBe('1.22.22')
        },
      )

      it('takes 2.4.3 for ^2.0.0 and leaves the 2.0.0-rc versions out', () => {
        expect(
          yarn.versions.some(
            (v) =>
              semver.prerelease(v.version)?.length &&
              v.version.startsWith('2.0.0-rc'),
          ),
        ).toBe(true)
        expect(wantedVersion('^2.0.0', yarn)).toBe('2.4.3')
      })

      it('takes 2.4.3 for * without the latest preference', () => {
        expect(wantedVersion('*', yarn, { preferLatest: false })).toBe('2.4.3')
      })

      it('prefers latest by default', () => {
        expect(wantedVersion('*', yarn, { preferLatest: true })).toBe('1.22.22')
      })

      it('gives an exact pin itself', () => {
        expect(wantedVersion('1.22.19', yarn)).toBe('1.22.19')
        expect(wantedVersion('=1.22.19', yarn)).toBe('1.22.19')
        expect(wantedVersion('v1.22.19', yarn)).toBe('1.22.19')
      })

      it('gives undefined when nothing satisfies the range', () => {
        expect(wantedVersion('^99.0.0', yarn)).toBeUndefined()
      })
    })

    describe('pnpm: a deprecated version in the range', () => {
      const pnpm = capturedPackage('pnpm', { source })

      it('guards the capture', () => {
        const deprecated = (version: string) =>
          pnpm.versions.find((v) => v.version === version)?.deprecated
        expect(deprecated('5.18.10')).toBe(false)
        expect(deprecated('5.18.11')).toBe(true)
      })

      it('skips deprecated 5.18.11 for ~5.18.0', () => {
        expect(wantedVersion('~5.18.0', pnpm)).toBe('5.18.10')
      })

      it('gives an exact pin itself even when it is deprecated', () => {
        expect(wantedVersion('5.18.11', pnpm)).toBe('5.18.11')
      })

      it('takes the highest when every satisfying version is deprecated', () => {
        expect(wantedVersion('>=5.18.11 <5.18.12', pnpm)).toBe('5.18.11')
      })

      it('falls back to the highest stable non-deprecated version below a deprecated latest', () => {
        const deprecatedLatest: RegistryPackage = {
          ...pnpm,
          versions: pnpm.versions.map((v) =>
            v.version === pnpm.latest ? { ...v, deprecated: true } : v,
          ),
        }
        const expected = pnpm.versions
          .filter((v) => !v.deprecated && !semver.prerelease(v.version))
          .map((v) => v.version)
          .filter((version) => semver.lt(version, pnpm.latest))
          .at(-1)

        expect(expected).toBeDefined()
        expect(wantedVersion('*', deprecatedLatest)).toBe(expected)
      })

      it('excludes a prerelease from a plain range and includes it for a range naming its tuple', () => {
        const prerelease = pnpm.versions.find(
          (v) => semver.prerelease(v.version) && !v.deprecated,
        )
        expect(prerelease).toBeDefined()
        const pre = (prerelease as { version: string }).version
        const tuple = `${semver.major(pre)}.${semver.minor(pre)}.${semver.patch(pre)}`

        const plain = wantedVersion(`^${semver.major(pre)}`, pnpm)
        expect(plain).toBeDefined()
        expect(semver.prerelease(plain as string)).toBeNull()

        const named = wantedVersion(`>=${pre} <${tuple}`, pnpm, {
          preferLatest: false,
        }) as string
        expect(semver.prerelease(named)).not.toBeNull()
        expect(semver.gte(named, pre)).toBe(true)
        expect(
          `${semver.major(named)}.${semver.minor(named)}.${semver.patch(named)}`,
        ).toBe(tuple)
      })
    })
  },
)
