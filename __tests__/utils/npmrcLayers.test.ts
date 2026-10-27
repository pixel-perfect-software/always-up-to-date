import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  type EnvRule,
  envLayer,
  loadNpmrc,
  mergeNpmrcLayers,
  NPM_ENV,
  type NpmrcLayer,
  type NpmrcSources,
  npmNpmrcLayers,
  npmrcFileLayer,
} from '@/utils/npmrcLoader'

describe('npmrc layers', () => {
  let tmp: string

  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const sourcesFor = (env: NodeJS.ProcessEnv = {}): NpmrcSources => ({
    env,
    home: at('home'),
    execPath:
      process.platform === 'win32'
        ? path.join(tmp, 'prefix', 'node.exe')
        : path.join(tmp, 'prefix', 'bin', 'node'),
    platform: process.platform,
  })
  const env = (values: Record<string, string>): NpmrcLayer => ({
    kind: 'env',
    values: Object.assign(Object.create(null), values),
  })

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npmrc-layers-')),
    )
    write(at('proj', 'package.json'), '{}')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('mergeNpmrcLayers', () => {
    it('takes each key from the highest layer that sets it', () => {
      const view = mergeNpmrcLayers([
        env({ a: 'high' }),
        env({ a: 'mid', b: 'mid' }),
        env({ a: 'low', b: 'low', c: 'low' }),
      ])
      expect({ ...view.values }).toEqual({ a: 'high', b: 'mid', c: 'low' })
    })

    it('lets a boolean, null or array override a lower string', () => {
      const lower = env({ a: 'x', b: 'x', c: 'x' })
      const higher: NpmrcLayer = {
        kind: 'env',
        values: Object.assign(Object.create(null), {
          a: false,
          b: null,
          c: ['y'],
        }),
      }
      expect({ ...mergeNpmrcLayers([higher, lower]).values }).toEqual({
        a: false,
        b: null,
        c: ['y'],
      })
    })

    it('names the layer that set each key', () => {
      const high = env({ a: '1' })
      const low = env({ a: '2', b: '2' })
      const view = mergeNpmrcLayers([high, low])
      expect(view.origin('a')).toBe(high)
      expect(view.origin('b')).toBe(low)
      expect(view.origin('missing')).toBeUndefined()
    })

    it('gives an empty view for no layers', () => {
      const view = mergeNpmrcLayers([])
      expect({ ...view.values }).toEqual({})
      expect(view.origin('a')).toBeUndefined()
    })
  })

  describe('envLayer', () => {
    const rule: EnvRule = {
      prefix: /^app_/,
      key: (rest, name) => (rest === 'skip' ? undefined : `${name}:${rest}`),
      substitute: null,
    }

    it('reads the variables the prefix matches, keyed by the rule', () => {
      const layer = envLayer({ app_one: '1', other: '2' }, rule)
      expect(layer.kind).toBe('env')
      expect({ ...layer.values }).toEqual({ 'app_one:one': '1' })
    })

    it('skips a variable whose key() is undefined, and empty values', () => {
      const layer = envLayer({ app_skip: '1', app_empty: '' }, rule)
      expect({ ...layer.values }).toEqual({})
    })

    it('leaves ${X} as written with substitute null, and expands it otherwise', () => {
      const vars = { app_a: '${X}', X: 'set' }
      expect(envLayer(vars, rule).values['app_a:a']).toBe('${X}')
      expect(
        envLayer(vars, {
          ...rule,
          substitute: (t, e) => t.replace('${X}', e.X ?? ''),
        }).values['app_a:a'],
      ).toBe('set')
    })

    it('reads npm_config_* as npm does', () => {
      const layer = envLayer(
        { NPM_CONFIG_FETCH_TIMEOUT: '5', 'npm_config_//h/:_authToken': 't' },
        NPM_ENV,
      )
      expect({ ...layer.values }).toEqual({
        'fetch-timeout': '5',
        '//h/:_authToken': 't',
      })
    })
  })

  describe('npmrcFileLayer', () => {
    it('is empty for a missing file and records the path', () => {
      const layer = npmrcFileLayer(at('none'), {})
      expect(layer).toEqual({ kind: 'file', file: at('none'), values: {} })
    })

    it('is empty for a path that cannot be read as a file', () => {
      fs.mkdirSync(at('dir'))
      expect({ ...npmrcFileLayer(at('dir'), {}).values }).toEqual({})
    })

    it('expands ${VAR} with npm rules by default', () => {
      write(at('f'), 'a=${X}\nb=${UNSET}\n')
      expect({ ...npmrcFileLayer(at('f'), { X: 'v' }).values }).toEqual({
        a: 'v',
        b: '${UNSET}',
      })
    })

    it('uses the substitute it is given', () => {
      write(at('f'), 'a=${X}\n')
      const layer = npmrcFileLayer(
        at('f'),
        {},
        { substitute: (text) => text.replace('${X}', 'sub') },
      )
      expect({ ...layer.values }).toEqual({ a: 'sub' })
    })

    it('leaves out an entry holding ${…} in its value or key when substitute is null', () => {
      write(
        at('f'),
        'keep=1\nvalue=${X}\n//h:${X}/:_authToken=t\nlist[]=a\nlist[]=${X}\n',
      )
      expect({
        ...npmrcFileLayer(at('f'), { X: 'v' }, { substitute: null }).values,
      }).toEqual({
        keep: '1',
      })
    })
  })

  describe('npmNpmrcLayers', () => {
    it('returns env, project, user, global and builtin, in that order', () => {
      write(at('proj', '.npmrc'), 'p=1')
      write(at('home', '.npmrc'), 'u=1')
      write(at('prefix', 'etc', 'npmrc'), 'g=1')
      const layers = npmNpmrcLayers(
        at('proj'),
        sourcesFor({ npm_config_e: '1' }),
      )

      expect(layers.map((l) => l.kind)).toEqual([
        'env',
        'file',
        'file',
        'file',
        'file',
      ])
      expect(layers.map((l) => ({ ...l.values }))).toEqual([
        { e: '1' },
        { p: '1' },
        { u: '1' },
        { g: '1' },
        {},
      ])
      expect(layers[1].kind === 'file' && layers[1].file).toBe(
        at('proj', '.npmrc'),
      )
    })

    it('merges to what loadNpmrc returns', () => {
      write(at('proj', '.npmrc'), 'k=project\nonly-p=1')
      write(at('home', '.npmrc'), 'k=user\nonly-u=1')
      const sources = sourcesFor({ npm_config_only_e: '1' })

      expect({
        ...mergeNpmrcLayers(npmNpmrcLayers(at('proj'), sources)).values,
      }).toEqual({
        ...loadNpmrc(at('proj'), sources),
      })
    })

    it('gives an empty project layer when the project file is the user config', () => {
      write(at('proj', '.npmrc'), 'k=1')
      const layers = npmNpmrcLayers(at('proj'), {
        ...sourcesFor(),
        home: at('proj'),
      })
      expect({ ...layers[1].values }).toEqual({})
      expect({ ...layers[2].values }).toEqual({ k: '1' })
    })
  })
})
