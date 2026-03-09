import fs from 'fs'
import path from 'path'
import detectPackageManager from '@/detectPackageManager'

jest.mock('fs')

const mockedFs = jest.mocked(fs)

describe('detectPackageManager', () => {
  beforeEach(() => {
    mockedFs.existsSync.mockReturnValue(false)
  })

  it('detects npm by package-lock.json', () => {
    mockedFs.existsSync.mockImplementation((filePath) =>
      String(filePath).endsWith('package-lock.json'),
    )
    expect(detectPackageManager('/test')).toBe('npm')
  })

  it('detects yarn by yarn.lock', () => {
    mockedFs.existsSync.mockImplementation((filePath) =>
      String(filePath).endsWith('yarn.lock'),
    )
    expect(detectPackageManager('/test')).toBe('yarn')
  })

  it('detects pnpm by pnpm-lock.yaml', () => {
    mockedFs.existsSync.mockImplementation((filePath) =>
      String(filePath).endsWith('pnpm-lock.yaml'),
    )
    expect(detectPackageManager('/test')).toBe('pnpm')
  })

  it('detects bun by bun.lock', () => {
    mockedFs.existsSync.mockImplementation((filePath) =>
      String(filePath).endsWith('bun.lock'),
    )
    expect(detectPackageManager('/test')).toBe('bun')
  })

  it('throws when no lock file is found', () => {
    expect(() => detectPackageManager('/test')).toThrow(
      'No package manager detected in the current directory.',
    )
  })

  it('returns the last matching manager when multiple lock files exist', () => {
    // Both npm and pnpm lock files exist — pnpm comes later in iteration
    mockedFs.existsSync.mockImplementation((filePath) => {
      const f = String(filePath)
      return f.endsWith('package-lock.json') || f.endsWith('pnpm-lock.yaml')
    })
    expect(detectPackageManager('/test')).toBe('pnpm')
  })

  it('constructs correct lock file paths using cwd', () => {
    mockedFs.existsSync.mockReturnValue(false)
    try {
      detectPackageManager('/my/project')
    } catch {
      // expected
    }
    expect(mockedFs.existsSync).toHaveBeenCalledWith(
      path.join('/my/project', 'package-lock.json'),
    )
    expect(mockedFs.existsSync).toHaveBeenCalledWith(
      path.join('/my/project', 'pnpm-lock.yaml'),
    )
  })
})
