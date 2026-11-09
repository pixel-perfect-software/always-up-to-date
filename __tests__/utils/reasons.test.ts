import { OUTCOMES, REASON_CODES } from '@/utils/reasons'
import { outcomeOf, SECTION_OF } from '@/utils/report'
import { reasonFor } from '../fixtures/reasons'

const MOVING = [
  'within-range',
  'past-range',
  'rule-latest',
  'cooldown-fallback',
  'engines-fallback',
] as const

describe('reason codes', () => {
  it('lists each code once', () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length)
    expect(new Set(OUTCOMES).size).toBe(OUTCOMES.length)
  })

  it('gives every code a report section, and only the codes', () => {
    expect(Object.keys(SECTION_OF).sort()).toEqual([...REASON_CODES].sort())
  })

  it.each(MOVING)('files the moving code %s under update', (code) => {
    expect(SECTION_OF[code]).toBe('update')
  })

  it('files a row by its code, not by its text', () => {
    const row = {
      name: 'p',
      current: '1.0.0',
      wanted: '1.0.0',
      latest: '2.0.0',
      updateType: 'major' as const,
      updated: false,
    }
    // Text that looks like a cooldown hold, under another code.
    expect(
      outcomeOf({ ...row, reason: reasonFor('cooldown: x', 'override') }),
    ).toBe('override')
    expect(outcomeOf({ ...row, reason: reasonFor('not targeted') })).toBe(
      undefined,
    )
  })

  it('keeps the two peer codes in the one peer section', () => {
    expect(SECTION_OF['peer-conflict']).toBe('peer')
    expect(SECTION_OF['target-peers']).toBe('peer')
  })
})
