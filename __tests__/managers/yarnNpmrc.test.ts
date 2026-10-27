jest.mock('@/utils/logger')

import fs from 'fs'
import os from 'os'
import path from 'path'
import yarn from '@/managers/yarn'
import { yarnNpmrcLayers } from '@/managers/yarn/npmrc'
import { yarnRegistryConfig } from '@/managers/yarn/yarnrc'
import type { RegistryConfig } from '@/types'
import {
  mergeNpmrcLayers,
  type NpmrcSources,
  npmNpmrcLayers,
  registryConfigFrom,
} from '@/utils/npmrcLoader'
import {
  authorizationFor,
  credentialsFor,
  packumentUrl,
  registryFor,
} from '@/utils/registryRequest'

// Each decision below was probed on yarn 1.22.22, 2026-10-26; the ids (y20,
// ...) name the probe rows. Rows that depend on the prefix ran on yarn.js
// directly: Homebrew's wrapper forces PREFIX=/opt/homebrew.

const A = 'http://127.0.0.1:4001/'
const B = 'http://127.0.0.1:4002/'
const AH = '127.0.0.1:4001'
const BH = '127.0.0.1:4002'
const NPMJS = 'registry.npmjs.org'

describe('yarn v1 .npmrc layers', () => {
  let tmp: string

  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  /** A workspace root at `<tmp>/proj` with a member at `<tmp>/proj/packages/app`. */
  const root = () => at('proj')
  const member = () => at('proj', 'packages', 'app')
  const home = (...parts: string[]) => at('home', ...parts)
  const prefixFile = () => at('prefix', 'etc', 'npmrc')

  const sourcesFor = (env: NodeJS.ProcessEnv = {}): NpmrcSources => ({
    env,
    home: home(),
    // node.exe sits in the prefix on Windows, in <prefix>/bin elsewhere.
    execPath:
      process.platform === 'win32'
        ? at('prefix', 'node.exe')
        : at('prefix', 'bin', 'node'),
    platform: process.platform,
  })

  /** The config autd builds for yarn v1 from `cwd`. */
  const configFor = (
    cwd: string,
    env: NodeJS.ProcessEnv = {},
  ): RegistryConfig => {
    const sources = sourcesFor(env)
    const view = mergeNpmrcLayers(yarnNpmrcLayers(cwd, sources))
    return yarnRegistryConfig(
      cwd,
      registryConfigFrom(view, cwd, sources),
      sources,
      view,
    )
  }

  /** Where a package goes and the Authorization it gets, as the client would send. */
  const sent = (config: RegistryConfig, name: string) => {
    const registry = registryFor(name, config)
    const url = new URL(packumentUrl(name, registry))
    return {
      server: url.host,
      auth: authorizationFor(credentialsFor(url, registry, config.credentials)),
    }
  }
  const scoped = (config: RegistryConfig) => sent(config, '@acme/probe')

  const token = (value: string, host = BH) => `//${host}/:_authToken=${value}\n`

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autd-yarn-')))
    write(path.join(root(), 'package.json'), '{"workspaces":["packages/*"]}')
    write(path.join(member(), 'package.json'), '{"name":"app"}')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('#122 evidence', () => {
    it('row 1: a member .npmrc registry beats the root one', () => {
      write(path.join(root(), '.npmrc'), `registry=${A}\n`)
      write(path.join(member(), '.npmrc'), `registry=${B}\n`)
      expect(configFor(member()).registry).toBe(B)
    })

    it('row 2: ~/.npmrc beats the root .npmrc from a member', () => {
      write(path.join(root(), '.npmrc'), `registry=${A}\n`)
      write(home('.npmrc'), `registry=${B}\n`)
      expect(configFor(member()).registry).toBe(B)
    })

    it("the comment's example: a parent .npmrc beats the project .yarnrc", () => {
      write(path.join(root(), '.npmrc'), `registry=${A}\n`)
      write(path.join(member(), '.yarnrc'), `registry "${B}"\n`)
      expect(configFor(member()).registry).toBe(A)
    })
  })

  describe('layers (y20-y27)', () => {
    it('y20: a member token beats the root token', () => {
      write(path.join(root(), '.npmrc'), `${token('R')}@acme:registry=${B}\n`)
      write(path.join(member(), '.npmrc'), token('M'))
      expect(scoped(configFor(member()))).toEqual({
        server: BH,
        auth: 'Bearer M',
      })
    })

    it('y21: a ~/.npmrc token beats the root token', () => {
      write(path.join(root(), '.npmrc'), `${token('R')}@acme:registry=${B}\n`)
      write(home('.npmrc'), token('H'))
      expect(scoped(configFor(member())).auth).toBe('Bearer H')
    })

    it('y22: the root fills a token the member lacks', () => {
      write(path.join(root(), '.npmrc'), token('R'))
      write(path.join(member(), '.npmrc'), `@acme:registry=${B}\n`)
      expect(scoped(configFor(member()))).toEqual({
        server: BH,
        auth: 'Bearer R',
      })
    })

    it('y24: ~/.npmrc beats a parent .npmrc', () => {
      write(path.join(root(), '.npmrc'), `@acme:registry=${A}\n`)
      write(home('.npmrc'), `@acme:registry=${B}\n`)
      expect(scoped(configFor(member())).server).toBe(BH)
    })

    it('y25: a parent .npmrc supplies credentials', () => {
      write(
        path.join(root(), '.npmrc'),
        `@acme:registry=${A}\n${token('P', AH)}`,
      )
      expect(scoped(configFor(member()))).toEqual({
        server: AH,
        auth: 'Bearer P',
      })
    })

    it('reads parents nearest first, per key', () => {
      write(at('.npmrc'), `@acme:registry=${A}\nregistry=${A}\n`)
      write(path.join(root(), '.npmrc'), `registry=${B}\n`)
      const config = configFor(member())
      expect(config.registry).toBe(B)
      expect(scoped(config).server).toBe(AH)
    })

    it('y26: the prefix file ($PREFIX/etc/npmrc) beats a parent .npmrc', () => {
      write(path.join(root(), '.npmrc'), `@acme:registry=${A}\n`)
      write(prefixFile(), `@acme:registry=${B}\n`)
      expect(scoped(configFor(member(), { PREFIX: at('prefix') })).server).toBe(
        BH,
      )
    })

    it('y26: without PREFIX the prefix is the running node install', () => {
      write(prefixFile(), `@acme:registry=${B}\n`)
      expect(scoped(configFor(member())).server).toBe(BH)
    })

    it('y27: ~/.npmrc beats the prefix file, which beats nothing below it', () => {
      write(home('.npmrc'), `@acme:registry=${A}\n`)
      write(prefixFile(), `@acme:registry=${B}\n`)
      expect(scoped(configFor(root(), { PREFIX: at('prefix') })).server).toBe(
        AH,
      )
      fs.rmSync(home('.npmrc'))
      expect(scoped(configFor(root(), { PREFIX: at('prefix') })).server).toBe(
        BH,
      )
    })

    it('y27c: the cwd .npmrc beats the prefix file', () => {
      write(path.join(root(), '.npmrc'), `@acme:registry=${A}\n`)
      write(prefixFile(), `@acme:registry=${B}\n`)
      expect(scoped(configFor(root(), { PREFIX: at('prefix') })).server).toBe(
        AH,
      )
    })
  })

  describe('userconfig (y28)', () => {
    beforeEach(() => {
      write(home('.npmrc'), `@acme:registry=${A}\n`)
      write(home('alt.npmrc'), `@acme:registry=${B}\n`)
    })

    it('y28: npm_config_userconfig replaces ~/.npmrc', () => {
      const env = { npm_config_userconfig: home('alt.npmrc') }
      expect(scoped(configFor(root(), env)).server).toBe(BH)
    })

    it('y28d: NPM_CONFIG_USERCONFIG works too', () => {
      const env = { NPM_CONFIG_USERCONFIG: home('alt.npmrc') }
      expect(scoped(configFor(root(), env)).server).toBe(BH)
    })

    it('y28b: a relative path is cwd-relative', () => {
      write(path.join(member(), 'alt.npmrc'), `@acme:registry=${B}\n`)
      const env = { npm_config_userconfig: 'alt.npmrc' }
      expect(scoped(configFor(member(), env)).server).toBe(BH)
    })

    it('y28c: ~ is not expanded, and ~/.npmrc is not read once userconfig is set', () => {
      const env = { npm_config_userconfig: '~/alt.npmrc' }
      expect(scoped(configFor(root(), env)).server).toBe(NPMJS)
    })
  })

  describe('environment (y29-y31)', () => {
    it('y29: an npm_config_ credential is mangled, so none is read', () => {
      write(path.join(root(), '.npmrc'), `@acme:registry=${B}\n`)
      const env = { [`npm_config_//${BH}/:_authToken`]: 'E' }
      expect(scoped(configFor(root(), env))).toEqual({
        server: BH,
        auth: undefined,
      })
    })

    it('y30: an upper-case scope is lower-cased', () => {
      const env = { 'NPM_CONFIG_@ACME:REGISTRY': B }
      expect(scoped(configFor(root(), env)).server).toBe(BH)
    })

    it('y30b: an env scope beats the cwd .npmrc', () => {
      write(path.join(root(), '.npmrc'), `@acme:registry=${A}\n`)
      const env = { 'npm_config_@acme:registry': B }
      expect(scoped(configFor(root(), env)).server).toBe(BH)
    })

    it('y31: ${VAR} is expanded in a file value', () => {
      write(
        path.join(member(), '.npmrc'),
        `@acme:registry=${B}\n${token('${TOK}')}`,
      )
      expect(scoped(configFor(member(), { TOK: 'ENVTOK' })).auth).toBe(
        'Bearer ENVTOK',
      )
    })

    it('y31b: an env value is not expanded', () => {
      const env = { 'npm_config_@acme:registry': 'http://127.0.0.1:${PORT}/' }
      expect(
        registryFor('@acme/probe', configFor(root(), { ...env })),
      ).not.toBe(B)
      expect(
        mergeNpmrcLayers(
          yarnNpmrcLayers(root(), sourcesFor({ ...env, PORT: '4002' })),
        ).values['@acme:registry'],
      ).toBe('http://127.0.0.1:${PORT}/')
    })

    it('y32: an unset ${VAR} (yarn fails there) sends no credential', () => {
      write(
        path.join(member(), '.npmrc'),
        `@acme:registry=${B}\n${token('${TOK}')}`,
      )
      expect(scoped(configFor(member()))).toEqual({
        server: BH,
        auth: undefined,
      })
    })
  })

  describe('empty environment values (a1-a2c, 2026-10-27)', () => {
    it('a1: an empty NPM_CONFIG_REGISTRY hides the .npmrc registry', () => {
      write(path.join(root(), '.npmrc'), `registry=${B}\n`)
      for (const name of ['NPM_CONFIG_REGISTRY', 'npm_config_registry']) {
        const config = configFor(root(), { [name]: '' })
        expect(registryFor('left-pad', config)).not.toContain(BH)
      }
    })

    it('a1c: ... and the default falls to the .yarnrc registry', () => {
      write(path.join(root(), '.npmrc'), `registry=${B}\n`)
      write(path.join(root(), '.yarnrc'), `registry "${A}"\n`)
      const config = configFor(root(), { NPM_CONFIG_REGISTRY: '' })
      expect(registryFor('left-pad', config)).toBe(A)
    })

    it('a2: an empty scope variable unroutes the .npmrc scope', () => {
      write(path.join(root(), '.npmrc'), `@acme:registry=${B}\n`)
      const env = { 'npm_config_@acme:registry': '' }
      expect(scoped(configFor(root(), env)).server).toBe(NPMJS)
    })

    it('a2c: ... leaving a .yarnrc scope to route it', () => {
      write(path.join(root(), '.npmrc'), `@acme:registry=${B}\n`)
      write(path.join(root(), '.yarnrc'), `"@acme:registry" "${A}"\n`)
      const env = { 'npm_config_@acme:registry': '' }
      expect(scoped(configFor(root(), env)).server).toBe(AH)
    })
  })

  describe('variables in files (b1, c1-c4)', () => {
    const tokenKey = `//${BH}/:_authToken`
    const tokenValue = (env: NodeJS.ProcessEnv = {}) =>
      mergeNpmrcLayers(yarnNpmrcLayers(root(), sourcesFor(env))).values[
        tokenKey
      ]

    it('b1: a variable in a key is not expanded', () => {
      write(
        path.join(root(), '.npmrc'),
        '@acme:registry=' + B + '\n//${REG_HOST}/:_authToken=T\n',
      )
      expect(scoped(configFor(root(), { REG_HOST: BH }))).toEqual({
        server: BH,
        auth: undefined,
      })
    })

    it('c1: an escaped reference is kept as written, backslash included', () => {
      write(path.join(root(), '.npmrc'), `${tokenKey}=\\\${NOT_A_VAR}\n`)
      expect(tokenValue()).toBe('\\${NOT_A_VAR}')
      expect(tokenValue({ NOT_A_VAR: 'x' })).toBe('\\${NOT_A_VAR}')
    })

    it('c4: an escaped backslash leaves one, which then escapes the reference', () => {
      write(path.join(root(), '.npmrc'), `${tokenKey}=\\\\\${TOKEN}\n`)
      expect(tokenValue({ TOKEN: 'ENVTOK' })).toBe('\\${TOKEN}')
    })

    it('c2, c3: ${TOKEN?} names a variable called "TOKEN?", set or not: yarn throws, no credential is sent', () => {
      write(
        path.join(root(), '.npmrc'),
        `@acme:registry=${B}\n${tokenKey}=\${TOKEN?}\n`,
      )
      for (const env of [{ TOKEN: 'ENVTOK' }, {}]) {
        expect(scoped(configFor(root(), env))).toEqual({
          server: BH,
          auth: undefined,
        })
      }
    })
  })

  describe('the filesystem root', () => {
    it('does not read /.npmrc', () => {
      // The project's own root: on Windows the temp dir and the checkout can
      // sit on different drives.
      const rootFile = path.join(path.parse(root()).root, '.npmrc')
      const real = fs.readFileSync
      const spy = jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation(((
          file: fs.PathOrFileDescriptor,
          ...rest: unknown[]
        ) =>
          file === rootFile
            ? `registry=${B}\n`
            : (real as (...args: unknown[]) => unknown)(
                file,
                ...rest,
              )) as typeof fs.readFileSync)
      const config = configFor(member())
      expect(registryFor('left-pad', config)).toContain(NPMJS)
      expect(spy.mock.calls.some(([file]) => file === rootFile)).toBe(false)
    })
  })

  describe('berry', () => {
    it('decides berry or v1 once per load: registryConfig follows npmrcLayers', () => {
      const sources = sourcesFor()
      const route = (cwd: string) => {
        const layers = yarn.npmrcLayers?.(cwd, sources) ?? []
        const view = mergeNpmrcLayers(layers)
        const base = registryConfigFrom(view, cwd, sources)
        return yarn.registryConfig?.(cwd, base, sources, view)?.registry
      }
      write(path.join(root(), '.yarnrc'), `registry "${A}"\n`)
      expect(route(root())).toBe(A)
      write(path.join(root(), '.yarnrc.yml'), 'nodeLinker: node-modules\n')
      expect(route(root())).toBe('https://registry.npmjs.org/')
    })

    it('keeps npm layers', () => {
      write(path.join(root(), '.yarnrc.yml'), 'nodeLinker: node-modules\n')
      const sources = sourcesFor()
      const files = (layers: ReturnType<typeof npmNpmrcLayers>) =>
        layers.map((layer) => (layer.kind === 'file' ? layer.file : 'env'))
      const layers = yarn.npmrcLayers?.(root(), sources)
      expect(files(layers ?? [])).toEqual(
        files(npmNpmrcLayers(root(), sources)),
      )
    })
  })
})
