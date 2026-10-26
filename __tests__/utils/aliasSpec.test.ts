import { parseAlias, parseBareAlias } from '@/utils/aliasSpec'
import { isRecord } from '@/utils/isRecord'

describe('parseAlias', () => {
  it.each([
    ['npm:dayjs@1.11.9', { name: 'dayjs', range: '1.11.9' }],
    ['npm:@scope/pkg@^1 || ^2', { name: '@scope/pkg', range: '^1 || ^2' }],
  ])('reads %s', (spec, expected) => {
    expect(parseAlias(spec)).toEqual(expected)
  })

  it.each(['^1.0.0', 'npm:ms', 'github:a/b', 'workspace:*'])(
    'does not read %s',
    (spec) => {
      expect(parseAlias(spec)).toBeUndefined()
    },
  )
})

describe('parseBareAlias', () => {
  it('reads the target of npm:<name>', () => {
    expect(parseBareAlias('npm:ms')).toBe('ms')
    expect(parseBareAlias('npm:@scope/pkg')).toBe('@scope/pkg')
  })

  it('does not read an alias with a range', () => {
    expect(parseBareAlias('npm:ms@1.0.0')).toBeUndefined()
  })
})

describe('isRecord', () => {
  it('accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })
})
