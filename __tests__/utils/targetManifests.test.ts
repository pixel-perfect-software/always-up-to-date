import type { UpdateResult, VersionManifest } from '@/types'
import { readTargetManifests, targetManifestOf } from '@/utils/targetManifests'
import { reasonFor } from '../fixtures/reasons'

const row = (overrides: Partial<UpdateResult>): UpdateResult => ({
  name: 'foo',
  current: '1.0.0',
  wanted: '1.0.1',
  latest: '1.0.1',
  target: '1.0.1',
  updateType: 'patch',
  updated: true,
  reason: reasonFor('within range'),
  ...overrides,
})

const manifestFor = (name: string, version: string): VersionManifest => ({
  name,
  version,
  peerDependencies: {},
  optionalPeers: [],
  dependencies: {},
  optionalDependencies: {},
  deprecated: false,
})

const byName = (r: { name: string }) => r.name

describe('readTargetManifests (#196)', () => {
  it('asks once per looked-up name and target, for moving rows only', async () => {
    const versionManifest = jest.fn(async (name: string, version: string) =>
      manifestFor(name, version),
    )

    const manifests = await readTargetManifests(
      [
        row({ workspace: '.' }),
        row({ workspace: 'packages/a' }),
        row({ name: 'bar', target: '2.0.0' }),
        row({ name: 'held', target: undefined, updated: false }),
        row({ name: 'odd', updated: false }),
      ],
      { registry: { versionManifest }, lookupName: byName },
    )

    expect(versionManifest.mock.calls).toEqual([
      ['foo', '1.0.1'],
      ['bar', '2.0.0'],
    ])
    expect([...manifests.keys()]).toEqual(['foo@1.0.1', 'bar@2.0.0'])
  })

  it('keeps an unknown document as undefined', async () => {
    const manifests = await readTargetManifests([row({})], {
      registry: { versionManifest: async () => undefined },
      lookupName: byName,
    })

    expect(manifests.has('foo@1.0.1')).toBe(true)
    expect(manifests.get('foo@1.0.1')).toBeUndefined()
  })

  it('is empty, asking nothing, for a registry without versionManifest', async () => {
    expect(
      (
        await readTargetManifests([row({})], {
          registry: {},
          lookupName: byName,
        })
      ).size,
    ).toBe(0)
  })
})

describe('targetManifestOf (#196)', () => {
  const manifests = new Map([['ms@2.1.3', manifestFor('ms', '2.1.3')]])
  const aliased = () => 'ms'

  it("finds a row's target by the name it was looked up by", () => {
    expect(
      targetManifestOf(
        manifests,
        row({ name: 'my-ms', target: '2.1.3' }),
        aliased,
      ),
    ).toEqual(manifestFor('ms', '2.1.3'))
  })

  it('is undefined for a held row, or a target nobody read', () => {
    expect(
      targetManifestOf(
        manifests,
        row({ name: 'ms', target: undefined, updated: false }),
        byName,
      ),
    ).toBeUndefined()
    expect(
      targetManifestOf(manifests, row({ name: 'ms', target: '2.1.2' }), byName),
    ).toBeUndefined()
  })
})
