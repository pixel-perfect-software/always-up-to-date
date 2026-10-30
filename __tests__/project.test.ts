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
import type { RegistryConfig } from '@/types'
import { DEFAULT_CONFIG, loadConfig } from '@/utils/config'
import logger from '@/utils/logger'
import { createRegistrySession } from '@/utils/registry'
import { fakeRegistry } from './fixtures'

const registryDefaults: RegistryConfig = {
  registry: 'https://registry.npmjs.org/',
  scopedRegistries: {},
  credentials: {},
  strictSSL: true,
  proxy: {},
  fetchRetries: 2,
  fetchTimeout: 300_000,
  maxSockets: 15,
}

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
      root: '/project',
      config,
      adapter: pnpm,
      registry: session,
    })
    expect(createRegistrySession).toHaveBeenCalledWith('/project', {
      depsDev: true,
      loadConfig: expect.any(Function),
    })
    expect(detectPackageManager).toHaveBeenCalledWith('/project', undefined, {
      from: '/project',
      cwd: '/project',
    })
  })

  it("hands the config's depsDev switch to the registry session", () => {
    jest
      .mocked(loadConfig)
      .mockReturnValue({ ...DEFAULT_CONFIG, depsDev: false })
    jest.mocked(detectPackageManager).mockReturnValue('npm')

    openProject('/project')

    expect(createRegistrySession).toHaveBeenCalledWith('/project', {
      depsDev: false,
      loadConfig: expect.any(Function),
    })
  })

  describe('the registry cache', () => {
    const cacheOption = (env: string | undefined, options = {}) => {
      jest.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG })
      jest.mocked(detectPackageManager).mockReturnValue('npm')
      const saved = process.env.AUTD_NO_CACHE
      if (env === undefined) delete process.env.AUTD_NO_CACHE
      else process.env.AUTD_NO_CACHE = env
      try {
        openProject('/project', options)
      } finally {
        if (saved === undefined) delete process.env.AUTD_NO_CACHE
        else process.env.AUTD_NO_CACHE = saved
      }
      return jest.mocked(createRegistrySession).mock.calls[0][1]?.cache
    }

    it('is on by default', () => {
      expect(cacheOption(undefined)).toEqual({})
    })

    it('is off with cache: false (--no-cache)', () => {
      expect(cacheOption(undefined, { cache: false })).toBeUndefined()
    })

    it('is off with AUTD_NO_CACHE=1', () => {
      expect(cacheOption('1')).toBeUndefined()
    })

    it.each(['1', 'true', 'TRUE', 'yes', ' on ', '2'])(
      'is off with AUTD_NO_CACHE=%j',
      (value) => {
        expect(cacheOption(value)).toBeUndefined()
      },
    )

    it.each(['0', 'false', 'False', ' 0 ', ''])(
      'stays on with AUTD_NO_CACHE=%j',
      (value) => {
        expect(cacheOption(value)).toEqual({})
      },
    )
  })

  describe('registry config', () => {
    const openWith = (pm: 'pnpm' | 'npm') => {
      jest.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG })
      jest.mocked(detectPackageManager).mockReturnValue(pm)
      openProject('/project')
      const options = jest.mocked(createRegistrySession).mock.calls[0][1]
      if (!options?.loadConfig) throw new Error('no loadConfig seam')
      return options.loadConfig
    }

    it('is not built by openProject, only by the session on first use', () => {
      const layers = jest.spyOn(pnpm, 'npmrcLayers')
      const loadConfigForSession = openWith('pnpm')
      expect(layers).not.toHaveBeenCalled()

      layers.mockReturnValue([])
      expect(loadConfigForSession('/project')).toEqual(registryDefaults)
      expect(layers).toHaveBeenCalledTimes(1)
      expect(layers).toHaveBeenCalledWith(
        '/project',
        expect.objectContaining({ env: process.env }),
      )
    })

    it("uses npm's layers for a manager without npmrcLayers", () => {
      const loadConfigForSession = openWith('npm')
      expect(loadConfigForSession('/nonexistent-autd-project')).toEqual(
        expect.objectContaining({ strictSSL: true }),
      )
    })

    it('hands registryConfig the merged view as its fourth argument, and builds nothing in openProject', () => {
      const hook = jest.spyOn(bun, 'registryConfig')
      jest.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG })
      jest.mocked(detectPackageManager).mockReturnValue('bun')
      openProject('/project')
      const options = jest.mocked(createRegistrySession).mock.calls[0][1]
      expect(hook).not.toHaveBeenCalled()

      const adjusted = {
        ...registryDefaults,
        registry: 'http://adjusted.test/',
      }
      hook.mockReturnValue(adjusted)
      expect(options?.loadConfig?.('/nonexistent-autd-project')).toBe(adjusted)
      expect(hook).toHaveBeenCalledWith(
        '/nonexistent-autd-project',
        expect.objectContaining({ registry: expect.any(String) }),
        expect.objectContaining({ env: process.env }),
        expect.objectContaining({
          values: expect.any(Object),
          origin: expect.any(Function),
        }),
      )
    })
  })

  it('hands --pm to detection', () => {
    jest.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG })
    jest.mocked(detectPackageManager).mockReturnValue('bun')

    expect(openProject('/project', { pm: 'bun' }).adapter).toBe(bun)
    expect(detectPackageManager).toHaveBeenCalledWith('/project', 'bun', {
      from: '/project',
      cwd: '/project',
    })
  })

  it('loads the config once and configures the logger with it', () => {
    const config = { ...DEFAULT_CONFIG, debug: true }
    jest.mocked(loadConfig).mockReturnValue(config)
    jest.mocked(detectPackageManager).mockReturnValue('npm')

    openProject('/project')

    expect(loadConfig).toHaveBeenCalledTimes(1)
    expect(loadConfig).toHaveBeenCalledWith('/project', '/project')
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
