jest.mock('@/utils/logger')

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  bunfigExact,
  bunRegistryConfig,
  parseBunfigRegistries,
} from '@/managers/bun/bunfig'
import type { RegistryConfig } from '@/types'
import logger from '@/utils/logger'
import type { NpmrcSources } from '@/utils/npmrcLoader'
import { authorizationFor } from '@/utils/registryRequest'

const A = 'http://127.0.0.1:4001/'
const B = 'http://127.0.0.1:4002/'

describe('parseBunfigRegistries', () => {
  it('reads a string registry', () => {
    expect(parseBunfigRegistries(`[install]\nregistry = "${B}"\n`, {})).toEqual(
      {
        registry: { url: B },
        scopes: {},
      },
    )
  })

  it('reads an inline table with a token, and a literal string', () => {
    const toml = `[install]\nregistry = { url = '${B}', token = "T1" } # main\n`
    expect(parseBunfigRegistries(toml, {}).registry).toEqual({
      url: B,
      credentials: { authToken: 'T1' },
    })
  })

  it('turns URL userinfo into Basic credentials, percent-decoded, and strips it', () => {
    const toml = '[install]\nregistry = "http://user:pa%3Ass@127.0.0.1:4002/"\n'
    expect(parseBunfigRegistries(toml, {}).registry).toEqual({
      url: B,
      credentials: {
        username: 'user',
        password: Buffer.from('pa:ss').toString('base64'),
      },
    })
  })

  it('reads scopes written with or without @, as strings and tables', () => {
    const toml = [
      '[install.scopes]',
      `acme = "${A}"`,
      `"@corp" = { url = "${B}", token = "T3" }`,
      `"@basic" = { url = "${B}", username = "u", password = "p" }`,
      '',
    ].join('\r\n')
    expect(parseBunfigRegistries(toml, {}).scopes).toEqual({
      '@acme': { url: A },
      '@corp': { url: B, credentials: { authToken: 'T3' } },
      '@basic': {
        url: B,
        credentials: {
          username: 'u',
          password: Buffer.from('p').toString('base64'),
        },
      },
    })
  })

  it('reads [install.scopes.<name>] subtables as the inline-table form', () => {
    const toml = [
      '[install.scopes.acme]',
      `url = "${A}"`,
      'token = "T4" # note',
      '[install.scopes."@corp"]',
      `url = "${B}"`,
      'username = "u"',
      'password = "p"',
      '',
    ].join('\n')
    expect(parseBunfigRegistries(toml, {}).scopes).toEqual({
      '@acme': { url: A, credentials: { authToken: 'T4' } },
      '@corp': {
        url: B,
        credentials: {
          username: 'u',
          password: Buffer.from('p').toString('base64'),
        },
      },
    })
  })

  it('sends username-only userinfo as Basic with an empty password, as bun does', () => {
    const toml = '[install]\nregistry = "http://TOKEN@127.0.0.1:4002/"\n'
    const route = parseBunfigRegistries(toml, {}).registry
    expect(route?.url).toBe(B)
    expect(authorizationFor(route?.credentials)).toBe(
      `Basic ${Buffer.from('TOKEN:').toString('base64')}`,
    )
  })

  it('expands $NAME in username and password like a token', () => {
    const toml = `[install.scopes]\n"@a" = { url = "${A}", username = "$U", password = "$P" }\n`
    expect(
      parseBunfigRegistries(toml, { U: 'eu', P: 'ep' }).scopes['@a'],
    ).toEqual({
      url: A,
      credentials: {
        username: 'eu',
        password: Buffer.from('ep').toString('base64'),
      },
    })
    expect(parseBunfigRegistries(toml, { U: 'eu' }).scopes['@a']).toEqual({
      url: A,
    })
    const braces = `[install.scopes]\n"@a" = { url = "${A}", username = "u", password = "\${P}" }\n`
    expect(parseBunfigRegistries(braces, { P: 'x' }).scopes['@a']).toEqual({
      url: A,
    })
  })

  it('ends a string at a quote that follows an escaped backslash', () => {
    const afterComment = `[install]\nregistry = { url = "${B}", token = "a\\\\" } # note\n`
    expect(
      parseBunfigRegistries(afterComment, {}).registry?.credentials,
    ).toEqual({ authToken: 'a\\' })
    const beforeComma = `[install]\nregistry = { token = "a\\\\", url = "${B}" }\n`
    expect(parseBunfigRegistries(beforeComma, {}).registry).toEqual({
      url: B,
      credentials: { authToken: 'a\\' },
    })
  })

  it('reads only [install] and [install.scopes]', () => {
    const toml = `[run]\nregistry = "${A}"\n[install.cache]\nregistry = "${A}"\n[install]\nexact = true\n`
    expect(parseBunfigRegistries(toml, {})).toEqual({ scopes: {} })
  })

  it('expands $NAME in a token, scope tables included', () => {
    const toml = `[install]\nregistry = { url = "${B}", token = "$TOK" }\n[install.scopes]\n"@a" = { url = "${A}", token = "$TOK" }\n`
    const parsed = parseBunfigRegistries(toml, { TOK: 'secret' })
    expect(parsed.registry?.credentials).toEqual({ authToken: 'secret' })
    expect(parsed.scopes['@a'].credentials).toEqual({ authToken: 'secret' })
  })

  it('drops a token with an unset $NAME or a ${NAME}, keeping the route', () => {
    const unset = `[install]\nregistry = { url = "${B}", token = "$TOK" }\n`
    expect(parseBunfigRegistries(unset, {}).registry).toEqual({ url: B })
    const braces = `[install]\nregistry = { url = "${B}", token = "\${TOK}" }\n`
    expect(parseBunfigRegistries(braces, { TOK: 'x' }).registry).toEqual({
      url: B,
    })
  })

  it('ignores a registry URL holding a variable or not http(s)', () => {
    expect(
      parseBunfigRegistries('[install]\nregistry = "http://h:$PORT/"\n', {
        PORT: '1',
      }),
    ).toEqual({ scopes: {} })
    expect(
      parseBunfigRegistries('[install]\nregistry = "ftp://h/"\n', {}),
    ).toEqual({ scopes: {} })
  })
})

describe('bunfigExact', () => {
  it('reads exact = true in [install] only', () => {
    expect(bunfigExact('[install]\nexact = true\n')).toBe(true)
    expect(bunfigExact('[run]\nexact = true\n')).toBe(false)
    expect(bunfigExact('[install]\nexact = false\n')).toBe(false)
  })

  it('reads exact = true with a comment on a CRLF line', () => {
    expect(bunfigExact('[install]\r\nexact = true # pin\r\n')).toBe(true)
  })
})

describe('bunRegistryConfig', () => {
  let tmp: string
  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const sourcesFor = (env: NodeJS.ProcessEnv = {}): NpmrcSources => ({
    env,
    home: at('home'),
    execPath: process.execPath,
    platform: process.platform,
  })
  const base = (overrides: Partial<RegistryConfig> = {}): RegistryConfig => ({
    registry: 'https://registry.npmjs.org/',
    scopedRegistries: {},
    credentials: {},
    strictSSL: true,
    proxy: {},
    fetchRetries: 2,
    fetchTimeout: 300_000,
    maxSockets: 15,
    ...overrides,
  })
  const projectBunfig = (text: string) => write(at('proj', 'bunfig.toml'), text)

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-bunfig-')),
    )
    fs.mkdirSync(at('proj'), { recursive: true })
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('returns the .npmrc view when nothing sets a route', () => {
    expect(bunRegistryConfig(at('proj'), base(), sourcesFor())).toEqual(base())
  })

  it('puts a scope in bunfig over the same scope in .npmrc', () => {
    projectBunfig(`[install.scopes]\nacme = "${B}"\n`)
    const config = bunRegistryConfig(
      at('proj'),
      base({ scopedRegistries: { '@acme': A, '@keep': A } }),
      sourcesFor(),
    )
    expect(config.scopedRegistries).toEqual({ '@acme': B, '@keep': A })
  })

  it('puts the bunfig registry over .npmrc', () => {
    projectBunfig(`[install]\nregistry = "${B}"\n`)
    expect(
      bunRegistryConfig(at('proj'), base({ registry: A }), sourcesFor())
        .registry,
    ).toBe(B)
  })

  it('merges the global and project bunfig key by key, the project winning', () => {
    write(
      at('home', '.bunfig.toml'),
      `[install]\nregistry = "${A}"\n[install.scopes]\n"@g" = "${A}"\n"@both" = "${A}"\n`,
    )
    projectBunfig(`[install.scopes]\n"@both" = "${B}"\n"@p" = "${B}"\n`)
    const config = bunRegistryConfig(at('proj'), base(), sourcesFor())
    expect(config.registry).toBe(A)
    expect(config.scopedRegistries).toEqual({
      '@g': A,
      '@both': B,
      '@p': B,
    })
  })

  it('reads the global bunfig from an absolute XDG_CONFIG_HOME, else $HOME only', () => {
    write(at('xdg', '.bunfig.toml'), `[install]\nregistry = "${B}"\n`)
    write(at('home', '.bunfig.toml'), `[install]\nregistry = "${A}"\n`)
    write(
      at('home', '.config', '.bunfig.toml'),
      `[install]\nregistry = "${A}/c/"\n`,
    )

    const withXdg = sourcesFor({ XDG_CONFIG_HOME: at('xdg') })
    expect(bunRegistryConfig(at('proj'), base(), withXdg).registry).toBe(B)
    const relative = sourcesFor({ XDG_CONFIG_HOME: 'xdg' })
    expect(bunRegistryConfig(at('proj'), base(), relative).registry).toBe(A)
    expect(bunRegistryConfig(at('proj'), base(), sourcesFor()).registry).toBe(A)
  })

  it('puts the registry environment over both bunfigs and .npmrc: BUN_CONFIG_REGISTRY first', () => {
    projectBunfig(`[install]\nregistry = { url = "${B}", token = "T1" }\n`)
    const env = {
      BUN_CONFIG_REGISTRY: A,
      NPM_CONFIG_REGISTRY: 'http://127.0.0.1:4003/',
    }
    const config = bunRegistryConfig(at('proj'), base(), sourcesFor(env))
    expect(config.registry).toBe(A)
    expect(config.credentials).toEqual({})

    expect(
      bunRegistryConfig(
        at('proj'),
        base(),
        sourcesFor({ npm_config_registry: A }),
      ).registry,
    ).toBe(A)
  })

  it('orders credentials: bunfig inline, then the token environment, then .npmrc', () => {
    const npmrc = { '//127.0.0.1:4002/': { authToken: 'npmrc' } }

    projectBunfig(`[install]\nregistry = "${B}"\n`)
    expect(
      bunRegistryConfig(at('proj'), base({ credentials: npmrc }), sourcesFor())
        .credentials,
    ).toEqual(npmrc)

    const env = { NPM_CONFIG_TOKEN: 'npm-env', BUN_CONFIG_TOKEN: 'bun-env' }
    expect(
      bunRegistryConfig(
        at('proj'),
        base({ credentials: npmrc }),
        sourcesFor(env),
      ).credentials,
    ).toEqual({ '//127.0.0.1:4002/': { authToken: 'bun-env' } })

    projectBunfig(`[install]\nregistry = { url = "${B}", token = "inline" }\n`)
    expect(
      bunRegistryConfig(
        at('proj'),
        base({ credentials: npmrc }),
        sourcesFor(env),
      ).credentials,
    ).toEqual({ '//127.0.0.1:4002/': { authToken: 'inline' } })
  })

  it('does not send the token environment to the public default registry', () => {
    const config = bunRegistryConfig(
      at('proj'),
      base(),
      sourcesFor({ BUN_CONFIG_TOKEN: 'x' }),
    )
    expect(config.credentials).toEqual({})
  })

  it('does not send the token environment to a public registry spelled another way', () => {
    for (const registry of [
      'https://registry.npmjs.org',
      'https://registry.yarnpkg.com/',
    ]) {
      projectBunfig(`[install]\nregistry = "${registry}"\n`)
      const config = bunRegistryConfig(
        at('proj'),
        base(),
        sourcesFor({ BUN_CONFIG_TOKEN: 'x' }),
      )
      expect(config.credentials).toEqual({})
    }
  })

  it('keeps the default route credentials when a scope shares its prefix', () => {
    projectBunfig(
      `[install]\nregistry = { url = "${B}", token = "default" }\n[install.scopes]\n"@acme" = { url = "${B}", token = "scope" }\n`,
    )
    const config = bunRegistryConfig(at('proj'), base(), sourcesFor())
    expect(config.credentials).toEqual({
      '//127.0.0.1:4002/': { authToken: 'default' },
    })
    expect(config.scopedRegistries).toEqual({ '@acme': B })
  })

  it('names the host, never the path, when it ignores a scope credential', () => {
    const route = 'http://127.0.0.1:4002/SECRET/acme/'
    projectBunfig(
      `[install]\nregistry = { url = "${route}", token = "default" }\n[install.scopes]\n"@acme" = { url = "${route}", token = "scope" }\n`,
    )
    bunRegistryConfig(at('proj'), base(), sourcesFor())
    const lines = jest.mocked(logger.debug).mock.calls.map(([line]) => line)
    expect(lines).toEqual([expect.stringContaining('127.0.0.1:4002')])
    expect(lines.join('\n')).not.toContain('SECRET')
  })

  it('reads the workspace root bunfig.toml from a member directory, not the member', () => {
    write(
      at('proj', 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    )
    write(at('proj', 'packages', 'app', 'package.json'), '{"name":"app"}')
    projectBunfig(`[install.scopes]\nacme = "${A}"\n`)
    write(
      at('proj', 'packages', 'app', 'bunfig.toml'),
      `[install.scopes]\nacme = "${B}"\n`,
    )
    const config = bunRegistryConfig(
      at('proj', 'packages', 'app'),
      base(),
      sourcesFor(),
    )
    expect(config.scopedRegistries).toEqual({ '@acme': A })
  })

  it('gives a scope its inline credentials, replacing the .npmrc entry for that host', () => {
    projectBunfig(
      `[install.scopes]\n"@acme" = { url = "${B}", token = "T3" }\n`,
    )
    const config = bunRegistryConfig(
      at('proj'),
      base({ credentials: { '//127.0.0.1:4002/': { authToken: 'T2' } } }),
      sourcesFor(),
    )
    expect(config.credentials).toEqual({
      '//127.0.0.1:4002/': { authToken: 'T3' },
    })
  })
})
