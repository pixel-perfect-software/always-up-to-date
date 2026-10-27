jest.mock('@/utils/logger')

import fs from 'fs'
import os from 'os'
import path from 'path'
import { pnpmConfigDir, pnpmNpmrcLayers } from '@/managers/pnpm/npmrc'
import type { RegistryConfig } from '@/types'
import {
  mergeNpmrcLayers,
  type NpmrcSources,
  registryConfigFrom,
} from '@/utils/npmrcLoader'
import {
  authorizationFor,
  credentialsFor,
  packumentUrl,
  registryFor,
} from '@/utils/registryRequest'

// Each decision below was probed on pnpm 12.15.0 and 12.14.0, 2026-10-26; the
// ids (p20, …) name the probe rows. The config directory off macOS is read
// from pnpm's source (v12.15.0, `getConfigDir`), not run.

const A = 'http://127.0.0.1:4001/'
const B = 'http://127.0.0.1:4002/'
const C = 'http://127.0.0.1:4003/'
const BH = '127.0.0.1:4002'
const NPMJS = 'registry.npmjs.org'

describe('pnpm .npmrc layers', () => {
  let tmp: string

  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const project = () => at('proj')
  const home = (...parts: string[]) => at('home', ...parts)
  /** pnpm's global directory with XDG_CONFIG_HOME set, as the probes ran. */
  const global = (...parts: string[]) => at('xdg', 'pnpm', ...parts)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  const sourcesFor = (
    env: NodeJS.ProcessEnv = {},
    platform: NodeJS.Platform = 'linux',
  ): NpmrcSources => ({
    env,
    home: home(),
    execPath: at('prefix', 'bin', 'node'),
    platform,
  })

  /** The config autd builds for pnpm from `cwd`; XDG_CONFIG_HOME is `<tmp>/xdg` unless given. */
  const configFor = ({
    env = {},
    platform,
    cwd = project(),
    xdg = at('xdg'),
  }: {
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    cwd?: string
    xdg?: string | null
  } = {}): RegistryConfig => {
    const sources = sourcesFor(
      xdg === null ? env : { XDG_CONFIG_HOME: xdg, ...env },
      platform,
    )
    const view = mergeNpmrcLayers(pnpmNpmrcLayers(cwd, sources))
    return registryConfigFrom(view.values, cwd, sources)
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
  const unscoped = (config: RegistryConfig) => sent(config, 'probe-unscoped')

  const token = (value: string, host = BH) => `//${host}/:_authToken=${value}\n`

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pnpm-')))
    write(path.join(project(), 'package.json'), '{}')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('#117 evidence', () => {
    it('row 1: pnpm_config_registry beats the project .npmrc', () => {
      write(at('proj', '.npmrc'), `registry=${A}\n`)
      const config = configFor({ env: { pnpm_config_registry: B } })
      expect(unscoped(config).server).toBe(BH)
    })

    it('row 2: npm_config_registry is not read', () => {
      write(at('proj', '.npmrc'), `registry=${A}\n`)
      const config = configFor({ env: { npm_config_registry: B } })
      expect(unscoped(config).server).toBe('127.0.0.1:4001')
    })

    it('row 3: the global config.yaml alone routes the registry', () => {
      write(global('config.yaml'), `registry: ${B}\n`)
      expect(unscoped(configFor()).server).toBe(BH)
    })

    it('row 4: the global config.yaml beats the project .npmrc', () => {
      write(at('proj', '.npmrc'), `registry=${A}\n`)
      write(global('config.yaml'), `registry: ${B}\n`)
      expect(unscoped(configFor()).server).toBe(BH)
    })

    it('row 5: the global auth.ini alone routes the registry', () => {
      write(global('auth.ini'), `registry=${B}\n`)
      expect(unscoped(configFor()).server).toBe(BH)
    })

    it('row 6: a project .npmrc registry holding ${PORT} is ignored, not expanded (p30)', () => {
      write(at('proj', '.npmrc'), 'registry=http://127.0.0.1:${PORT}/\n')
      expect(unscoped(configFor({ env: { PORT: '4002' } })).server).toBe(NPMJS)

      write(home('.npmrc'), `registry=${A}\n`)
      expect(unscoped(configFor({ env: { PORT: '4002' } })).server).toBe(
        '127.0.0.1:4001',
      )
    })

    it('row 7: a project .npmrc token holding ${…} sends no credential', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n${token('${PROBE_TOKEN}')}`)
      const config = configFor({ env: { PROBE_TOKEN: 'secret' } })
      expect(unscoped(config)).toEqual({ server: BH, auth: undefined })
    })

    it('row 8: ${PORT} is expanded in ~/.npmrc and in the global config.yaml', () => {
      write(home('.npmrc'), 'registry=http://127.0.0.1:${PORT}/\n')
      expect(unscoped(configFor({ env: { PORT: '4002' } })).server).toBe(BH)

      fs.rmSync(home('.npmrc'))
      write(global('config.yaml'), 'registry: http://127.0.0.1:${PORT}/\n')
      expect(unscoped(configFor({ env: { PORT: '4002' } })).server).toBe(BH)
    })
  })

  describe('env naming (p20-p26)', () => {
    beforeEach(() => write(at('proj', '.npmrc'), `registry=${A}\n`))
    const server = (env: NodeJS.ProcessEnv) =>
      unscoped(configFor({ env })).server

    it('p20: reads pnpm_config_<lower> and PNPM_CONFIG_<UPPER>, nothing mixed', () => {
      expect(server({ PNPM_CONFIG_REGISTRY: B })).toBe(BH)
      expect(server({ pnpm_config_registry: B })).toBe(BH)
      expect(server({ Pnpm_Config_Registry: B })).toBe('127.0.0.1:4001')
      expect(server({ pnpm_config_REGISTRY: B })).toBe('127.0.0.1:4001')
      expect(server({ PNPM_CONFIG_registry: B })).toBe('127.0.0.1:4001')
    })

    it('p21: a scope route is not read from the environment', () => {
      write(at('proj', '.npmrc'), `@acme:registry=${A}\n`)
      const config = configFor({
        env: {
          'pnpm_config_@acme:registry': B,
          'PNPM_CONFIG_@ACME:REGISTRY': C,
        },
      })
      expect(scoped(config).server).toBe('127.0.0.1:4001')
    })

    it('p22: a // credential is read from pnpm_config_*, as written, and beats the project token', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n${token('P')}`)
      const config = configFor({
        env: { [`pnpm_config_//${BH}/:_authToken`]: 'E' },
      })
      expect(unscoped(config)).toEqual({ server: BH, auth: 'Bearer E' })

      const upper = configFor({
        env: { [`PNPM_CONFIG_//${BH}/:_authToken`]: 'E' },
      })
      expect(unscoped(upper).auth).toBe('Bearer E')
    })

    it('p23: npm_config_* credentials are read, in either case, and rank below pnpm_config_*', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n${token('P')}`)
      const key = `//${BH}/:_authToken`
      expect(
        unscoped(configFor({ env: { [`npm_config_${key}`]: 'E' } })).auth,
      ).toBe('Bearer E')
      expect(
        unscoped(configFor({ env: { [`NPM_CONFIG_${key}`]: 'E' } })).auth,
      ).toBe('Bearer E')
      expect(
        unscoped(
          configFor({
            env: { [`npm_config_${key}`]: 'E', [`pnpm_config_${key}`]: 'F' },
          }),
        ).auth,
      ).toBe('Bearer F')
    })

    it('p23: npm_config_* credentials rank above auth.ini and ~/.npmrc', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n`)
      write(global('auth.ini'), token('G'))
      write(home('.npmrc'), token('U'))
      const config = configFor({
        env: { [`npm_config_//${BH}/:_authToken`]: 'E' },
      })
      expect(unscoped(config).auth).toBe('Bearer E')
    })

    it('p23: an npm_config_* credential is not expanded, so autd sends none for a ${…} value (pnpm sends it literally)', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n`)
      const config = configFor({
        env: { [`npm_config_//${BH}/:_authToken`]: '${TOK}', TOK: 'v' },
      })
      expect(unscoped(config).auth).toBeUndefined()
    })

    it('ra: userconfig is used raw, ${VAR} and ~ are not expanded, and the env layer does not carry it', () => {
      write(at('proj', '.npmrc'), '')
      write(home('alt.npmrc'), `registry=${B}\n`)
      const raw = (name: string) =>
        configFor({ env: { [name]: '${ALT_DIR}/alt.npmrc', ALT_DIR: home() } })
      expect(unscoped(raw('pnpm_config_userconfig')).server).toBe(NPMJS)
      expect(unscoped(raw('npm_config_userconfig')).server).toBe(NPMJS)

      const sources = sourcesFor({
        pnpm_config_userconfig: home('alt.npmrc'),
        npm_config_userconfig: home('alt.npmrc'),
      })
      const view = mergeNpmrcLayers(pnpmNpmrcLayers(project(), sources))
      expect(view.values.userconfig).toBeUndefined()
      expect(
        unscoped(registryConfigFrom(view.values, project(), sources)).server,
      ).toBe(BH)
    })

    it('rb: with both casings set, PNPM_CONFIG_* wins a key whatever the environment order', () => {
      const win = (env: NodeJS.ProcessEnv) =>
        unscoped(configFor({ env })).server
      expect(win({ pnpm_config_registry: A, PNPM_CONFIG_REGISTRY: B })).toBe(BH)
      expect(win({ PNPM_CONFIG_REGISTRY: B, pnpm_config_registry: A })).toBe(BH)
    })

    it('rb: two casings of one // credential tie, and the later in the environment wins, as in pnpm', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n`)
      const key = `//${BH}/:_authToken`
      const auth = (env: NodeJS.ProcessEnv) => unscoped(configFor({ env })).auth
      expect(
        auth({ [`pnpm_config_${key}`]: 'L', [`PNPM_CONFIG_${key}`]: 'U' }),
      ).toBe('Bearer U')
      expect(
        auth({ [`PNPM_CONFIG_${key}`]: 'U', [`pnpm_config_${key}`]: 'L' }),
      ).toBe('Bearer L')
      expect(
        auth({ [`npm_config_${key}`]: 'L', [`NPM_CONFIG_${key}`]: 'U' }),
      ).toBe('Bearer U')
      expect(
        auth({ [`NPM_CONFIG_${key}`]: 'U', [`npm_config_${key}`]: 'L' }),
      ).toBe('Bearer L')
    })

    it('rb: with both casings of userconfig set, the lower-case name wins whatever the environment order', () => {
      write(at('proj', '.npmrc'), '')
      write(home('a1.npmrc'), `registry=${A}\n`)
      write(home('a2.npmrc'), `registry=${B}\n`)
      const win = (lower: string, upper: string, upperFirst: boolean) => {
        const pair: [string, string][] = [
          [lower, home('a1.npmrc')],
          [upper, home('a2.npmrc')],
        ]
        const env = Object.fromEntries(upperFirst ? pair.reverse() : pair)
        return unscoped(configFor({ env })).server
      }
      for (const upperFirst of [false, true]) {
        expect(
          win('pnpm_config_userconfig', 'PNPM_CONFIG_USERCONFIG', upperFirst),
        ).toBe('127.0.0.1:4001')
        expect(
          win('npm_config_userconfig', 'NPM_CONFIG_USERCONFIG', upperFirst),
        ).toBe('127.0.0.1:4001')
      }
    })

    it('rc: a // credential is read under a prefix in any case, other keys only in the two exact cases', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n`)
      const key = `//${BH}/:_authToken`
      expect(
        unscoped(configFor({ env: { [`Npm_Config_${key}`]: 'T' } })).auth,
      ).toBe('Bearer T')
      expect(
        unscoped(configFor({ env: { [`Pnpm_Config_${key}`]: 'T' } })).auth,
      ).toBe('Bearer T')

      write(at('proj', '.npmrc'), `registry=${A}\n`)
      write(home('alt.npmrc'), `registry=${B}\n`)
      expect(
        unscoped(configFor({ env: { Pnpm_Config_registry: B } })).server,
      ).toBe('127.0.0.1:4001')
      write(at('proj', '.npmrc'), '')
      expect(
        unscoped(
          configFor({ env: { Npm_Config_userconfig: home('alt.npmrc') } }),
        ).server,
      ).toBe(NPMJS)
    })

    it('p23: no other npm_config_* key is read', () => {
      const config = configFor({
        env: {
          npm_config_registry: B,
          'npm_config_@acme:registry': C,
          npm_config_fetch_timeout: '5',
        },
      })
      expect(unscoped(config).server).toBe('127.0.0.1:4001')
      expect(config.scopedRegistries).toEqual({})
      expect(config.fetchTimeout).toBe(300_000)
    })

    it('p24: userconfig replaces ~/.npmrc: pnpm_config_ over npm_config_, cwd-relative, no ~ expansion, missing means none', () => {
      write(at('proj', '.npmrc'), '')
      write(home('.npmrc'), `registry=${A}\n`)
      write(home('npm.npmrc'), `registry=${B}\n`)
      write(home('pnpm.npmrc'), `registry=${C}\n`)
      const hosts = (env: NodeJS.ProcessEnv) =>
        unscoped(configFor({ env })).server

      expect(hosts({ npm_config_userconfig: home('npm.npmrc') })).toBe(BH)
      expect(hosts({ NPM_CONFIG_USERCONFIG: home('npm.npmrc') })).toBe(BH)
      expect(
        hosts({
          npm_config_userconfig: home('npm.npmrc'),
          pnpm_config_userconfig: home('pnpm.npmrc'),
        }),
      ).toBe('127.0.0.1:4003')
      // a relative path is against cwd
      write(at('proj', 'alt.npmrc'), `registry=${B}\n`)
      expect(hosts({ npm_config_userconfig: 'alt.npmrc' })).toBe(BH)
      // `~` is not expanded, and a missing file leaves no user layer
      expect(hosts({ npm_config_userconfig: '~/npm.npmrc' })).toBe(NPMJS)
      expect(hosts({ npm_config_userconfig: home('missing.npmrc') })).toBe(
        NPMJS,
      )
    })

    it('p24: the project .npmrc beats the userconfig file', () => {
      write(at('proj', '.npmrc'), `registry=${A}\n`)
      write(home('alt.npmrc'), `registry=${B}\n`)
      expect(
        unscoped(
          configFor({ env: { npm_config_userconfig: home('alt.npmrc') } }),
        ).server,
      ).toBe('127.0.0.1:4001')
    })

    it('p25: a multi-word key is snake_case in the environment; camelCase is not read', () => {
      expect(
        configFor({ env: { pnpm_config_fetch_timeout: '1111' } }).fetchTimeout,
      ).toBe(1111)
      expect(
        configFor({ env: { PNPM_CONFIG_FETCH_TIMEOUT: '3333' } }).fetchTimeout,
      ).toBe(3333)
      expect(
        configFor({ env: { pnpm_config_fetchTimeout: '2222' } }).fetchTimeout,
      ).toBe(300_000)
    })

    it('p26: env values expand ${VAR} and ${VAR:-default}', () => {
      expect(
        server({
          pnpm_config_registry: 'http://127.0.0.1:${PORT}/',
          PORT: '4002',
        }),
      ).toBe(BH)
      expect(
        server({ pnpm_config_registry: 'http://127.0.0.1:${UNSET:-4002}/' }),
      ).toBe(BH)
    })
  })

  describe('project files do not expand ${…} (p30-p33)', () => {
    it('p31: a token holding ${…} is left out and ~/.npmrc decides', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n${token('${TOK}')}`)
      write(home('.npmrc'), token('U'))
      expect(unscoped(configFor({ env: { TOK: 'ENVTOK' } }))).toEqual({
        server: BH,
        auth: 'Bearer U',
      })
      // an unset variable and a ${…} in the key behave the same
      write(at('proj', '.npmrc'), `registry=${B}\n${token('${UNSET}')}`)
      expect(unscoped(configFor()).auth).toBe('Bearer U')
      write(
        at('proj', '.npmrc'),
        `registry=${B}\n//127.0.0.1:\${BPORT}/:_authToken=K\n`,
      )
      expect(unscoped(configFor({ env: { BPORT: '4002' } })).auth).toBe(
        'Bearer U',
      )
    })

    it('p32: a scope route holding ${…} is left out and ~/.npmrc decides', () => {
      write(
        at('proj', '.npmrc'),
        `registry=${A}\n@acme:registry=http://127.0.0.1:\${PORT}/\n`,
      )
      write(home('.npmrc'), `@acme:registry=${B}\n`)
      const config = configFor({ env: { PORT: '4003' } })
      expect(scoped(config).server).toBe(BH)
      expect(unscoped(config).server).toBe('127.0.0.1:4001')
    })

    it('p33: a project pnpm-workspace.yaml value holding ${…} falls through to the global config.yaml', () => {
      write(
        at('proj', 'pnpm-workspace.yaml'),
        'registry: http://127.0.0.1:${PORT}/\n',
      )
      write(global('config.yaml'), `registry: ${B}\n`)
      expect(unscoped(configFor({ env: { PORT: '4001' } })).server).toBe(BH)
    })
  })

  describe('user and global files expand ${…} (p34-p36)', () => {
    it('p34: ${VAR:-default} applies in ~/.npmrc, auth.ini and config.yaml', () => {
      const route = 'http://127.0.0.1:${UNSET:-4002}/'
      write(home('.npmrc'), `registry=${route}\n`)
      expect(unscoped(configFor()).server).toBe(BH)
      fs.rmSync(home('.npmrc'))
      write(global('auth.ini'), `registry=${route}\n`)
      expect(unscoped(configFor()).server).toBe(BH)
      fs.rmSync(global('auth.ini'))
      write(global('config.yaml'), `registry: ${route}\n`)
      expect(unscoped(configFor()).server).toBe(BH)
    })

    it('p35: an unset ${VAR} becomes empty and shadows lower layers', () => {
      write(home('.npmrc'), `registry=${A}\n`)
      write(global('auth.ini'), 'registry=http://127.0.0.1:${UNSET}/\n')
      expect(registryFor('probe-unscoped', configFor())).toBe(
        'http://127.0.0.1:/',
      )

      fs.rmSync(global('auth.ini'))
      write(at('proj', '.npmrc'), `registry=${A}\n`)
      write(global('config.yaml'), 'registry: http://127.0.0.1:${UNSET}/\n')
      expect(registryFor('probe-unscoped', configFor())).toBe(
        'http://127.0.0.1:/',
      )
    })

    it('p35: an unset token variable shadows the lower token, and autd sends none (pnpm sends an empty Bearer)', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n`)
      write(home('.npmrc'), token('U'))
      write(global('auth.ini'), token('${UNSET}'))
      expect(unscoped(configFor()).auth).toBeUndefined()
    })

    it('p35: an emptied token falls back to a shorter same-host prefix, as npm does for an empty token, where pnpm sends an empty Bearer', () => {
      write(at('proj', '.npmrc'), `registry=http://${BH}/npm/\n${token('S')}`)
      write(global('auth.ini'), `//${BH}/npm/:_authToken=\${UNSET}\n`)
      expect(unscoped(configFor())).toEqual({ server: BH, auth: 'Bearer S' })
    })

    it('p36: a token expands in auth.ini and in ~/.npmrc, and a key does too', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n`)
      write(global('auth.ini'), token('${TOK}'))
      expect(unscoped(configFor({ env: { TOK: 'ENVTOK' } })).auth).toBe(
        'Bearer ENVTOK',
      )
      fs.rmSync(global('auth.ini'))
      write(home('.npmrc'), token('${TOK}'))
      expect(unscoped(configFor({ env: { TOK: 'ENVTOK' } })).auth).toBe(
        'Bearer ENVTOK',
      )
      fs.rmSync(home('.npmrc'))
      write(global('auth.ini'), '//127.0.0.1:${BPORT}/:_authToken=K\n')
      expect(unscoped(configFor({ env: { BPORT: '4002' } })).auth).toBe(
        'Bearer K',
      )
    })
  })

  describe('credentials by layer (p40-p45)', () => {
    beforeEach(() => write(at('proj', '.npmrc'), `registry=${B}\n`))

    it('p40: auth.ini carries credentials', () => {
      write(global('auth.ini'), token('G'))
      expect(unscoped(configFor()).auth).toBe('Bearer G')
    })

    it('p41: the project .npmrc beats auth.ini per key', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n${token('P')}`)
      write(global('auth.ini'), token('G'))
      expect(unscoped(configFor()).auth).toBe('Bearer P')
    })

    it('p42: auth.ini beats ~/.npmrc', () => {
      write(global('auth.ini'), token('G'))
      write(home('.npmrc'), token('U'))
      expect(unscoped(configFor()).auth).toBe('Bearer G')
    })

    it('p43: config.yaml carries no credentials', () => {
      write(global('config.yaml'), `"//${BH}/:_authToken": Y\n`)
      expect(unscoped(configFor())).toEqual({ server: BH, auth: undefined })
    })

    it('p44: a project-yaml route picks up a ~/.npmrc credential', () => {
      fs.rmSync(at('proj', '.npmrc'))
      write(at('proj', 'pnpm-workspace.yaml'), `registry: ${B}\n`)
      write(home('.npmrc'), token('U'))
      expect(unscoped(configFor())).toEqual({ server: BH, auth: 'Bearer U' })
    })

    it('p45: a global-yaml route picks up an auth.ini credential', () => {
      fs.rmSync(at('proj', '.npmrc'))
      write(global('config.yaml'), `registry: ${B}\n`)
      write(global('auth.ini'), token('G'))
      expect(unscoped(configFor())).toEqual({ server: BH, auth: 'Bearer G' })
    })

    it('puts the project pnpm-workspace.yaml above the global config.yaml and both above the project .npmrc, per key', () => {
      write(at('proj', '.npmrc'), `registry=${A}\n@acme:registry=${A}\n`)
      write(
        global('config.yaml'),
        `registry: ${C}\nregistries:\n  "@acme": ${C}\n`,
      )
      write(at('proj', 'pnpm-workspace.yaml'), `registry: ${B}\n`)
      const config = configFor()
      expect(unscoped(config).server).toBe(BH)
      expect(scoped(config).server).toBe('127.0.0.1:4003')
    })
  })

  describe('the global config directory (p50-p55)', () => {
    it('p50/p51: on macOS without XDG_CONFIG_HOME it is ~/Library/Preferences/pnpm', () => {
      write(
        home('Library', 'Preferences', 'pnpm', 'auth.ini'),
        `registry=${B}\n`,
      )
      expect(
        unscoped(configFor({ platform: 'darwin', xdg: null })).server,
      ).toBe(BH)

      fs.rmSync(home('Library'), { recursive: true })
      write(
        home('Library', 'Preferences', 'pnpm', 'config.yaml'),
        `registry: ${B}\n`,
      )
      expect(
        unscoped(configFor({ platform: 'darwin', xdg: null })).server,
      ).toBe(BH)
    })

    it('p52: ~/.config/pnpm is not read on macOS', () => {
      write(home('.config', 'pnpm', 'auth.ini'), `registry=${B}\n`)
      expect(
        unscoped(configFor({ platform: 'darwin', xdg: null })).server,
      ).toBe(NPMJS)
    })

    it('p53: a relative XDG_CONFIG_HOME is used against cwd, not HOME, with no macOS fallback', () => {
      write(at('proj', 'relcfg', 'pnpm', 'auth.ini'), `registry=${B}\n`)
      const config = (platform: NodeJS.Platform) =>
        configFor({ platform, xdg: 'relcfg' })
      expect(unscoped(config('darwin')).server).toBe(BH)

      fs.rmSync(at('proj', 'relcfg'), { recursive: true })
      write(home('relcfg', 'pnpm', 'auth.ini'), `registry=${B}\n`)
      write(
        home('Library', 'Preferences', 'pnpm', 'auth.ini'),
        `registry=${B}\n`,
      )
      expect(unscoped(config('darwin')).server).toBe(NPMJS)
    })

    it('p54: the legacy rc file is not read', () => {
      write(global('rc'), `registry=${B}\n`)
      expect(unscoped(configFor()).server).toBe(NPMJS)
    })

    it("p55: npm's <prefix>/etc/npmrc is not read", () => {
      write(home('prefix', 'etc', 'npmrc'), `registry=${B}\n`)
      expect(
        unscoped(configFor({ env: { PREFIX: home('prefix') } })).server,
      ).toBe(NPMJS)
    })

    describe('pnpmConfigDir', () => {
      const dirFor = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) =>
        pnpmConfigDir(project(), sourcesFor(env, platform))

      it('darwin without XDG: ~/Library/Preferences/pnpm', () => {
        expect(dirFor('darwin')).toBe(home('Library', 'Preferences', 'pnpm'))
      })

      it('linux without XDG: ~/.config/pnpm (source-read, pnpm v12.15.0 getConfigDir)', () => {
        expect(dirFor('linux')).toBe(home('.config', 'pnpm'))
      })

      it('win32 with LOCALAPPDATA: %LOCALAPPDATA%\\pnpm\\config (source-read, pnpm v12.15.0 getConfigDir)', () => {
        expect(dirFor('win32', { LOCALAPPDATA: at('local') })).toBe(
          path.join(at('local'), 'pnpm', 'config'),
        )
      })

      it('win32 without LOCALAPPDATA: ~/.config/pnpm (source-read, pnpm v12.15.0 getConfigDir)', () => {
        expect(dirFor('win32')).toBe(home('.config', 'pnpm'))
      })

      it('XDG_CONFIG_HOME wins on every platform, a relative one against cwd', () => {
        for (const platform of ['darwin', 'linux', 'win32'] as const) {
          expect(dirFor(platform, { XDG_CONFIG_HOME: at('x') })).toBe(
            at('x', 'pnpm'),
          )
          expect(dirFor(platform, { XDG_CONFIG_HOME: 'rel' })).toBe(
            path.join(project(), 'rel', 'pnpm'),
          )
        }
      })

      it('an empty XDG_CONFIG_HOME counts as unset', () => {
        expect(dirFor('linux', { XDG_CONFIG_HOME: '' })).toBe(
          home('.config', 'pnpm'),
        )
      })
    })
  })

  describe('from a workspace member', () => {
    const member = () => at('ws', 'packages', 'app')

    beforeEach(() => {
      write(
        at('ws', 'pnpm-workspace.yaml'),
        `packages:\n  - packages/*\nregistries:\n  "@acme": ${B}\n`,
      )
      write(at('ws', '.npmrc'), `registry=${A}\n`)
      write(path.join(member(), 'package.json'), '{}')
    })

    it("reads the workspace root's yaml and .npmrc and ignores the member's .npmrc", () => {
      write(
        path.join(member(), '.npmrc'),
        `registry=${C}\n@acme:registry=${C}\n`,
      )
      const config = configFor({ cwd: member() })
      expect(unscoped(config).server).toBe('127.0.0.1:4001')
      expect(scoped(config).server).toBe(BH)
    })

    it('treats a member with its own pnpm-workspace.yaml as its own root', () => {
      write(path.join(member(), 'pnpm-workspace.yaml'), `registry: ${C}\n`)
      const config = configFor({ cwd: member() })
      expect(unscoped(config).server).toBe('127.0.0.1:4003')
      expect(scoped(config).server).toBe('127.0.0.1:4003')
    })
  })
})
