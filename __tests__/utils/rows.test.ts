import { toOutdatedRow, toOutdatedRows } from '@/utils/rows'

describe('the in-range note', () => {
  it('is shown when wanted is ahead of current and differs from latest', () => {
    expect(
      toOutdatedRow('ms', {
        name: 'ms',
        current: '2.1.1',
        wanted: '2.1.2',
        latest: '2.1.3',
      }).note,
    ).toBe('in range: 2.1.2')
  })

  it('is not shown for a row whose wanted fell back to missing', () => {
    // Nothing satisfies the range and nothing is installed: wanted is `missing`.
    const info = {
      name: 'ms',
      current: 'missing',
      wanted: 'missing',
      latest: '2.1.3',
    }
    expect(toOutdatedRow('ms', info).note).toBeUndefined()
    expect(
      toOutdatedRows('ms', {
        ...info,
        workspaces: [{ path: '.', current: 'missing', wanted: 'missing' }],
      })[0].note,
    ).toBeUndefined()
  })

  it('is shown for a missing package whose range allows a version', () => {
    expect(
      toOutdatedRow('ms', {
        name: 'ms',
        current: 'missing',
        wanted: '2.1.2',
        latest: '2.1.3',
      }).note,
    ).toBe('in range: 2.1.2')
  })

  it('is not shown when wanted is at or below current', () => {
    expect(
      toOutdatedRow('ms', {
        name: 'ms',
        current: '2.1.2',
        wanted: '2.1.2',
        latest: '2.1.3',
      }).note,
    ).toBeUndefined()
  })
})
