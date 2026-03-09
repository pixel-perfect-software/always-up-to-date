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
    react: { name: 'react', current: '18.0.0', latest: '19.0.0' },
    typescript: {
      name: 'typescript',
      current: '5.0.0',
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

    await updatePackageJson('/test', ['react', 'typescript'], outdatedPackages)

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('^19.0.0')
    expect(written.devDependencies.typescript).toBe('~5.5.0')
  })

  it('defaults to ^ when no decorator exists', async () => {
    const packageJson = {
      dependencies: { react: '18.0.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePackageJson('/test', ['react'], outdatedPackages)

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('^19.0.0')
  })

  it('skips workspace references', async () => {
    const packageJson = {
      dependencies: { react: 'workspace:*' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePackageJson('/test', ['react'], outdatedPackages)

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

    await updatePackageJson('/test', ['react'], outdatedPackages)

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

    await updatePackageJson('/test', ['react'], outdatedPackages)

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('^19.0.0')
    expect(written.devDependencies.react).toBe('^19.0.0')
    expect(written.optionalDependencies.react).toBe('^19.0.0')
    expect(written.peerDependencies.react).toBe('^19.0.0')
  })

  it('handles >= version decorator', async () => {
    const packageJson = {
      dependencies: { react: '>=18.0.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePackageJson('/test', ['react'], outdatedPackages)

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.dependencies.react).toBe('>=19.0.0')
  })
})

describe('updatePNPMWorkspaceYAML', () => {
  const outdatedPackages: Record<string, PackageInfo> = {
    react: { name: 'react', current: '18.0.0', latest: '19.0.0' },
  }

  it('updates versions in pnpm-workspace.yaml preserving decorators', async () => {
    const yaml = `packages:\n  - "packages/*"\ncatalog:\n  react: ^18.0.0\n  lodash: ^4.17.0`
    mockedFs.readFileSync.mockReturnValue(yaml)
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePNPMWorkspaceYAML('/test', ['react'], outdatedPackages)

    const written = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1]
    expect(written).toContain('^19.0.0')
    expect(written).toContain('^4.17.0') // lodash unchanged
  })

  it('preserves quoted versions', async () => {
    const yaml = `catalog:\n  react: "^18.0.0"`
    mockedFs.readFileSync.mockReturnValue(yaml)
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updatePNPMWorkspaceYAML('/test', ['react'], outdatedPackages)

    const written = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1]
    expect(written).toContain("'^19.0.0'")
  })
})

describe('updateBunCatalogs', () => {
  const outdatedPackages: Record<string, PackageInfo> = {
    react: { name: 'react', current: '18.0.0', latest: '19.0.0' },
    lodash: { name: 'lodash', current: '4.17.0', latest: '4.18.0' },
  }

  it('updates default catalog entries', async () => {
    const packageJson = {
      catalog: { react: '^18.0.0', lodash: '^4.17.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updateBunCatalogs('/test', ['react', 'lodash'], outdatedPackages)

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

    await updateBunCatalogs('/test', ['react', 'lodash'], outdatedPackages)

    const written = JSON.parse(
      (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1],
    )
    expect(written.catalogs.ui.react).toBe('^19.0.0')
    expect(written.catalogs.utils.lodash).toBe('^4.18.0')
  })

  it('does not write file when no catalogs match', async () => {
    const packageJson = {
      catalog: { vue: '^3.0.0' },
    }
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(packageJson))
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    await updateBunCatalogs('/test', ['react'], outdatedPackages)

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
      react: { name: 'react', current: '18.0.0', latest: '19.0.0' },
      lodash: { name: 'lodash', current: '4.17.0', latest: '4.18.0' },
      express: { name: 'express', current: '4.0.0', latest: '5.0.0' },
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
      react: { name: 'react', current: '18.0.0', latest: '19.0.0' },
    }

    const result = identifyCatalogPackages('/test', outdatedPackages)

    expect(result.catalogPackages).toEqual([])
    expect(result.rootPackages).toEqual(['react'])
  })
})
