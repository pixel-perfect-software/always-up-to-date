import type { AlwaysUpToDateConfig, BeyondRange, PackageRule } from '@/types'
import updateChecker, {
  policyFromConfig,
  stepLevel,
  type UpdatePolicy,
} from '@/utils/updateChecker'

const policy = (
  beyondRange: BeyondRange = 'none',
  rules: Record<string, PackageRule> = {},
): UpdatePolicy => ({ beyondRange, ruleFor: (name) => rules[name] })

const pkg = (current: string, wanted: string, latest: string) => ({
  name: 'pkg',
  current,
  wanted,
  latest,
})

describe('updateChecker', () => {
  describe('default policy: stay within the manifest range', () => {
    it('moves a ranged package to the highest version its range allows', () => {
      // react ^18.2.0: installed 18.2.0, range allows 18.3.1, latest 19.3.1
      expect(
        updateChecker(pkg('18.2.0', '18.3.1', '19.3.1'), policy()),
      ).toEqual({ target: '18.3.1' })
    })

    it('moves to latest when the range already covers it', () => {
      expect(
        updateChecker(pkg('1.11.9', '1.11.23', '1.11.23'), policy()),
      ).toEqual({ target: '1.11.23' })
    })

    it('holds an exact pin, even for a patch', () => {
      // dayjs "1.11.9": the range is the pin, so wanted == current
      expect(
        updateChecker(pkg('1.11.9', '1.11.9', '1.11.23'), policy()),
      ).toEqual({ reason: 'patch beyond the range' })
    })

    it('holds a range that is already at its highest version', () => {
      expect(updateChecker(pkg('4.22.3', '4.22.3', '5.3.0'), policy())).toEqual(
        {
          reason: 'major beyond the range',
        },
      )
    })
  })

  describe('beyondRange', () => {
    it.each([
      ['patch', '1.11.9', '1.11.23', '1.11.23'],
      ['minor', '1.2.7', '1.3.0', '1.3.0'],
      ['major', '18.2.0', '19.3.1', '19.3.1'],
    ] as const)(
      '"%s" lets an exact pin move by that step',
      (level, current, latest, target) => {
        expect(
          updateChecker(pkg(current, current, latest), policy(level)),
        ).toEqual({ target })
      },
    )

    it('does not move past the range by a bigger step than allowed', () => {
      // ^18.2.0 with latest 19: "minor" allows only the in-range 18.3.1
      expect(
        updateChecker(pkg('18.2.0', '18.3.1', '19.3.1'), policy('minor')),
      ).toEqual({ target: '18.3.1' })
    })

    it('a larger level includes the smaller ones', () => {
      expect(
        updateChecker(pkg('1.11.9', '1.11.9', '1.11.23'), policy('major')),
      ).toEqual({ target: '1.11.23' })
    })
  })

  describe('rules', () => {
    it('"hold" wins over the range and the level', () => {
      expect(
        updateChecker(
          pkg('18.2.0', '18.3.1', '19.3.1'),
          policy('major', { pkg: 'hold' }),
        ),
      ).toEqual({ reason: 'held by rule' })
    })

    it('"latest" moves past the range at any step', () => {
      expect(
        updateChecker(
          pkg('18.2.0', '18.2.0', '19.3.1'),
          policy('none', { pkg: 'latest' }),
        ),
      ).toEqual({ target: '19.3.1' })
    })

    it('"followRange" stays within the range even when the level allows more', () => {
      expect(
        updateChecker(
          pkg('18.2.0', '18.3.1', '19.3.1'),
          policy('major', { pkg: 'followRange' }),
        ),
      ).toEqual({ target: '18.3.1' })
      expect(
        updateChecker(
          pkg('1.11.9', '1.11.9', '1.11.23'),
          policy('major', { pkg: 'followRange' }),
        ),
      ).toEqual({ reason: 'outside the range (rule followRange)' })
    })
  })

  describe('versions', () => {
    it('rejects an invalid version', () => {
      expect(
        updateChecker(pkg('not-a-version', '1.0.0', '1.0.1'), policy()),
      ).toEqual({
        reason: 'invalid version (current not-a-version, latest 1.0.1)',
      })
    })

    it('holds when latest is not newer than installed', () => {
      expect(
        updateChecker(pkg('2.0.0', '2.0.0', '1.9.0'), policy('major')),
      ).toEqual({ reason: 'not newer than installed' })
    })

    it('treats an unusable wanted as "nothing in range"', () => {
      expect(updateChecker(pkg('1.0.0', 'linked', '1.0.1'), policy())).toEqual({
        reason: 'patch beyond the range',
      })
    })
  })
})

describe('stepLevel', () => {
  it.each([
    ['1.0.0', '1.0.1', 'patch'],
    ['1.0.0', '1.1.0', 'minor'],
    ['1.0.0', '2.0.0', 'major'],
    ['1.0.0', '1.1.0-beta.1', 'minor'],
    ['1.0.0', '2.0.0-rc.1', 'major'],
    ['1.0.0-beta.1', '1.0.0-beta.2', 'patch'],
  ])('%s → %s is a %s step', (from, to, level) => {
    expect(stepLevel(from, to)).toBe(level)
  })
})

describe('policyFromConfig (legacy fields as the override layer)', () => {
  const config = (
    overrides: Partial<AlwaysUpToDateConfig> = {},
  ): AlwaysUpToDateConfig => ({
    allowMinorUpdates: false,
    allowMajorUpdates: false,
    debug: false,
    silent: false,
    updateAllowlist: [],
    updateDenylist: [],
    cooldown: 0,
    depsDev: true,
    rules: {},
    ...overrides,
  })

  it('uses beyondRange when it is set, over the legacy fields', () => {
    expect(
      policyFromConfig(
        config({ beyondRange: 'patch', allowMajorUpdates: true }),
      ).beyondRange,
    ).toBe('patch')
    expect(policyFromConfig(config({ beyondRange: 'none' })).beyondRange).toBe(
      'none',
    )
  })

  it('matches rules by exact name first, then the longest matching glob', () => {
    const { ruleFor } = policyFromConfig(
      config({
        rules: {
          '*': 'followRange',
          '@types/*': 'latest',
          '@types/react': 'hold',
          'eslint-*': 'hold',
        },
      }),
    )

    expect(ruleFor('@types/react')).toBe('hold')
    expect(ruleFor('@types/node')).toBe('latest')
    expect(ruleFor('eslint-plugin-react')).toBe('hold')
    expect(ruleFor('eslint')).toBe('followRange')
    expect(ruleFor('dayjs')).toBe('followRange')
  })

  it('treats glob characters other than * literally', () => {
    const { ruleFor } = policyFromConfig(
      config({ rules: { 'lodash.merge': 'hold' } }),
    )

    expect(ruleFor('lodash.merge')).toBe('hold')
    expect(ruleFor('lodashxmerge')).toBeUndefined()
  })

  it('lets rules win over the legacy allow and deny lists', () => {
    const { ruleFor } = policyFromConfig(
      config({
        rules: { react: 'hold', 'vue*': 'latest' },
        updateAllowlist: ['react'],
        updateDenylist: ['vue', 'lodash'],
      }),
    )

    expect(ruleFor('react')).toBe('hold')
    expect(ruleFor('vue')).toBe('latest')
    expect(ruleFor('lodash')).toBe('hold')
  })

  it('maps allowMinorUpdates and allowMajorUpdates to a beyond-range level', () => {
    expect(policyFromConfig(config()).beyondRange).toBe('none')
    expect(
      policyFromConfig(config({ allowMinorUpdates: true })).beyondRange,
    ).toBe('minor')
    expect(
      policyFromConfig(config({ allowMajorUpdates: true })).beyondRange,
    ).toBe('major')
  })

  it('maps the allowlist to "latest" and the denylist to "hold"', () => {
    const { ruleFor } = policyFromConfig(
      config({
        updateAllowlist: ['react'],
        updateDenylist: ['lodash', 'react'],
      }),
    )
    expect(ruleFor('react')).toBe('latest')
    expect(ruleFor('lodash')).toBe('hold')
    expect(ruleFor('dayjs')).toBeUndefined()
  })
})
