import path from 'path'
import type { NpmrcSources } from '@/utils/npmrcLoader'
import { npmrcSources, tempDir, write } from '../fixtures/files'

// #269: in the Bun-compiled binary `process.execPath` is autd itself, so npm's
// and yarn v1's default prefix (`<node prefix>/etc/npmrc`) was never read. Under
// Bun the `node` on PATH is asked once instead.

type Loader = typeof import('@/utils/npmrcLoader')
type YarnNpmrc = typeof import('@/managers/yarn/npmrc')

describe('the node npm runs under (#269)', () => {
  let tmp: string
  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const nodePath = () =>
    process.platform === 'win32'
      ? at('nodeprefix', 'node.exe')
      : at('nodeprefix', 'bin', 'node')
  const prefixFile = () => at('nodeprefix', 'etc', 'npmrc')

  const hadBun = Object.getOwnPropertyDescriptor(process.versions, 'bun')
  const asBun = () =>
    Object.defineProperty(process.versions, 'bun', {
      value: '1.4.0',
      configurable: true,
      enumerable: true,
    })
  // The probe's call differs on Windows (through cmd.exe), and CI runs the
  // suite there too, so the tests of its shape pin the platform.
  const hadPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const onPlatform = (platform: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    })

  /** Fresh modules (the probe is memoized per module) over a mocked `execFileSync`. */
  const load = (
    execFileSync: jest.Mock,
  ): { loader: Loader; yarn: YarnNpmrc } => {
    let loaded: { loader: Loader; yarn: YarnNpmrc } | undefined
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({ execFileSync }))
      loaded = {
        // biome-ignore lint/style/noCommonJs: jest.isolateModules requires synchronous require
        loader: require('@/utils/npmrcLoader'),
        // biome-ignore lint/style/noCommonJs: jest.isolateModules requires synchronous require
        yarn: require('@/managers/yarn/npmrc'),
      }
    })
    if (!loaded) throw new Error('modules did not load')
    return loaded
  }

  const printsNode = () => jest.fn(() => `${nodePath()}\n`)
  const errno = (code: string) =>
    Object.assign(new Error(`spawn node ${code}`), { code })

  beforeEach(() => {
    tmp = tempDir('autd-node-', { real: true })
    write(at('proj', 'package.json'), '{}')
  })

  afterEach(() => {
    if (hadBun) Object.defineProperty(process.versions, 'bun', hadBun)
    else delete (process.versions as { bun?: string }).bun
    if (hadPlatform) Object.defineProperty(process, 'platform', hadPlatform)
    jest.dontMock('child_process')
  })

  describe('npmNodeExecPath', () => {
    it('is the running execPath under Node, never starting node', () => {
      const exec = printsNode()
      const { loader } = load(exec)

      expect(
        loader.npmNodeExecPath({
          versions: { node: '24.0.0' },
          execPath: '/usr/local/bin/node',
        }),
      ).toBe('/usr/local/bin/node')
      expect(exec).not.toHaveBeenCalled()
    })

    it('asks the probe under Bun instead of using the binary itself', () => {
      const { loader } = load(printsNode())

      expect(
        loader.npmNodeExecPath({
          versions: { bun: '1.4.0' },
          execPath: '/opt/autd',
          probe: () => '/usr/local/bin/node',
        }),
      ).toBe('/usr/local/bin/node')
    })

    it('is undefined under Bun when no node is on PATH', () => {
      const { loader } = load(printsNode())

      expect(
        loader.npmNodeExecPath({
          versions: { bun: '1.4.0' },
          execPath: '/opt/autd',
          probe: () => undefined,
        }),
      ).toBeUndefined()
    })

    describe('the default probe', () => {
      beforeEach(asBun)

      it('prints node via an argument array, trimmed, in the directory asked', () => {
        onPlatform('linux')
        const exec = printsNode()
        const { loader } = load(exec)

        expect(loader.npmNodeExecPath({ cwd: at('proj') })).toBe(nodePath())
        expect(exec).toHaveBeenCalledWith(
          'node',
          ['-p', 'process.execPath'],
          expect.objectContaining({ encoding: 'utf8', cwd: at('proj') }),
        )
      })

      describe('on Windows', () => {
        const hadPath = process.env.PATH
        afterEach(() => {
          process.env.PATH = hadPath
        })

        it('runs node through cmd.exe once PATH holds a node (a .cmd shim counts)', () => {
          onPlatform('win32')
          write(at('winbin', 'node.cmd'), '@echo off\r\n')
          process.env.PATH = at('winbin')
          const exec = printsNode()
          const { loader } = load(exec)

          expect(loader.npmNodeExecPath({ cwd: at('proj') })).toBe(nodePath())
          expect(exec).toHaveBeenCalledWith(
            'node -p process.execPath',
            expect.objectContaining({ shell: true, cwd: at('proj') }),
          )
        })

        it('is undefined with no node on PATH, starting no cmd.exe (#266: an empty PATH under Bun)', () => {
          onPlatform('win32')
          process.env.PATH = at('empty')
          const exec = printsNode()
          const { loader } = load(exec)

          expect(loader.npmNodeExecPath()).toBeUndefined()
          expect(exec).not.toHaveBeenCalled()
        })

        it('still reads cmd.exe status 9009 as no node', () => {
          onPlatform('win32')
          write(at('winbin', 'node.exe'), '')
          process.env.PATH = at('winbin')
          const { loader } = load(
            jest.fn(() => {
              throw Object.assign(new Error('Command failed'), {
                status: 9009,
              })
            }),
          )

          expect(loader.npmNodeExecPath()).toBeUndefined()
        })
      })

      it('asks once per directory, since a version manager picks node by directory', () => {
        onPlatform('linux')
        const exec = printsNode()
        const { loader } = load(exec)

        loader.npmNodeExecPath({ cwd: at('proj') })
        loader.npmNodeExecPath({ cwd: at('proj') })
        loader.npmNodeExecPath({ cwd: at('other') })

        expect(exec).toHaveBeenCalledTimes(2)
        expect(exec).toHaveBeenNthCalledWith(
          1,
          'node',
          ['-p', 'process.execPath'],
          expect.objectContaining({ cwd: at('proj') }),
        )
        expect(exec).toHaveBeenNthCalledWith(
          2,
          'node',
          ['-p', 'process.execPath'],
          expect.objectContaining({ cwd: at('other') }),
        )
      })

      it('runs once across calls', () => {
        const exec = printsNode()
        const { loader } = load(exec)

        loader.npmNodeExecPath()
        loader.npmNodeExecPath()

        expect(exec).toHaveBeenCalledTimes(1)
      })

      it('remembers that there is no node', () => {
        const exec = jest.fn(() => {
          throw errno('ENOENT')
        })
        const { loader } = load(exec)

        expect(loader.npmNodeExecPath()).toBeUndefined()
        expect(loader.npmNodeExecPath()).toBeUndefined()
        expect(exec).toHaveBeenCalledTimes(1)
      })

      it('fails the discover step on any other failure, naming the cause, once', () => {
        const exec = jest.fn(() => {
          throw errno('EACCES')
        })
        const { loader } = load(exec)

        for (let i = 0; i < 2; i++) {
          let thrown: unknown
          try {
            loader.npmNodeExecPath()
          } catch (error) {
            thrown = error
          }
          expect(thrown).toMatchObject({
            name: 'StepError',
            step: 'discover',
            message: expect.stringMatching(/couldn't ask node.*EACCES/),
          })
        }
        expect(exec).toHaveBeenCalledTimes(1)
      })

      it('throws when node prints nothing', () => {
        const { loader } = load(jest.fn(() => '\n'))

        expect(() => loader.npmNodeExecPath()).toThrow(/printed nothing/)
      })
    })
  })

  describe('processSources', () => {
    it('does not start node until execPath is read', () => {
      asBun()
      const exec = printsNode()
      const { loader } = load(exec)

      const sources = loader.processSources()
      expect(exec).not.toHaveBeenCalled()

      expect(sources.execPath).toBe(nodePath())
      expect(exec).toHaveBeenCalledTimes(1)
    })

    it('keeps process.execPath under Node', () => {
      const exec = printsNode()
      const { loader } = load(exec)

      expect(loader.processSources().execPath).toBe(process.execPath)
      expect(exec).not.toHaveBeenCalled()
    })
  })

  describe('under Bun, with node on PATH', () => {
    beforeEach(asBun)

    it('reads min-release-age from <node prefix>/etc/npmrc', () => {
      write(prefixFile(), 'min-release-age=730\n')
      const { loader } = load(printsNode())
      const sources: NpmrcSources = {
        ...loader.processSources(),
        env: {},
        home: at('home'),
      }

      expect(loader.loadNpmrc(at('proj'), sources)['min-release-age']).toBe(
        '730',
      )
    })

    it('gives yarn v1 the same prefix file', () => {
      write(prefixFile(), 'min-release-age=730\n')
      const { loader, yarn } = load(printsNode())
      const sources: NpmrcSources = {
        ...loader.processSources(),
        env: {},
        home: at('home'),
      }

      const merged = loader.mergeNpmrcLayers(
        yarn.yarnNpmrcLayers(at('proj'), sources),
      )

      expect(merged.values['min-release-age']).toBe('730')
    })
  })

  describe('without a node', () => {
    const noNode = (env: NodeJS.ProcessEnv = {}) =>
      npmrcSources(tmp, env, { execPath: undefined })

    it('has no builtin or global layer for npm', () => {
      const { loader } = load(printsNode())

      expect(loader.npmNpmrcLayers(at('proj'), noNode())).toHaveLength(3)
    })

    it('still reads the global file PREFIX names', () => {
      write(at('custom', 'etc', 'npmrc'), 'k=prefix')
      const { loader } = load(printsNode())

      expect(
        loader.loadNpmrc(at('proj'), noNode({ PREFIX: at('custom') })).k,
      ).toBe('prefix')
    })

    it('still reads a globalconfig named in the user .npmrc', () => {
      write(at('elsewhere', 'npmrc'), 'k=global')
      write(at('home', '.npmrc'), `globalconfig=${at('elsewhere', 'npmrc')}`)
      const { loader } = load(printsNode())

      expect(loader.loadNpmrc(at('proj'), noNode()).k).toBe('global')
    })

    it('gives yarn v1 no prefix file', () => {
      write(prefixFile(), 'k=prefix')
      const { loader, yarn } = load(printsNode())

      expect(
        loader.mergeNpmrcLayers(yarn.yarnNpmrcLayers(at('proj'), noNode()))
          .values.k,
      ).toBeUndefined()
    })

    it('still gives yarn v1 the prefix file PREFIX names', () => {
      write(at('custom', 'etc', 'npmrc'), 'k=prefix')
      const { loader, yarn } = load(printsNode())

      expect(
        loader.mergeNpmrcLayers(
          yarn.yarnNpmrcLayers(at('proj'), noNode({ PREFIX: at('custom') })),
        ).values.k,
      ).toBe('prefix')
    })
  })
})
