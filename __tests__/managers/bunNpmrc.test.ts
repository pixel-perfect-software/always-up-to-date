jest.mock('@/utils/logger')

import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import type { RegistryConfig } from '@/types'
import { managerRegistryConfig, type NpmrcSources } from '@/utils/npmrcLoader'
import {
  authorizationFor,
  credentialsFor,
  packumentUrl,
  registryFor,
} from '@/utils/registryRequest'

// Each decision below was probed on bun 1.4.4 (the latest), 2026-10-26; the
// ids (b20, …) name the probe rows.

const A = 'http://127.0.0.1:4001/'
const B = 'http://127.0.0.1:4002/'
const AH = '127.0.0.1:4001'
const BH = '127.0.0.1:4002'
const NPMJS = 'registry.npmjs.org'

describe('bun .npmrc layers', () => {
  let tmp: string

  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const project = () => at('proj')
  const home = (...parts: string[]) => at('home', ...parts)
  /** `$XDG_CONFIG_HOME/.npmrc`, with XDG_CONFIG_HOME = `<home>/.config` as the probes ran. */
  const xdgFile = () => home('.config', '.npmrc')
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  const sourcesFor = (env: NodeJS.ProcessEnv): NpmrcSources => ({
    env,
    home: home(),
    execPath: at('prefix', 'bin', 'node'),
    platform: 'linux',
  })

  /** The config autd builds for bun from `cwd`; XDG_CONFIG_HOME is `<home>/.config` unless given. */
  const configFor = ({
    env = {},
    cwd = project(),
    xdg = home('.config'),
  }: {
    env?: NodeJS.ProcessEnv
    cwd?: string
    xdg?: string | null
  } = {}): RegistryConfig =>
    managerRegistryConfig(
      bun,
      cwd,
      sourcesFor(xdg === null ? env : { XDG_CONFIG_HOME: xdg, ...env }),
    )

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
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autd-bun-')))
    write(path.join(project(), 'package.json'), '{}')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('#118 evidence', () => {
    it('row 1: registry only in $XDG_CONFIG_HOME/.npmrc routes there', () => {
      write(xdgFile(), `registry=${A}\n`)
      expect(unscoped(configFor()).server).toBe(AH)
    })

    it('row 2: registry only in ~/.npmrc routes there when no XDG file exists', () => {
      write(home('.npmrc'), `registry=${A}\n`)
      expect(unscoped(configFor()).server).toBe(AH)
    })

    it('row 3: $XDG/.npmrc beats ~/.npmrc', () => {
      write(xdgFile(), `registry=${A}\n`)
      write(home('.npmrc'), `registry=${B}\n`)
      expect(unscoped(configFor()).server).toBe(AH)
    })

    it('row 4: ~/.npmrc is not read at all while $XDG/.npmrc exists', () => {
      write(xdgFile(), `registry=${A}\n`)
      write(home('.npmrc'), `@acme:registry=${B}\n`)
      const config = configFor()
      expect(scoped(config).server).toBe(AH)
      expect(unscoped(config).server).toBe(AH)
    })

    it('row 5: the project .npmrc beats ~/.npmrc per key', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n`)
      write(home('.npmrc'), `@acme:registry=${A}\n`)
      const config = configFor()
      expect(scoped(config).server).toBe(AH)
      expect(unscoped(config).server).toBe(BH)
    })
  })

  describe('the user file (b20-b25)', () => {
    beforeEach(() => write(at('proj', '.npmrc'), `registry=${B}\n`))

    it('b20: an empty $XDG/.npmrc still hides ~/.npmrc', () => {
      rmProject()
      write(xdgFile(), '')
      write(home('.npmrc'), `registry=${A}\n`)
      expect(unscoped(configFor()).server).toBe(NPMJS)
    })

    it('b20b: so does a directory at that path', () => {
      rmProject()
      write(path.join(xdgFile(), 'keep'), '')
      write(home('.npmrc'), `registry=${A}\n`)
      expect(unscoped(configFor()).server).toBe(NPMJS)
    })

    it('b21: a relative XDG_CONFIG_HOME is not used', () => {
      rmProject()
      write(at('proj', 'relcfg', '.npmrc'), `registry=${B}\n`)
      write(home('.npmrc'), `registry=${A}\n`)
      expect(unscoped(configFor({ xdg: 'relcfg' })).server).toBe(AH)
    })

    it('b21: an unset XDG_CONFIG_HOME reads ~/.npmrc, never ~/.config/.npmrc', () => {
      rmProject()
      write(home('.config', '.npmrc'), `registry=${B}\n`)
      write(home('.npmrc'), `registry=${A}\n`)
      expect(unscoped(configFor({ xdg: null })).server).toBe(AH)
    })

    it('b22: NPM_CONFIG_USERCONFIG names the user file and replaces both defaults', () => {
      rmProject()
      write(home('alt.npmrc'), `@acme:registry=${B}\n`)
      write(xdgFile(), `registry=${A}\n`)
      write(home('.npmrc'), `registry=${A}\n`)
      const config = configFor({
        env: { NPM_CONFIG_USERCONFIG: home('alt.npmrc') },
      })
      expect(scoped(config).server).toBe(BH)
      expect(unscoped(config).server).toBe(NPMJS)
    })

    it('b22b: npm_config_userconfig is honored too, and the upper-case name wins (b22k)', () => {
      rmProject()
      write(home('upper.npmrc'), `registry=${B}\n`)
      write(home('lower.npmrc'), `registry=${A}\n`)
      expect(
        unscoped(
          configFor({ env: { npm_config_userconfig: home('lower.npmrc') } }),
        ).server,
      ).toBe(AH)
      expect(
        unscoped(
          configFor({
            env: {
              NPM_CONFIG_USERCONFIG: home('upper.npmrc'),
              npm_config_userconfig: home('lower.npmrc'),
            },
          }),
        ).server,
      ).toBe(BH)
    })

    it('b22e: the project .npmrc beats the userconfig file', () => {
      write(home('alt.npmrc'), `registry=${A}\n`)
      const config = configFor({
        env: { NPM_CONFIG_USERCONFIG: home('alt.npmrc') },
      })
      expect(unscoped(config).server).toBe(BH)
    })

    it('b22f: a missing userconfig file leaves no user layer, with no fallback', () => {
      rmProject()
      write(home('.npmrc'), `registry=${A}\n`)
      const config = configFor({
        env: { NPM_CONFIG_USERCONFIG: home('missing.npmrc') },
      })
      expect(unscoped(config).server).toBe(NPMJS)
    })

    it('b22i/b22l: a relative userconfig is cwd-relative, and ~/ is expanded', () => {
      rmProject()
      write(at('proj', 'alt.npmrc'), `registry=${A}\n`)
      expect(
        unscoped(configFor({ env: { NPM_CONFIG_USERCONFIG: 'alt.npmrc' } }))
          .server,
      ).toBe(AH)

      write(home('tilde.npmrc'), `registry=${B}\n`)
      expect(
        unscoped(configFor({ env: { NPM_CONFIG_USERCONFIG: '~/tilde.npmrc' } }))
          .server,
      ).toBe(BH)
    })

    it('b22j/b23: credentials come from the userconfig and the XDG file', () => {
      write(home('alt.npmrc'), token('UC'))
      expect(
        unscoped(
          configFor({ env: { NPM_CONFIG_USERCONFIG: home('alt.npmrc') } }),
        ),
      ).toEqual({ server: BH, auth: 'Bearer UC' })

      write(xdgFile(), token('X'))
      expect(unscoped(configFor())).toEqual({ server: BH, auth: 'Bearer X' })
    })

    it('b24: ~/.npmrc credentials are not read while $XDG/.npmrc exists', () => {
      write(xdgFile(), token('X'))
      write(home('.npmrc'), token('Y'))
      expect(unscoped(configFor()).auth).toBe('Bearer X')
    })

    it('b25: a project token beats the user file per key', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n${token('P')}`)
      write(xdgFile(), token('X'))
      expect(unscoped(configFor()).auth).toBe('Bearer P')
    })

    const rmProject = () => fs.rmSync(at('proj', '.npmrc'), { force: true })
  })

  describe('the environment (b26-b29)', () => {
    it('b26: npm_config_@scope:registry is not read, in either case', () => {
      write(at('proj', '.npmrc'), `@acme:registry=${A}\n`)
      const config = configFor({
        env: {
          'npm_config_@acme:registry': B,
          'NPM_CONFIG_@ACME:REGISTRY': B,
        },
      })
      expect(scoped(config).server).toBe(AH)
    })

    it('b27: npm_config_//host/:_authToken is not read', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n`)
      const config = configFor({
        env: { [`npm_config_//${BH}/:_authToken`]: 'E' },
      })
      expect(unscoped(config)).toEqual({ server: BH, auth: undefined })
    })

    it('b28: NPM_CONFIG_TOKEN beats an .npmrc token on an .npmrc route', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n${token('T2')}`)
      const config = configFor({ env: { NPM_CONFIG_TOKEN: 'E' } })
      expect(unscoped(config)).toEqual({ server: BH, auth: 'Bearer E' })
      expect(scoped(config)).toEqual({ server: BH, auth: 'Bearer E' })
    })

    it('b29: BUN_CONFIG_TOKEN beats an .npmrc token, and applies with none', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n${token('T2')}`)
      expect(unscoped(configFor({ env: { BUN_CONFIG_TOKEN: 'E' } })).auth).toBe(
        'Bearer E',
      )

      write(at('proj', '.npmrc'), `registry=${B}\n`)
      expect(unscoped(configFor({ env: { BUN_CONFIG_TOKEN: 'E' } })).auth).toBe(
        'Bearer E',
      )
    })

    it('BUN_CONFIG_REGISTRY and npm_config_registry still beat .npmrc', () => {
      write(at('proj', '.npmrc'), `registry=${A}\n`)
      expect(
        unscoped(configFor({ env: { BUN_CONFIG_REGISTRY: B } })).server,
      ).toBe(BH)
      expect(
        unscoped(configFor({ env: { npm_config_registry: B } })).server,
      ).toBe(BH)
    })
  })

  describe('variables (b30, b31)', () => {
    it('b30: ${VAR} expands anywhere, $VAR only as the whole value', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n//${BH}/:_authToken=$TOK\n`)
      expect(unscoped(configFor({ env: { TOK: 'ENVTOK' } })).auth).toBe(
        'Bearer ENVTOK',
      )

      write(
        at('proj', '.npmrc'),
        `registry=${B}\n//${BH}/:_authToken=pre\${TOK}\n`,
      )
      expect(unscoped(configFor({ env: { TOK: 'ENVTOK' } })).auth).toBe(
        'Bearer preENVTOK',
      )

      write(
        at('proj', '.npmrc'),
        `registry=${B}\n//${BH}/:_authToken=pre$TOK\n`,
      )
      expect(unscoped(configFor({ env: { TOK: 'ENVTOK' } })).auth).toBe(
        'Bearer pre$TOK',
      )
    })

    it('b30d/b30e/b30f: a whole-value $URL expands in routes and in the user file', () => {
      write(at('proj', '.npmrc'), 'registry=$URL\n')
      expect(unscoped(configFor({ env: { URL: B } })).server).toBe(BH)

      write(at('proj', '.npmrc'), '@acme:registry=$URL\n')
      expect(scoped(configFor({ env: { URL: B } })).server).toBe(BH)

      write(at('proj', '.npmrc'), `registry=${B}\n`)
      write(xdgFile(), `//${BH}/:_authToken=$TOK\n`)
      expect(unscoped(configFor({ env: { TOK: 'ENVTOK' } })).auth).toBe(
        'Bearer ENVTOK',
      )
    })

    it('b30b: an embedded $PORT in a URL is not expanded, so the route is not a registry', () => {
      write(at('proj', '.npmrc'), 'registry=http://127.0.0.1:$PORT/\n')
      expect(unscoped(configFor({ env: { PORT: '4002' } })).server).toBe(NPMJS)
    })

    it('b31: an unset ${VAR} token stays literal and, by autd rule, is no credential', () => {
      write(
        at('proj', '.npmrc'),
        `registry=${B}\n//${BH}/:_authToken=\${UNSET}\n`,
      )
      expect(unscoped(configFor())).toEqual({ server: BH, auth: undefined })
    })

    it('b31b: that literal shadows the user file token; autd sends none rather than the literal', () => {
      write(
        at('proj', '.npmrc'),
        `registry=${B}\n//${BH}/:_authToken=\${UNSET}\n`,
      )
      write(xdgFile(), token('X'))
      expect(unscoped(configFor())).toEqual({ server: BH, auth: undefined })
    })

    it('b31c: an unset $VAR token stays literal and is sent as written', () => {
      write(at('proj', '.npmrc'), `registry=${B}\n//${BH}/:_authToken=$UNSET\n`)
      expect(unscoped(configFor()).auth).toBe('Bearer $UNSET')
    })
  })

  describe('review fixes', () => {
    const authFor = (
      value: string,
      env: NodeJS.ProcessEnv = { TOK: 'VAL' },
    ) => {
      write(
        at('proj', '.npmrc'),
        `registry=${B}\n//${BH}/:_authToken=${value}\n`,
      )
      return unscoped(configFor({ env })).auth
    }

    it('${VAR?} is the value when set and empty (no auth) when unset', () => {
      expect(authFor('${TOK?}')).toBe('Bearer VAL')
      write(xdgFile(), token('X'))
      expect(authFor('${TOK?}', {})).toBeUndefined()
    })

    it('a dangling symlink at $XDG/.npmrc is not an entry: ~/.npmrc is read', () => {
      write(home('.npmrc'), `registry=${A}\n`)
      fs.mkdirSync(path.dirname(xdgFile()), { recursive: true })
      try {
        fs.symlinkSync(at('nowhere'), xdgFile())
      } catch {
        return // symlinks need privileges on some Windows setups
      }
      expect(unscoped(configFor()).server).toBe(AH)
    })

    it('variables in keys are not expanded', () => {
      write(
        at('proj', '.npmrc'),
        `registry=${B}\n//127.0.0.1:\${P}/:_authToken=KT\n`,
      )
      expect(unscoped(configFor({ env: { P: '4002' } })).auth).toBeUndefined()
      write(at('proj', '.npmrc'), `\${RK}=${A}\n$RK=${A}\nregistry=${B}\n`)
      expect(unscoped(configFor({ env: { RK: 'registry' } })).server).toBe(BH)
    })

    it('backslashes before $ follow npm: odd escapes, even halves (rev r4)', () => {
      expect(authFor('\\${TOK}')).toBeUndefined() // literal ${TOK}: absent
      expect(authFor('\\\\${TOK}')).toBe('Bearer \\VAL')
      expect(authFor('\\\\\\${TOK}')).toBeUndefined() // \${TOK}
      expect(authFor('\\\\\\\\${TOK}')).toBe('Bearer \\\\VAL')
      expect(authFor('\\$TOK')).toBe('Bearer VAL')
      expect(authFor('a\\$TOK')).toBe('Bearer a$TOK')
      expect(authFor('\\\\$TOK')).toBe('Bearer \\$TOK')
      expect(authFor('x${TOK}\\${TOK}')).toBeUndefined()
    })

    it("saveStyle reads save-exact through bun's layers", () => {
      write(home('.npmrc'), 'save-exact=true\n')
      const prev = process.env.HOME
      process.env.HOME = home()
      try {
        expect(bun.saveStyle(project()).exact).toBe(true)
        write(xdgFile(), '')
        process.env.XDG_CONFIG_HOME = home('.config')
        expect(bun.saveStyle(project()).exact).toBe(false)
      } finally {
        process.env.HOME = prev
        delete process.env.XDG_CONFIG_HOME
      }
    })
  })

  describe('what bun does not read (b32, b33)', () => {
    it("b32: <prefix>/etc/npmrc and npm's builtin npmrc are not read", () => {
      write(at('prefix', 'etc', 'npmrc'), `registry=${A}\n`)
      write(
        at('prefix', 'lib', 'node_modules', 'npm', 'npmrc'),
        `registry=${A}\n`,
      )
      expect(
        unscoped(configFor({ env: { PREFIX: at('prefix') } })).server,
      ).toBe(NPMJS)
    })

    it("b33: a parent directory's .npmrc is not read", () => {
      write(at('proj', '.npmrc'), `registry=${A}\n`)
      write(at('proj', 'sub', 'package.json'), '{}')
      expect(unscoped(configFor({ cwd: at('proj', 'sub') })).server).toBe(NPMJS)
    })
  })

  describe('from a workspace member', () => {
    const member = () => at('ws', 'packages', 'app')

    beforeEach(() => {
      write(
        at('ws', 'package.json'),
        JSON.stringify({ workspaces: ['packages/*'] }),
      )
      write(path.join(member(), 'package.json'), '{}')
    })

    it("reads the workspace root's .npmrc and ignores the member's", () => {
      write(at('ws', '.npmrc'), `registry=${B}\n`)
      write(path.join(member(), '.npmrc'), `registry=${A}\n`)
      expect(unscoped(configFor({ cwd: member() })).server).toBe(BH)
    })
  })

  describe('end to end', () => {
    it('bunfig.toml routes and registry variables still beat .npmrc and the user file', () => {
      write(at('proj', '.npmrc'), `registry=${A}\n`)
      write(xdgFile(), `registry=${A}\n`)
      write(
        at('proj', 'bunfig.toml'),
        `[install]\nregistry = { url = "${B}", token = "T1" }\n`,
      )
      expect(unscoped(configFor())).toEqual({ server: BH, auth: 'Bearer T1' })
      expect(
        unscoped(configFor({ env: { BUN_CONFIG_REGISTRY: A } })).server,
      ).toBe(AH)
    })
  })
})
