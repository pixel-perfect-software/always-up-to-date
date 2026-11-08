import type { RegistryPackage, UpdateResult, VersionManifest } from '@/types'
import { ENGINES_WALK_LIMIT, fitRunningNode } from '@/utils/nodeFit'
import {
  parseDepsDevPackage,
  parseVersionManifest,
} from '@/utils/registryDocuments'
import type { TargetManifests } from '@/utils/targetManifests'
import {
  capturedManifest,
  capturedPackage,
  capturedRegistry,
} from '../fixtures'
import { derive } from '../fixtures/registry'

const mockDebug = jest.fn()
jest.mock('@/utils/logger', () => ({
  __esModule: true,
  default: { debug: (...args: unknown[]) => mockDebug(...args) },
}))

const AS_OF = '2023-07-01T00:00:00Z'
const RANGE = '>=5.0.0 <5.2.0'
const NODE = '12.22.12'

const CAPTURES: Record<string, string> = {
  '5.1.6': 'typescript.5.1.6.manifest',
  '5.1.5': 'typescript.5.1.5.manifest',
  '5.1.3': 'typescript.5.1.3.manifest',
  '5.0.4': 'typescript.5.0.4.manifest',
}
const manifestOf = (version: string): VersionManifest =>
  capturedManifest('typescript', version, CAPTURES[version])

const row = (overrides: Partial<UpdateResult> = {}): UpdateResult => ({
  name: 'typescript',
  current: '5.0.2',
  wanted: '5.1.6',
  latest: '5.1.6',
  target: '5.1.6',
  updateType: 'minor',
  updated: true,
  ...overrides,
})

const byName = (r: UpdateResult) => r.name

interface Setup {
  rows?: UpdateResult[]
  node?: string | null
  limit?: number
  pkg?: RegistryPackage
  served?: (version: string) => VersionManifest | undefined
  cooldownOf?: Parameters<typeof fitRunningNode>[1]['cooldownOf']
  range?: string | null
  targets?: Record<string, VersionManifest | undefined>
}

const walk = async ({
  rows = [row()],
  node = NODE,
  limit,
  pkg,
  served = (version) => (CAPTURES[version] ? manifestOf(version) : undefined),
  cooldownOf,
  range = RANGE,
  targets = { 'typescript@5.1.6': manifestOf('5.1.6') },
}: Setup = {}) => {
  const reads: string[] = []
  const registry = capturedRegistry(
    ['typescript'],
    { asOf: AS_OF },
    {
      ...(pkg
        ? { lookup: async () => ({ ok: true as const, package: pkg }) }
        : {}),
      versionManifest: async (_name, version) => {
        reads.push(version)
        return served(version)
      },
    },
  )
  await registry.lookup('typescript')
  const result = await fitRunningNode(rows, {
    node,
    manifests: new Map(Object.entries(targets)) as TargetManifests,
    registry,
    lookupName: byName,
    rangeOf: () => range ?? undefined,
    cooldownOf,
    limit,
  })
  return { ...result, reads }
}

describe('fitRunningNode (#200)', () => {
  beforeEach(() => mockDebug.mockClear())

  it('walks 5.1.6 down to 5.0.4 with three reads in descending order', async () => {
    const { rows, manifests, reads } = await walk()

    expect(reads).toEqual(['5.1.5', '5.1.3', '5.0.4'])
    expect(rows[0]).toMatchObject({
      target: '5.0.4',
      updateType: 'patch',
      updated: true,
      wanted: '5.1.6',
      reason: 'engines: 5.1.6 needs node >=14.17 (running node 12.22.12)',
    })
    expect(manifests.get('typescript@5.0.4')).toEqual(manifestOf('5.0.4'))
    expect(mockDebug).toHaveBeenCalledWith(
      'engines: npm skips typescript@5.1.6 (needs node >=14.17, running node 12.22.12); moving to 5.0.4',
    )
  })

  it('keeps the target when the cap is reached', async () => {
    const { rows, reads } = await walk({ limit: 2 })

    expect(reads).toEqual(['5.1.5', '5.1.3'])
    expect(rows[0].target).toBe('5.1.6')
    expect(mockDebug).toHaveBeenCalledWith(
      'engines: none of the 2 newest versions of typescript below 5.1.6 fits node 12.22.12; keeping 5.1.6',
    )
  })

  it('caps at five candidates by default', () => {
    expect(ENGINES_WALK_LIMIT).toBe(5)
  })

  it('stops at a candidate whose manifest is unknown and keeps the target', async () => {
    const { rows, reads } = await walk({
      served: (version) =>
        version === '5.0.4' || !CAPTURES[version]
          ? undefined
          : manifestOf(version),
    })

    expect(reads).toEqual(['5.1.5', '5.1.3', '5.0.4'])
    expect(rows[0].target).toBe('5.1.6')
    expect(mockDebug).toHaveBeenCalledWith(
      'engines: no manifest for typescript@5.0.4; keeping 5.1.6',
    )
  })

  it('reads nothing when the target fits the Node', async () => {
    const { rows, reads } = await walk({ node: '24.22.1' })

    expect(reads).toEqual([])
    expect(rows[0].target).toBe('5.1.6')
  })

  it('reads nothing when there is no Node, and says so', async () => {
    const { rows, reads } = await walk({ node: null })

    expect(reads).toEqual([])
    expect(rows[0].target).toBe('5.1.6')
    expect(mockDebug).toHaveBeenCalledWith(
      "No Node runs autd: npm's engines preference isn't mirrored",
    )
  })

  it('does not walk a row that is not at wanted', async () => {
    const { rows, reads } = await walk({
      rows: [row({ target: '5.1.5' })],
      targets: { 'typescript@5.1.5': manifestOf('5.1.5') },
    })

    expect(reads).toEqual([])
    expect(rows[0].target).toBe('5.1.5')
  })

  it('does not walk a held row', async () => {
    const held = row({
      updated: false,
      target: undefined,
      reason: 'held by rule',
    })
    const { rows, reads } = await walk({ rows: [held] })

    expect(reads).toEqual([])
    expect(rows[0]).toEqual(held)
  })

  it('does not walk without a known target manifest', async () => {
    const { rows, reads } = await walk({ targets: {} })

    expect(reads).toEqual([])
    expect(rows[0].target).toBe('5.1.6')
  })

  it('skips a deprecated candidate', async () => {
    const derived = parseDepsDevPackage(
      JSON.parse(
        derive<{
          versions: { versionKey: { version: string }; isDeprecated: boolean }[]
        }>('typescript.deps-dev', (body) => {
          const entry = body.versions.find(
            (v) => v.versionKey.version === '5.0.4',
          )
          if (entry) entry.isDeprecated = true
        }),
      ),
    )
    const deprecated = derived?.find((v) => v.version === '5.0.4')
    expect(deprecated?.deprecated).toBe(true)
    const base = capturedPackage('typescript', { asOf: AS_OF })
    const pkg = {
      ...base,
      versions: base.versions.map((v) =>
        v.version === '5.0.4' && deprecated ? deprecated : v,
      ),
    }

    const { rows, reads } = await walk({ pkg })

    // 5.0.4 is passed over; 5.0.3 has no capture, which stops the walk.
    expect(reads).toEqual(['5.1.5', '5.1.3', '5.0.3'])
    expect(rows[0].target).toBe('5.1.6')
  })

  it('skips a candidate the cooldown gates', async () => {
    const cooldownOf = jest.fn(async (_row: UpdateResult, version: string) => ({
      gated: version === '5.0.4',
      ageDays: undefined,
    }))

    const { rows, reads } = await walk({ cooldownOf })

    // 5.0.4 fits but is too fresh; 5.0.3 has no manifest, so the walk stops.
    expect(reads).toEqual(['5.1.5', '5.1.3', '5.0.4', '5.0.3'])
    expect(rows[0].target).toBe('5.1.6')
    expect(cooldownOf).toHaveBeenCalledTimes(1)
  })

  it('sets releaseAge from the cooldown of the version it moves to', async () => {
    const { rows } = await walk({
      cooldownOf: async () => ({ gated: false, ageDays: 400 }),
    })

    expect(rows[0]).toMatchObject({ target: '5.0.4', releaseAge: 400 })
  })

  it('keeps the target when no candidate is above current', async () => {
    const { rows, reads } = await walk({ rows: [row({ current: '5.0.4' })] })

    expect(reads).toEqual(['5.1.5', '5.1.3'])
    expect(rows[0].target).toBe('5.1.6')
  })

  it('does not walk without a declared range', async () => {
    const { rows, reads } = await walk({ range: null })

    expect(reads).toEqual([])
    expect(rows[0].target).toBe('5.1.6')
    expect(mockDebug).toHaveBeenCalledWith(
      'engines: no declared range for typescript; keeping 5.1.6',
    )
  })

  it('walks two workspace rows once', async () => {
    const { rows, reads } = await walk({
      rows: [row({ workspace: '.' }), row({ workspace: 'packages/a' })],
    })

    expect(reads).toEqual(['5.1.5', '5.1.3', '5.0.4'])
    expect(rows.map((r) => r.target)).toEqual(['5.0.4', '5.0.4'])
  })

  it('walks a target whose engines.node is not a range, as npm does', async () => {
    const invalid = parseVersionManifest(
      JSON.parse(
        derive<{ engines: { node: string } }>(
          'typescript.5.1.6.manifest',
          (body) => {
            body.engines.node = 'not a range'
          },
        ),
      ),
      { name: 'typescript', version: '5.1.6' },
    )
    expect(invalid?.enginesNode).toBe('not a range')

    const { rows, reads } = await walk({
      targets: { 'typescript@5.1.6': invalid },
    })

    expect(reads).toEqual(['5.1.5', '5.1.3', '5.0.4'])
    expect(rows[0].target).toBe('5.0.4')
  })
})
