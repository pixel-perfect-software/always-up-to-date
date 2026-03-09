import type { PackageInfo } from '@/types'
import type updateCheckerType from '@/utils/updateChecker'

const makePackage = (
  name: string,
  current: string,
  latest: string,
): PackageInfo => ({ name, current, latest })

const mockLogger = {
  __esModule: true,
  default: {
    error: jest.fn(),
    skippingPackage: jest.fn(),
  },
}

function loadCheckerWithConfig(config: Record<string, unknown>) {
  let checker: typeof updateCheckerType
  jest.isolateModules(() => {
    jest.doMock('@/utils/config', () => ({
      loadConfig: () => ({
        allowMinorUpdates: false,
        allowMajorUpdates: false,
        debug: false,
        silent: false,
        updateAllowlist: [],
        updateDenylist: [],
        ...config,
      }),
    }))
    jest.doMock('@/utils/logger', () => mockLogger)
    // biome-ignore lint/style/noCommonJs: jest.isolateModules requires synchronous require
    checker = require('@/utils/updateChecker').default
  })
  return checker!
}

describe('updateChecker', () => {
  describe('patch updates', () => {
    const checker = loadCheckerWithConfig({})

    it('allows patch updates by default', () => {
      expect(checker(makePackage('foo', '1.0.0', '1.0.1'))).toBe(true)
    })

    it('allows multi-step patch updates', () => {
      expect(checker(makePackage('foo', '1.0.0', '1.0.5'))).toBe(true)
    })
  })

  describe('minor updates', () => {
    it('blocks minor updates by default', () => {
      const checker = loadCheckerWithConfig({})
      expect(checker(makePackage('foo', '1.0.0', '1.1.0'))).toBe(false)
    })

    it('allows minor updates when allowMinorUpdates is true', () => {
      const checker = loadCheckerWithConfig({ allowMinorUpdates: true })
      expect(checker(makePackage('foo', '1.0.0', '1.1.0'))).toBe(true)
    })
  })

  describe('major updates', () => {
    it('blocks major updates by default', () => {
      const checker = loadCheckerWithConfig({})
      expect(checker(makePackage('foo', '1.0.0', '2.0.0'))).toBe(false)
    })

    it('allows major updates when allowMajorUpdates is true', () => {
      const checker = loadCheckerWithConfig({ allowMajorUpdates: true })
      expect(checker(makePackage('foo', '1.0.0', '2.0.0'))).toBe(true)
    })

    it('allows minor updates when allowMajorUpdates is true (implies minor)', () => {
      const checker = loadCheckerWithConfig({ allowMajorUpdates: true })
      expect(checker(makePackage('foo', '1.0.0', '1.1.0'))).toBe(true)
    })
  })

  describe('version validation', () => {
    const checker = loadCheckerWithConfig({})

    it('returns false for invalid current version', () => {
      expect(checker(makePackage('foo', 'invalid', '1.0.0'))).toBe(false)
    })

    it('returns false for invalid latest version', () => {
      expect(checker(makePackage('foo', '1.0.0', 'invalid'))).toBe(false)
    })

    it('returns false when latest is not greater than current', () => {
      expect(checker(makePackage('foo', '2.0.0', '1.0.0'))).toBe(false)
    })

    it('returns false when versions are equal', () => {
      expect(checker(makePackage('foo', '1.0.0', '1.0.0'))).toBe(false)
    })
  })

  describe('prerelease and pre-version updates', () => {
    it('blocks preminor updates by default', () => {
      const checker = loadCheckerWithConfig({})
      expect(checker(makePackage('foo', '1.0.0', '1.1.0-rc.1'))).toBe(false)
    })

    it('allows preminor updates when minor allowed', () => {
      const checker = loadCheckerWithConfig({ allowMinorUpdates: true })
      expect(checker(makePackage('foo', '1.0.0', '1.1.0-rc.1'))).toBe(true)
    })

    it('blocks premajor updates by default', () => {
      const checker = loadCheckerWithConfig({})
      expect(checker(makePackage('foo', '1.0.0', '2.0.0-alpha.1'))).toBe(false)
    })

    it('allows premajor updates when major allowed', () => {
      const checker = loadCheckerWithConfig({ allowMajorUpdates: true })
      expect(checker(makePackage('foo', '1.0.0', '2.0.0-alpha.1'))).toBe(true)
    })

    // Note: semver.clean() does not strip prerelease tags, so the
    // prerelease case in updateChecker (lines 47-57) cannot resolve
    // baseUpdateType to patch/minor/major — it stays 'prerelease'.
    // This means prerelease-to-prerelease updates are always blocked.
    it('blocks prerelease-to-prerelease updates (known limitation)', () => {
      const checker = loadCheckerWithConfig({
        allowMajorUpdates: true,
        allowMinorUpdates: true,
      })
      expect(checker(makePackage('foo', '1.0.1-beta.1', '1.0.1-beta.2'))).toBe(
        false,
      )
    })
  })

  describe('allowlist and denylist', () => {
    it('allows packages on the allowlist regardless of update type', () => {
      const checker = loadCheckerWithConfig({
        updateAllowlist: ['special-pkg'],
      })
      expect(checker(makePackage('special-pkg', '1.0.0', '3.0.0'))).toBe(true)
    })

    it('blocks packages on the denylist regardless of update type', () => {
      const checker = loadCheckerWithConfig({
        allowMajorUpdates: true,
        updateDenylist: ['blocked-pkg'],
      })
      expect(checker(makePackage('blocked-pkg', '1.0.0', '1.0.1'))).toBe(false)
    })
  })
})
