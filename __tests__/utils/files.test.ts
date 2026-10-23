import fs from 'fs'
import type { PackageInfo } from '@/types'
import {
  checkIfFileExists,
  identifyCatalogPackages,
  updateBunCatalogs,
  updatePackageJson,
  updatePNPMWorkspaceYAML,
} from '@/utils/files'

jest.mock('fs')

// The writers take name -> new version; these tests move each package to latest.
const versionsOf = (
  names: string[],
  outdated: Record<string, PackageInfo>,
): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, outdated[name].latest]))

const mockedFs = jest.mocked(fs)

describe('checkIfFileExists', () => {
  it('returns true for an existing file', () => {
    mockedFs.statSync.mockReturnValue({ isFile: () => true } as fs.Stats)
    expect(checkIfFileExists('/test/file.json')).toBe(true)
  })

  it('returns false for a directory', () => {
    mockedFs.statSync.mockReturnValue({ isFile: () => false } as fs.Stats)
    expect(checkIfFileExists('/test/dir')).toBe(false)
  })

  it('returns false when file does not exist', () => {
    mockedFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(checkIfFileExists('/test/missing.json')).toBe(false)
  })
})

describe('updatePackageJson', () => {
  const outdatedPackages: Record<string, PackageInfo> = {
    react: {
      name: 'react',
      current: '18.0.0',
      wanted: '18.0.0',
      latest: '19.0.0',
    },
    typescript: {
      name: 'typescript',
      current: '5.0.0',
      wanted: '5.0.0',
      latest: '5.5.0',
    },
  }

  it('updates dependencies preserving version decorators', async () => {
    const packageJson = {
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '~5.0.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePackageJson(
      '/test',
      versionsOf(['react', 'typescript'], outdatedPackages),
    )

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('^19.0.0')
    expect(written.devDependencies.typescript).toBe('~5.5.0')
  })

  it('keeps an exact pin exact in every dependency field', async () => {
    const packageJson = {
      dependencies: { react: '18.0.0' },
      devDependencies: { react: '18.0.0' },
      optionalDependencies: { react: '18.0.0' },
      peerDependencies: { react: '18.0.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePackageJson('/test', versionsOf(['react'], outdatedPackages))

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('19.0.0')
    expect(written.devDependencies.react).toBe('19.0.0')
    expect(written.optionalDependencies.react).toBe('19.0.0')
    expect(written.peerDependencies.react).toBe('19.0.0')
  })

  it('skips workspace references', async () => {
    const packageJson = {
      dependencies: { react: 'workspace:*' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePackageJson('/test', versionsOf(['react'], outdatedPackages))

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('workspace:*')
  })

  it('skips catalog references', async () => {
    const packageJson = {
      dependencies: { react: 'catalog:default' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePackageJson('/test', versionsOf(['react'], outdatedPackages))

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('catalog:default')
  })

  it('updates across all dependency types', async () => {
    const packageJson = {
      dependencies: { react: '^18.0.0' },
      devDependencies: { react: '^18.0.0' },
      optionalDependencies: { react: '^18.0.0' },
      peerDependencies: { react: '^18.0.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePackageJson('/test', versionsOf(['react'], outdatedPackages))

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('^19.0.0')
    expect(written.devDependencies.react).toBe('^19.0.0')
    expect(written.optionalDependencies.react).toBe('^19.0.0')
    expect(written.peerDependencies.react).toBe('^19.0.0')
  })

  describe('specs that cannot keep their shape', () => {
    const write = (spec: string) => {
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ dependencies: { react: spec } }),
      )
      mockedFs.writeFileSync.mockImplementation(() => undefined)
    }
    const written = () =>
      JSON.parse((mockedFs.writeFileSync as jest.Mock).mock.calls[0][1])
        .dependencies.react

    it.each([
      ['1.x', '^19.0.0'],
      ['*', '^19.0.0'],
      ['>=18.0.0 <19.0.0', '^19.0.0'],
      ['^17.0.0 || ^18.0.0', '^19.0.0'],
    ])('writes %s with the save prefix', async (spec, expected) => {
      write(spec)

      await updatePackageJson('/test', { react: '19.0.0' })

      expect(written()).toBe(expected)
    })

    it('writes an exact version when the project saves exact', async () => {
      write('1.x')

      await updatePackageJson(
        '/test',
        { react: '19.0.0' },
        { exact: true, prefix: '^' },
      )

      expect(written()).toBe('19.0.0')
    })

    it('uses the configured prefix', async () => {
      write('>=18.0.0 <19.0.0')

      await updatePackageJson(
        '/test',
        { react: '19.0.0' },
        { exact: false, prefix: '~' },
      )

      expect(written()).toBe('~19.0.0')
    })

    it('keeps the decorator of a single comparator, ignoring the save style', async () => {
      write('~18.0.0')

      await updatePackageJson(
        '/test',
        { react: '19.0.0' },
        { exact: true, prefix: '^' },
      )

      expect(written()).toBe('~19.0.0')
    })

    it('rewrites the version inside an npm: alias, keeping the alias', async () => {
      write('npm:preact@^10.0.0')

      await updatePackageJson('/test', { react: '10.5.0' })

      expect(written()).toBe('npm:preact@^10.5.0')
    })

    it('leaves a git or file spec alone', async () => {
      write('github:facebook/react#v18.2.0')

      await updatePackageJson('/test', { react: '19.0.0' })

      expect(written()).toBe('github:facebook/react#v18.2.0')
    })
  })

  it('handles >= version decorator', async () => {
    const packageJson = {
      dependencies: { react: '>=18.0.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePackageJson('/test', versionsOf(['react'], outdatedPackages))

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('>=19.0.0')
  })
})

describe('manifest formatting', () => {
  const rewrite = async (original: string) => {
    mockedFs.readFileSync.mockReturnValue(original)
    mockedFs.writeFileSync.mockImplementation(() => undefined)
    await updatePackageJson('/test', { react: '19.0.0' })
    return (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1] as string
  }

  it('keeps the trailing newline', async () => {
    expect(
      await rewrite('{\n  "dependencies": {\n    "react": "18.0.0"\n  }\n}\n'),
    ).toBe('{\n  "dependencies": {\n    "react": "19.0.0"\n  }\n}\n')
  })

  it('does not add a trailing newline the file did not have', async () => {
    expect(
      await rewrite('{\n  "dependencies": {\n    "react": "18.0.0"\n  }\n}'),
    ).toBe('{\n  "dependencies": {\n    "react": "19.0.0"\n  }\n}')
  })

  it('keeps tab indentation', async () => {
    expect(
      await rewrite('{\n\t"dependencies": {\n\t\t"react": "18.0.0"\n\t}\n}\n'),
    ).toBe('{\n\t"dependencies": {\n\t\t"react": "19.0.0"\n\t}\n}\n')
  })

  it('keeps four-space indentation', async () => {
    expect(
      await rewrite(
        '{\n    "dependencies": {\n        "react": "18.0.0"\n    }\n}\n',
      ),
    ).toBe('{\n    "dependencies": {\n        "react": "19.0.0"\n    }\n}\n')
  })

  it('keeps CRLF line endings', async () => {
    expect(
      await rewrite(
        '{\r\n  "dependencies": {\r\n    "react": "18.0.0"\r\n  }\r\n}\r\n',
      ),
    ).toBe('{\r\n  "dependencies": {\r\n    "react": "19.0.0"\r\n  }\r\n}\r\n')
  })

  it('keeps the format when rewriting Bun catalogs', async () => {
    mockedFs.readFileSync.mockReturnValue(
      '{\n\t"catalog": {\n\t\t"react": "18.0.0"\n\t}\n}\n',
    )
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updateBunCatalogs('/test', { react: '19.0.0' })

    expect((mockedFs.writeFileSync as jest.Mock).mock.calls[0][1]).toBe(
      '{\n\t"catalog": {\n\t\t"react": "19.0.0"\n\t}\n}\n',
    )
  })
})

describe('updatePNPMWorkspaceYAML', () => {
  const outdatedPackages: Record<string, PackageInfo> = {
    react: {
      name: 'react',
      current: '18.0.0',
      wanted: '18.0.0',
      latest: '19.0.0',
    },
  }

  it('updates versions in pnpm-workspace.yaml preserving decorators', async () => {
    const yaml = `packages:\n  - "packages/*"\ncatalog:\n  react: ^18.0.0\n  lodash: ^4.17.0`
    mockedFs.readFileSync.mockReturnValue(yaml)
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePNPMWorkspaceYAML(
      '/test',
      versionsOf(['react'], outdatedPackages),
    )

    const written = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1]
    expect(written).toContain('^19.0.0')
    expect(written).toContain('^4.17.0') // lodash unchanged
  })

  const write = async (yaml: string, versions: Record<string, string>) => {
    mockedFs.readFileSync.mockReturnValue(yaml)
    mockedFs.writeFileSync.mockImplementation(() => undefined)
    await updatePNPMWorkspaceYAML('/test', versions)
    return (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1]
  }

  it('keeps the quotes a version was written with', async () => {
    // Before: double quotes came back as single quotes.
    expect(
      await write(`catalog:\n  react: "^18.0.0"`, { react: '19.0.0' }),
    ).toBe(`catalog:\n  react: "^19.0.0"`)
  })

  it('leaves overrides alone while it moves the catalog entry', async () => {
    // #80: the override's floor used to move from 1.11.0 to 1.11.23.
    const yaml =
      'packages:\n  - packages/*\ncatalog:\n  dayjs: 1.11.9\noverrides:\n  dayjs: ^1.11.0\n'

    expect(await write(yaml, { dayjs: '1.11.23' })).toBe(
      'packages:\n  - packages/*\ncatalog:\n  dayjs: 1.11.23\noverrides:\n  dayjs: ^1.11.0\n',
    )
  })

  it('rewrites named catalogs and nothing nested elsewhere', async () => {
    const yaml = [
      'catalogs:',
      '  react18:',
      '    react: ^18.2.0',
      '  tools:',
      '    dayjs: 1.11.9',
      'peerDependencyRules:',
      '  allowedVersions:',
      '    dayjs: 1.11.9',
    ].join('\n')

    expect(await write(yaml, { dayjs: '1.11.23', react: '19.3.1' })).toBe(
      [
        'catalogs:',
        '  react18:',
        '    react: ^19.3.1',
        '  tools:',
        '    dayjs: 1.11.23',
        'peerDependencyRules:',
        '  allowedVersions:',
        '    dayjs: 1.11.9',
      ].join('\n'),
    )
  })

  it('moves an entry with a trailing comment and keeps the comment', async () => {
    // Before: the comment was read as part of the version and nothing moved.
    expect(
      await write('catalog:\n  dayjs: 1.11.9 # pinned for the date picker\n', {
        dayjs: '1.11.23',
      }),
    ).toBe('catalog:\n  dayjs: 1.11.23 # pinned for the date picker\n')
  })

  it('reads a quoted scoped name', async () => {
    expect(
      await write(`catalog:\n  '@types/node': ^20.0.0\n`, {
        '@types/node': '22.1.0',
      }),
    ).toBe(`catalog:\n  '@types/node': ^22.1.0\n`)
  })

  it('leaves comment lines and other keys untouched', async () => {
    const yaml =
      '# dayjs: 1.0.0\ncatalog:\n  # dayjs: 1.0.0\n  react: ^18.0.0\nsavePrefix: "~"\n'

    expect(await write(yaml, { dayjs: '1.11.23', savePrefix: '1.0.0' })).toBe(
      yaml,
    )
  })

  it('keeps an exact pin exact', async () => {
    const yaml = `catalog:\n  react: 18.0.0\n  lodash: '4.17.0'`
    mockedFs.readFileSync.mockReturnValue(yaml)
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePNPMWorkspaceYAML(
      '/test',
      versionsOf(['react'], outdatedPackages),
    )

    const written = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1]
    expect(written).toBe(`catalog:\n  react: 19.0.0\n  lodash: '4.17.0'`)
  })

  it('keeps a quoted exact pin exact', async () => {
    const yaml = `catalog:\n  react: '18.0.0'`
    mockedFs.readFileSync.mockReturnValue(yaml)
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePNPMWorkspaceYAML(
      '/test',
      versionsOf(['react'], outdatedPackages),
    )

    const written = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1]
    expect(written).toBe(`catalog:\n  react: '19.0.0'`)
  })
})

describe('updateBunCatalogs', () => {
  const outdatedPackages: Record<string, PackageInfo> = {
    react: {
      name: 'react',
      current: '18.0.0',
      wanted: '18.0.0',
      latest: '19.0.0',
    },
    lodash: {
      name: 'lodash',
      current: '4.17.0',
      wanted: '4.17.0',
      latest: '4.18.0',
    },
  }

  it('updates default catalog entries', async () => {
    const packageJson = {
      catalog: { react: '^18.0.0', lodash: '^4.17.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updateBunCatalogs(
      '/test',
      versionsOf(['react', 'lodash'], outdatedPackages),
    )

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.catalog.react).toBe('^19.0.0')
    expect(written.catalog.lodash).toBe('^4.18.0')
  })

  it('updates named catalogs', async () => {
    const packageJson = {
      catalogs: {
        ui: { react: '^18.0.0' },
        utils: { lodash: '^4.17.0' },
      },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updateBunCatalogs(
      '/test',
      versionsOf(['react', 'lodash'], outdatedPackages),
    )

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.catalogs.ui.react).toBe('^19.0.0')
    expect(written.catalogs.utils.lodash).toBe('^4.18.0')
  })

  it('keeps exact pins exact in default and named catalogs', async () => {
    const packageJson = {
      catalog: { react: '18.0.0' },
      catalogs: { utils: { lodash: '4.17.0' } },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updateBunCatalogs(
      '/test',
      versionsOf(['react', 'lodash'], outdatedPackages),
    )

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.catalog.react).toBe('19.0.0')
    expect(written.catalogs.utils.lodash).toBe('4.18.0')
  })

  it('does not write file when no catalogs match', async () => {
    const packageJson = {
      catalog: { vue: '^3.0.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updateBunCatalogs('/test', versionsOf(['react'], outdatedPackages))

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
  })
})

describe('identifyCatalogPackages', () => {
  it('separates catalog packages from root packages', () => {
    const packageJson = {
      catalog: { react: '^18.0.0' },
      catalogs: { utils: { lodash: '^4.17.0' } },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))

    const outdatedPackages: Record<string, PackageInfo> = {
      react: {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '19.0.0',
      },
      lodash: {
        name: 'lodash',
        current: '4.17.0',
        wanted: '4.17.0',
        latest: '4.18.0',
      },
      express: {
        name: 'express',
        current: '4.0.0',
        wanted: '4.0.0',
        latest: '5.0.0',
      },
    }

    const result = identifyCatalogPackages('/test', outdatedPackages)

    expect(result.catalogPackages).toEqual(
      expect.arrayContaining(['react', 'lodash']),
    )
    expect(result.rootPackages).toEqual(['express'])
  })

  it('returns all as root when no catalogs exist', () => {
    const packageJson = { dependencies: { react: '^18.0.0' } }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))

    const outdatedPackages: Record<string, PackageInfo> = {
      react: {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '19.0.0',
      },
    }

    const result = identifyCatalogPackages('/test', outdatedPackages)

    expect(result.catalogPackages).toEqual([])
    expect(result.rootPackages).toEqual(['react'])
  })
})
