import {
  declaredNodeRange,
  enginesHold,
  npmAcceptsNode,
  runningNode,
} from '@/utils/engines'

const mockDebug = jest.fn()
jest.mock('@/utils/logger', () => ({
  __esModule: true,
  default: { debug: (...args: unknown[]) => mockDebug(...args) },
}))

const PROJECT = '^22.23.0 || >=24.17.0'

describe('runningNode', () => {
  it('is the Node version', () => {
    expect(runningNode({ node: '24.22.1' })).toBe('24.22.1')
  })

  it('is null under Bun, which reports the Node version it emulates', () => {
    expect(runningNode({ node: '24.3.0', bun: '1.4.4' })).toBeNull()
  })

  it('defaults to the process', () => {
    expect(runningNode()).toBe(process.versions.node)
  })
})

describe('declaredNodeRange', () => {
  beforeEach(() => mockDebug.mockClear())

  it('keeps a valid range as written', () => {
    expect(declaredNodeRange('>=18', 'package.json')).toBe('>=18')
    expect(mockDebug).not.toHaveBeenCalled()
  })

  it.each(['*', '>=0', 'x', '', '  '])(
    'ignores the universal range %j',
    (r) => {
      expect(declaredNodeRange(r, 'package.json')).toBeUndefined()
      expect(mockDebug).not.toHaveBeenCalled()
    },
  )

  it('ignores a missing value silently', () => {
    expect(declaredNodeRange(undefined, 'package.json')).toBeUndefined()
    expect(mockDebug).not.toHaveBeenCalled()
  })

  it.each([
    ['an invalid range', 'not a range'],
    ['an array', ['>=18']],
    ['a number', 18],
  ])('ignores %s with one debug line', (_label, value) => {
    expect(declaredNodeRange(value, 'a/package.json')).toBeUndefined()
    expect(mockDebug).toHaveBeenCalledTimes(1)
    expect(mockDebug).toHaveBeenCalledWith(
      "engines.node in a/package.json isn't a semver range; it declares nothing",
    )
  })
})

describe('enginesHold', () => {
  it.each([
    [PROJECT, '>=20', false],
    [PROJECT, '>=24', true],
    // The plan expected a pass; `>=24.17.0` is open-ended, so Node 26 is outside `^24`.
    [PROJECT, '^22 || ^24', true],
    [PROJECT, '^22 || >=24', false],
    ['>=22', '^22 || ^24', true],
    // Known limitation: touching pieces are not merged, so this is held.
    ['>=22.12.0', '^22.12.0 || >=23', true],
  ])(
    'declared %s against a target needing %s: held %s',
    (declared, target, held) => {
      const reason = enginesHold(target, { declared, running: '24.22.1' })
      expect(reason !== undefined).toBe(held)
      if (held) {
        expect(reason).toBe(
          `engines: needs node ${target} (the project declares ${declared})`,
        )
      }
    },
  )

  it('judges the running Node when nothing is declared', () => {
    expect(enginesHold('>=10', { running: '8.17.0' })).toBe(
      'engines: needs node >=10 (running node 8.17.0)',
    )
    expect(enginesHold('>=10', { running: '24.22.1' })).toBeUndefined()
  })

  it('names the source of the running Node when given', () => {
    expect(
      enginesHold('>=22', {
        running: '20.0.0',
        runningLabel: 'pnpm nodeVersion',
      }),
    ).toBe('engines: needs node >=22 (pnpm nodeVersion 20.0.0)')
  })

  it('does not hold a prerelease Node', () => {
    expect(enginesHold('>=24', { running: '25.0.0-rc.1' })).toBeUndefined()
  })

  it('does not hold an invalid or universal target', () => {
    expect(enginesHold('nonsense', { running: '8.0.0' })).toBeUndefined()
    expect(
      enginesHold('*', { declared: '>=18', running: '8.0.0' }),
    ).toBeUndefined()
    expect(enginesHold('>=0', { running: '8.0.0' })).toBeUndefined()
  })

  it('holds nothing with neither a declared range nor a running Node', () => {
    expect(enginesHold('>=99', { running: null })).toBeUndefined()
  })
})

describe('npmAcceptsNode (#200)', () => {
  it('accepts a target with no engines.node', () => {
    expect(npmAcceptsNode(undefined, '12.22.12')).toBe(true)
  })

  it('accepts a range the Node satisfies and refuses one it does not', () => {
    expect(npmAcceptsNode('>=12.20', '12.22.12')).toBe(true)
    expect(npmAcceptsNode('>=14.17', '12.22.12')).toBe(false)
  })

  it('accepts a universal range', () => {
    expect(npmAcceptsNode('*', '12.22.12')).toBe(true)
  })

  it('judges a prerelease Node with includePrerelease, as npm does', () => {
    expect(npmAcceptsNode('>=22.0.0 <23', '22.1.0-rc.1')).toBe(true)
  })

  it('refuses an invalid range, where enginesHold lets it through', () => {
    expect(npmAcceptsNode('not a range', '12.22.12')).toBe(false)
    expect(enginesHold('not a range', { running: '12.22.12' })).toBeUndefined()
  })
})
