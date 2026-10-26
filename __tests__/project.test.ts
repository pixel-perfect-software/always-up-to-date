jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn(),
}))
jest.mock('@/utils/config')
jest.mock('@/utils/logger')
jest.mock('@/utils/registry', () => ({
  createRegistrySession: jest.fn(),
}))

import detectPackageManager from '@/detectPackageManager'
import bun from '@/managers/bun'
import pnpm from '@/managers/pnpm'
import { openProject } from '@/project'
import { DEFAULT_CONFIG, loadConfig } from '@/utils/config'
import logger from '@/utils/logger'
import { createRegistrySession } from '@/utils/registry'
import { fakeRegistry } from './fixtures'

describe('openProject', () => {
  it('returns the directory, the loaded config and the detected adapter', () => {
    const config = {
      ...DEFAULT_CONFIG,
      beyondRange: 'minor' as const,
      depsDev: true,
    }
    jest.mocked(loadConfig).mockReturnValue(config)
    jest.mocked(detectPackageManager).mockReturnValue('pnpm')
    const session = fakeRegistry()
    jest.mocked(createRegistrySession).mockReturnValue(session)

    const project = openProject('/project')

    expect(project).toEqual({
      cwd: '/project',
      config,
      adapter: pnpm,
      registry: session,
    })
    expect(createRegistrySession).toHaveBeenCalledWith('/project', {
      depsDev: true,
    })
    expect(detectPackageManager).toHaveBeenCalledWith('/project', undefined)
  })

  it("hands the config's depsDev switch to the registry session", () => {
    jest
      .mocked(loadConfig)
      .mockReturnValue({ ...DEFAULT_CONFIG, depsDev: false })
    jest.mocked(detectPackageManager).mockReturnValue('npm')

    openProject('/project')

    expect(createRegistrySession).toHaveBeenCalledWith('/project', {
      depsDev: false,
    })
  })

  it('hands --pm to detection', () => {
    jest.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG })
    jest.mocked(detectPackageManager).mockReturnValue('bun')

    expect(openProject('/project', { pm: 'bun' }).adapter).toBe(bun)
    expect(detectPackageManager).toHaveBeenCalledWith('/project', 'bun')
  })

  it('loads the config once and configures the logger with it', () => {
    const config = { ...DEFAULT_CONFIG, debug: true }
    jest.mocked(loadConfig).mockReturnValue(config)
    jest.mocked(detectPackageManager).mockReturnValue('npm')

    openProject('/project')

    expect(loadConfig).toHaveBeenCalledTimes(1)
    expect(loadConfig).toHaveBeenCalledWith('/project')
    expect(logger.configure).toHaveBeenCalledWith(config)
  })

  it('configures the logger before it detects the manager', () => {
    jest.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG })
    jest.mocked(detectPackageManager).mockImplementation(() => {
      throw new Error('No package manager detected in the current directory.')
    })

    expect(() => openProject('/project')).toThrow('No package manager')
    expect(logger.configure).toHaveBeenCalledTimes(1)
    expect(
      jest.mocked(logger.configure).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(detectPackageManager).mock.invocationCallOrder[0],
    )
  })

  it('stops at a bad config before it configures or detects anything', () => {
    jest.mocked(loadConfig).mockImplementation(() => {
      throw new Error('Failed to load JSON config')
    })

    expect(() => openProject('/project')).toThrow('Failed to load JSON config')
    expect(logger.configure).not.toHaveBeenCalled()
    expect(detectPackageManager).not.toHaveBeenCalled()
  })
})
