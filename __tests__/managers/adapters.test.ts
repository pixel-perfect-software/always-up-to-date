import { adapterFor, adapters } from '@/managers'

describe('adapter registry', () => {
  it.each(['npm', 'yarn', 'pnpm', 'bun'] as const)(
    'returns the %s adapter by name',
    (name) => {
      expect(adapterFor(name).name).toBe(name)
    },
  )

  it('gives each manager its own lockfile', () => {
    const lockfiles = Object.values(adapters).map((adapter) => adapter.lockfile)
    expect(new Set(lockfiles).size).toBe(lockfiles.length)
  })
})
