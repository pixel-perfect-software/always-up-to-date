import { pinWorkspaceYaml } from './integration/harness'
import {
  type RangedDependency,
  rewriteBerryLock,
  rewriteBunLock,
  rewriteNpmLock,
  rewritePnpmLock,
  rewriteYarnV1Lock,
} from './integration/lockfiles'

// Pure helpers of the integration harness (the matrix itself never runs in
// `pnpm test`). The lockfile inputs have the shape of the files the managers
// write after installing the minimum of every range (kept copies of the
// matrix's repos), cut down to the entries that matter.

const dep = (
  name: string,
  range: string,
  installed: string,
  origin: { workspace: string } | { catalog: string },
): RangedDependency => ({ name, range, installed, ...origin })

describe('pinWorkspaceYaml', () => {
  const yaml = [
    'packages:',
    '  - packages/*',
    '',
    'catalog:',
    '  chalk: ^4.0.0',
    '',
    'catalogs:',
    '  tools:',
    '    commander: ^11.0.0',
    '',
    'overrides:',
    '  ms: ^2.1.0',
    '',
  ].join('\n')

  it('reports the entries of the default and the named catalogs', () => {
    const seen: string[][] = []
    pinWorkspaceYaml(yaml, (catalog, name, spec) => {
      seen.push([catalog, name, spec])
      return undefined
    })
    expect(seen).toEqual([
      ['default', 'chalk', '^4.0.0'],
      ['tools', 'commander', '^11.0.0'],
    ])
  })

  it('does not read a top-level map after catalogs: as entries of the last catalog', () => {
    const calls: string[] = []
    const out = pinWorkspaceYaml(yaml, (catalog, name) => {
      calls.push(`${catalog}/${name}`)
      return '1.0.0'
    })
    expect(calls).not.toContain('tools/ms')
    expect(out).toContain('  ms: ^2.1.0')
    expect(out).toContain('    commander: 1.0.0')
  })

  it('keeps CRLF line endings', () => {
    const out = pinWorkspaceYaml(yaml.replaceAll('\n', '\r\n'), () => '1.0.0')
    expect(out).toContain('    commander: 1.0.0\r\n')
    expect(out.replaceAll('\r\n', '')).not.toContain('\n')
  })
})

describe('rewriteNpmLock', () => {
  const lock = `${JSON.stringify(
    {
      name: 'autd-npm-workspace',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'autd-npm-workspace',
          version: '1.0.0',
          workspaces: ['packages/*'],
          dependencies: { dayjs: '1.11.9', ms: '2.1.1' },
        },
        'packages/a': {
          name: '@autd/a',
          version: '1.0.0',
          dependencies: { chalk: '4.0.0', ms: '2.1.2' },
        },
        'packages/b': {
          name: '@autd/b',
          version: '1.0.0',
          devDependencies: { kleur: '3.0.0' },
        },
      },
    },
    null,
    2,
  )}\n`
  const ranged = [
    dep('ms', '~2.1.1', '2.1.1', { workspace: '.' }),
    dep('chalk', '^4.0.0', '4.0.0', { workspace: 'packages/a' }),
    dep('kleur', '~3.0.0', '3.0.0', { workspace: 'packages/b' }),
  ]

  it('moves the installed version of each ranged dependency to its range', () => {
    const out = rewriteNpmLock(lock, ranged)
    const packages = JSON.parse(out).packages
    expect(packages[''].dependencies).toEqual({ dayjs: '1.11.9', ms: '~2.1.1' })
    expect(packages['packages/a'].dependencies).toEqual({
      chalk: '^4.0.0',
      ms: '2.1.2',
    })
    expect(packages['packages/b'].devDependencies).toEqual({ kleur: '~3.0.0' })
  })

  it('keeps the two-space indent, the trailing newline and CRLF', () => {
    const out = rewriteNpmLock(lock, ranged)
    expect(out).toMatch(/^\{\n {2}"name"/)
    expect(out.endsWith('}\n')).toBe(true)
    const crlf = rewriteNpmLock(lock.replaceAll('\n', '\r\n'), ranged)
    expect(crlf.endsWith('}\r\n')).toBe(true)
    expect(crlf.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('throws naming the lockfile and the package when nothing matches', () => {
    expect(() =>
      rewriteNpmLock(lock, [
        dep('chalk', '^4.0.0', '4.0.0', { workspace: 'packages/b' }),
      ]),
    ).toThrow(
      /package-lock\.json: no chalk@4\.0\.0 in packages\["packages\/b"\]/,
    )
    expect(() =>
      rewriteNpmLock(lock, [
        dep('chalk', '^4.0.0', '4.0.9', { workspace: 'packages/a' }),
      ]),
    ).toThrow(/package-lock\.json: no chalk@4\.0\.9/)
  })
})

describe('rewritePnpmLock', () => {
  const lock = [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'catalogs:',
    '  default:',
    '    chalk:',
    '      specifier: 4.0.0',
    '      version: 4.0.0',
    '  tools:',
    '    commander:',
    '      specifier: 11.0.0',
    '      version: 11.0.0',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      dayjs:',
    '        specifier: 1.11.9',
    '        version: 1.11.9',
    '      ms:',
    '        specifier: 2.1.1',
    '        version: 2.1.1',
    '',
    '  packages/a:',
    '    dependencies:',
    '      chalk:',
    "        specifier: 'catalog:'",
    '        version: 4.0.0',
    '      ms:',
    '        specifier: 2.1.2',
    '        version: 2.1.2',
    '',
    '  packages/b:',
    '    devDependencies:',
    '      kleur:',
    '        specifier: 3.0.0',
    '        version: 3.0.0',
    '',
    'packages:',
    '',
    '  chalk@4.0.0:',
    '    resolution: {integrity: sha512-x}',
    '',
  ].join('\n')
  const ranged = [
    dep('ms', '~2.1.1', '2.1.1', { workspace: '.' }),
    dep('kleur', '~3.0.0', '3.0.0', { workspace: 'packages/b' }),
    dep('chalk', '^4.0.0', '4.0.0', { catalog: 'default' }),
    dep('commander', '^11.0.0', '11.0.0', { catalog: 'tools' }),
  ]

  it('moves importer and catalog specifiers to the ranges', () => {
    const out = rewritePnpmLock(lock, ranged)
    expect(out).toContain(
      '      ms:\n        specifier: ~2.1.1\n        version: 2.1.1',
    )
    expect(out).toContain('      kleur:\n        specifier: ~3.0.0\n')
    expect(out).toContain('    chalk:\n      specifier: ^4.0.0\n')
    expect(out).toContain('    commander:\n      specifier: ^11.0.0\n')
  })

  it('leaves everything else as it was', () => {
    const out = rewritePnpmLock(lock, ranged)
    expect(out).toContain('        specifier: 1.11.9')
    expect(out).toContain("        specifier: 'catalog:'")
    expect(out).toContain('        specifier: 2.1.2')
    expect(out).toContain('  chalk@4.0.0:')
    expect(out.split('\n')).toHaveLength(lock.split('\n').length)
  })

  it('keeps CRLF line endings', () => {
    const out = rewritePnpmLock(lock.replaceAll('\n', '\r\n'), ranged)
    expect(out).toContain('        specifier: ~2.1.1\r\n')
    expect(out.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('throws naming the lockfile and the package when an importer has no match', () => {
    expect(() =>
      rewritePnpmLock(lock, [
        dep('ms', '~2.1.1', '2.1.1', { workspace: 'packages/b' }),
      ]),
    ).toThrow(
      /pnpm-lock\.yaml: no ms specifier 2\.1\.1 in importer packages\/b/,
    )
  })

  it('throws naming the lockfile and the package when a catalog has no match', () => {
    expect(() =>
      rewritePnpmLock(lock, [
        dep('commander', '^11.0.0', '11.0.0', { catalog: 'default' }),
      ]),
    ).toThrow(
      /pnpm-lock\.yaml: no commander specifier 11\.0\.0 in catalog default/,
    )
  })
})

describe('rewriteYarnV1Lock', () => {
  const lock = [
    '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
    '# yarn lockfile v1',
    '',
    '',
    'chalk@4.0.0:',
    '  version "4.0.0"',
    '  resolved "https://registry.yarnpkg.com/chalk/-/chalk-4.0.0.tgz#abc"',
    '',
    '"@scope/pkg@1.0.0":',
    '  version "1.0.0"',
    '',
  ].join('\n')

  it('adds the range to the key that lists the installed version', () => {
    const out = rewriteYarnV1Lock(lock, [
      dep('chalk', '^4.0.0', '4.0.0', { workspace: '.' }),
      dep('@scope/pkg', '^1.0.0', '1.0.0', { workspace: '.' }),
    ])
    expect(out).toContain('chalk@4.0.0, chalk@^4.0.0:\n')
    expect(out).toContain('"@scope/pkg@1.0.0", "@scope/pkg@^1.0.0":\n')
  })

  it('quotes a key the way yarn 1.22.22 does: a range with spaces (#151)', () => {
    // yarn reads a bare `ms@^0.7.1 || ^2.1.3` key back as another pattern,
    // resolves the range again and installs its newest version.
    const out = rewriteYarnV1Lock(lock, [
      dep('chalk', '^4.0.0 || ^6.0.0', '4.0.0', { workspace: '.' }),
      dep('@scope/pkg', '>=1.0.0 <2', '1.0.0', { workspace: '.' }),
    ])
    expect(out).toContain('chalk@4.0.0, "chalk@^4.0.0 || ^6.0.0":\n')
    expect(out).toContain('"@scope/pkg@1.0.0", "@scope/pkg@>=1.0.0 <2":\n')
  })

  it('adds the range to an npm: alias locked under its target (#152)', () => {
    // yarn 1.22.22 locks `"m": "npm:ms@2.1.2"` as `"m@npm:ms@2.1.2":`.
    const aliasLock = [
      '# yarn lockfile v1',
      '',
      '',
      '"m@npm:ms@2.1.2":',
      '  version "2.1.2"',
      '',
    ].join('\n')
    const out = rewriteYarnV1Lock(aliasLock, [
      dep('m', 'npm:ms@^2.0.0', '2.1.2', { workspace: '.' }),
    ])
    expect(out).toContain('"m@npm:ms@2.1.2", "m@npm:ms@^2.0.0":\n')
  })

  it('throws naming the lockfile and the key when none lists the version', () => {
    expect(() =>
      rewriteYarnV1Lock(lock, [
        dep('chalk', '^4.0.0', '4.0.1', { workspace: '.' }),
      ]),
    ).toThrow(/yarn\.lock: no key for chalk@4\.0\.1/)
  })
})

describe('rewriteBerryLock', () => {
  const lock = [
    '# This file is generated by running "yarn install" inside your project.',
    '',
    '__metadata:',
    '  version: 8',
    '',
    '"@autd/a@workspace:packages/a":',
    '  version: 0.0.0-use.local',
    '  resolution: "@autd/a@workspace:packages/a"',
    '  dependencies:',
    '    chalk: "npm:4.0.0"',
    '    ms: "npm:2.1.2"',
    '  languageName: unknown',
    '  linkType: soft',
    '',
    '"chalk@npm:4.0.0":',
    '  version: 4.0.0',
    '  resolution: "chalk@npm:4.0.0"',
    '  languageName: node',
    '  linkType: hard',
    '',
  ].join('\n')
  const ranged = [dep('chalk', '^4.0.0', '4.0.0', { workspace: 'packages/a' })]

  it('adds the range to the descriptor key and moves the workspace entry to it', () => {
    const out = rewriteBerryLock(lock, ranged)
    expect(out).toContain('"chalk@npm:4.0.0, chalk@npm:^4.0.0":\n')
    expect(out).toContain('    chalk: "npm:^4.0.0"\n')
    expect(out).toContain('    ms: "npm:2.1.2"\n')
  })

  it('adds the range to an npm: alias locked under its target, and moves its workspace entry (#152)', () => {
    // yarn 4.12.0 locks `"m": "npm:ms@2.1.2"` as `"m@npm:ms@2.1.2":`, and
    // the workspace entry lists `m: "npm:ms@2.1.2"`.
    const aliasLock = [
      '__metadata:',
      '  version: 8',
      '  cacheKey: 10c0',
      '',
      '"alias@workspace:.":',
      '  version: 0.0.0-use.local',
      '  resolution: "alias@workspace:."',
      '  dependencies:',
      '    m: "npm:ms@2.1.2"',
      '  languageName: unknown',
      '  linkType: soft',
      '',
      '"m@npm:ms@2.1.2":',
      '  version: 2.1.2',
      '  resolution: "ms@npm:2.1.2"',
      '  languageName: node',
      '  linkType: hard',
      '',
    ].join('\n')
    const out = rewriteBerryLock(aliasLock, [
      dep('m', 'npm:ms@^2.0.0', '2.1.2', { workspace: '.' }),
    ])
    expect(out).toContain('"m@npm:ms@2.1.2, m@npm:ms@^2.0.0":\n')
    expect(out).toContain('    m: "npm:ms@^2.0.0"\n')
  })

  it('throws naming the lockfile and the key when no key lists the version', () => {
    expect(() =>
      rewriteBerryLock(lock, [
        dep('chalk', '^4.0.0', '4.0.1', { workspace: 'packages/a' }),
      ]),
    ).toThrow(/yarn\.lock: no key for chalk@npm:4\.0\.1/)
  })

  it('throws naming the lockfile and the workspace when its entry has no dependency', () => {
    expect(() =>
      rewriteBerryLock(lock, [
        dep('chalk', '^4.0.0', '4.0.0', { workspace: 'packages/b' }),
      ]),
    ).toThrow(
      /yarn\.lock: no chalk dependency in the workspace entry for packages\/b/,
    )
  })
})

describe('rewriteBunLock', () => {
  const lock = [
    '{',
    '  "lockfileVersion": 2,',
    '  "workspaces": {',
    '    "": {',
    '      "name": "autd-bun-catalogs",',
    '      "dependencies": {',
    '        "dayjs": "1.11.9",',
    '        "ms": "catalog:",',
    '      },',
    '    },',
    '    "packages/b": {',
    '      "name": "@autd/b",',
    '      "devDependencies": {',
    '        "kleur": "3.0.0",',
    '      },',
    '    },',
    '  },',
    '  "catalog": {',
    '    "chalk": "4.0.0",',
    '  },',
    '  "catalogs": {',
    '    "tools": {',
    '      "commander": "11.0.0",',
    '    },',
    '  },',
    '}',
    '',
  ].join('\n')
  const ranged = [
    dep('kleur', '~3.0.0', '3.0.0', { workspace: 'packages/b' }),
    dep('chalk', '^4.0.0', '4.0.0', { catalog: 'default' }),
    dep('commander', '^11.0.0', '11.0.0', { catalog: 'tools' }),
  ]

  it('moves workspace and catalog specifiers to the ranges', () => {
    const out = rewriteBunLock(lock, ranged)
    expect(out).toContain('        "kleur": "~3.0.0",')
    expect(out).toContain('    "chalk": "^4.0.0",')
    expect(out).toContain('      "commander": "^11.0.0",')
    expect(out).toContain('        "dayjs": "1.11.9",')
  })

  it('throws naming the lockfile and the package when a workspace has no match', () => {
    expect(() =>
      rewriteBunLock(lock, [
        dep('kleur', '~3.0.0', '3.0.0', { workspace: '.' }),
      ]),
    ).toThrow(/bun\.lock: no kleur@3\.0\.0 specifier in workspace \./)
  })

  it('throws naming the lockfile and the package when a catalog has no match', () => {
    expect(() =>
      rewriteBunLock(lock, [
        dep('commander', '^11.0.0', '11.0.0', { catalog: 'default' }),
      ]),
    ).toThrow(/bun\.lock: no commander@11\.0\.0 specifier in catalog default/)
  })
})
