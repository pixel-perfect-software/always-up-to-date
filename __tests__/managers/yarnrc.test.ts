jest.mock('@/utils/logger')
// swc's exports cannot be spied on; a counting stand-in for loadNpmrc.
jest.mock('@/utils/npmrcLoader', () => ({
  ...jest.requireActual('@/utils/npmrcLoader'),
  loadNpmrc: jest.fn(),
}))

import fs from 'fs'
import os from 'os'
import path from 'path'
import { yarnNpmrcLayers } from '@/managers/yarn/npmrc'
import {
  parseYarnrc,
  yarnRegistryConfig,
  yarnrcRoutes,
} from '@/managers/yarn/yarnrc'
import * as npmrcLoader from '@/utils/npmrcLoader'
import {
  mergeNpmrcLayers,
  type NpmrcSources,
  registryConfigFrom,
} from '@/utils/npmrcLoader'
import { registryFor } from '@/utils/registryRequest'

const A = 'http://127.0.0.1:4001/'
const B = 'http://127.0.0.1:4002/'
const C = 'http://127.0.0.1:4003/'

describe('parseYarnrc', () => {
  it('reads quoted and bare keys with quoted values', () => {
    expect(
      parseYarnrc(
        `registry "${B}"\n"@acme:registry" "${A}"\n--registry "${C}"\n`,
      ),
    ).toEqual({ registry: B, '@acme:registry': A, '--registry': C })
  })

  it('accepts a colon, CRLF line ends, comments and a trailing comment', () => {
    const text = `# header\r\nregistry: "${B}" # why\r\n\r\n"a:b": "c"\r\n`
    expect(parseYarnrc(text)).toEqual({ registry: B, 'a:b': 'c' })
  })

  it('reads bare words, which cannot hold a URL', () => {
    expect(
      parseYarnrc('yarn-offline-mirror ./mirror\nsave-prefix true\n'),
    ).toEqual({
      'yarn-offline-mirror': './mirror',
      'save-prefix': 'true',
    })
  })

  it('skips what yarn cannot parse: single quotes, an unquoted URL or scope key', () => {
    const text = `registry '${B}'\nregistry ${B}\n@acme:registry "${B}"\n`
    expect(parseYarnrc(text)).toEqual({})
  })

  it('lets a repeated key win by its last line, and skips indented lines', () => {
    expect(
      parseYarnrc(`registry "${A}"\nregistry "${B}"\n  registry "${C}"\n`),
    ).toEqual({
      registry: B,
    })
  })
})

describe('parseYarnrc: what yarn 1.22.22 does (checked with `yarn config get`, 2026-10-26)', () => {
  it('stops at an indented line, keeping the keys before it', () => {
    const text = `registry "${A}"\n  \n"@s:registry" "${B}"\n`
    expect(parseYarnrc(text)).toEqual({ registry: A })
    expect(parseYarnrc(`registry "${A}"\n    # note\nother x\n`)).toEqual({
      registry: A,
    })
  })

  it('skips the spaces of a first line', () => {
    expect(parseYarnrc(`  \nregistry "${A}"\n`)).toEqual({ registry: A })
  })

  it('reads a file with an odd indent as nothing (yarn falls back to YAML)', () => {
    const text = `registry "${A}"\n \n"@s:registry" "${B}"\n`
    expect(parseYarnrc(text)).toEqual({})
    expect(parseYarnrc(`registry "${A}"\n   "x" "y"\n`)).toEqual({})
  })

  it('drops a leading BOM', () => {
    expect(parseYarnrc(`\uFEFFregistry "${A}"\n`)).toEqual({ registry: A })
  })

  it('reads a file with a tab outside a comment as nothing', () => {
    expect(parseYarnrc(`registry\t"${A}"\n`)).toEqual({})
    expect(parseYarnrc(`registry "${A}"\t\n`)).toEqual({})
    expect(parseYarnrc(`\tregistry "${A}"\n`)).toEqual({})
    expect(parseYarnrc(`registry "${A}"\nother "x\ty"\n`)).toEqual({})
    expect(parseYarnrc(`registry "${A}" # a\ttab\n`)).toEqual({ registry: A })
  })

  it('reads a line yarn rejects as the whole file being nothing', () => {
    expect(parseYarnrc(`registry "${A}"\nregistry ${B}\n`)).toEqual({})
  })

  it('reads numbers, several keys on a line, and a key with only a colon', () => {
    expect(parseYarnrc('network-timeout 30000\na, "b" c\nd:\n')).toEqual({
      'network-timeout': '30000',
      a: 'c',
      b: 'c',
    })
  })
})

describe('yarnrcRoutes', () => {
  it('splits the registry, the flag and the scopes as written, usable or not', () => {
    const text = `registry "${B}"\n--registry "${A}"\n"@acme:registry" "${C}"\n"@bad:registry" "ftp://x/"\n"acme:registry" "${A}"\n`
    expect(yarnrcRoutes(text)).toEqual({
      registry: B,
      flagRegistry: A,
      upgradeRegistry: undefined,
      scopes: { '@acme': C, '@bad': 'ftp://x/' },
    })
  })

  it("reads --upgrade.registry and no other command's", () => {
    const text = `--upgrade.registry "${A}"\n--install.registry "${B}"\n`
    const routes = yarnrcRoutes(text)
    expect(routes.upgradeRegistry).toBe(A)
    expect(routes.flagRegistry).toBeUndefined()
  })
})

describe('yarnRegistryConfig', () => {
  let tmp: string
  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const sourcesFor = (env: NodeJS.ProcessEnv = {}): NpmrcSources => ({
    env,
    home: at('home'),
    // A temp prefix, so the real Node install's etc/npmrc cannot leak in.
    // node.exe sits in the prefix on Windows, in <prefix>/bin elsewhere.
    execPath:
      process.platform === 'win32'
        ? at('prefix', 'node.exe')
        : at('prefix', 'bin', 'node'),
    platform: process.platform,
  })
  /** yarn's view, as the session builds it: its own .npmrc layers, then the hook. */
  const viewFor = (cwd: string, sources: NpmrcSources) =>
    mergeNpmrcLayers(yarnNpmrcLayers(cwd, sources))
  const configFor = (cwd: string, env: NodeJS.ProcessEnv = {}) => {
    const sources = sourcesFor(env)
    const view = viewFor(cwd, sources)
    return yarnRegistryConfig(
      cwd,
      registryConfigFrom(view, cwd, sources),
      sources,
      view,
    )
  }
  const proj = () => at('proj')

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-yarnrc-')),
    )
    write(at('proj', 'package.json'), '{"name":"p"}')
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  // Precedence verified on yarn 1.22.22, 2026-10-26: `yarn install` against
  // local registries that log each request.
  it('routes the default and a scope from the project .yarnrc', () => {
    write(at('proj', '.yarnrc'), `registry "${A}"\n"@acme:registry" "${B}"\n`)
    const config = configFor(proj())
    expect(registryFor('left-pad', config)).toBe(A)
    expect(registryFor('@acme/probe', config)).toBe(B)
  })

  it('reads ~/.yarnrc, below the project .yarnrc', () => {
    write(at('home', '.yarnrc'), `registry "${B}"\n"@acme:registry" "${B}"\n`)
    expect(configFor(proj()).registry).toBe(B)
    write(at('proj', '.yarnrc'), `registry "${A}"\n"@acme:registry" "${A}"\n`)
    const config = configFor(proj())
    expect(config.registry).toBe(A)
    expect(config.scopedRegistries).toEqual({ '@acme': A })
  })

  it('puts .npmrc above .yarnrc for the default, whichever file is nearer', () => {
    write(at('proj', '.yarnrc'), `registry "${B}"\n`)
    write(at('home', '.npmrc'), `registry=${A}\n`)
    expect(configFor(proj()).registry).toBe(A)

    fs.rmSync(at('home', '.npmrc'))
    fs.rmSync(at('proj', '.yarnrc'))
    write(at('home', '.yarnrc'), `registry "${B}"\n`)
    write(at('proj', '.npmrc'), `registry=${A}\n`)
    expect(configFor(proj()).registry).toBe(A)
  })

  it('puts an .npmrc scope above a .yarnrc scope', () => {
    write(
      at('proj', '.yarnrc'),
      `"@acme:registry" "${B}"\n"@yarn:registry" "${B}"\n`,
    )
    write(at('proj', '.npmrc'), `@acme:registry=${A}\n`)
    expect(configFor(proj()).scopedRegistries).toEqual({
      '@acme': A,
      '@yarn': B,
    })
  })

  it('lets a scope in either file beat the default of the other', () => {
    write(at('proj', '.yarnrc'), `"@acme:registry" "${B}"\n`)
    write(at('proj', '.npmrc'), `registry=${A}\n`)
    const config = configFor(proj())
    expect(registryFor('@acme/probe', config)).toBe(B)
    expect(registryFor('other', config)).toBe(A)
  })

  it('puts the npm_config_registry variable above YARN_REGISTRY, and that above .npmrc and .yarnrc', () => {
    write(at('proj', '.yarnrc'), `registry "${C}"\n`)
    write(at('proj', '.npmrc'), `registry=${C}\n`)
    expect(configFor(proj(), { YARN_REGISTRY: B }).registry).toBe(B)
    expect(
      configFor(proj(), { YARN_REGISTRY: B, npm_config_registry: A }).registry,
    ).toBe(A)
    write(at('proj', '.npmrc'), '')
    expect(configFor(proj(), { YARN_REGISTRY: B }).registry).toBe(B)
    expect(configFor(proj(), { yarn_registry: B }).registry).toBe(B)
  })

  it('puts --registry above everything for the default, below every scope', () => {
    write(at('proj', '.yarnrc'), `--registry "${B}"\n`)
    write(at('proj', '.npmrc'), `registry=${A}\n@acme:registry=${A}\n`)
    const env = { npm_config_registry: A, YARN_REGISTRY: A }
    const config = configFor(proj(), env)
    expect(registryFor('left-pad', config)).toBe(B)
    expect(registryFor('@acme/probe', config)).toBe(A)
  })

  it('takes --registry from ~/.yarnrc over the project .yarnrc', () => {
    write(at('home', '.yarnrc'), `--registry "${B}"\n`)
    write(at('proj', '.yarnrc'), `--registry "${A}"\n`)
    expect(configFor(proj()).registry).toBe(B)
  })

  it('does not read --@scope:registry as a scope', () => {
    write(at('proj', '.yarnrc'), `"--@acme:registry" "${B}"\n`)
    expect(configFor(proj()).scopedRegistries).toEqual({})
  })

  it('reads the parent directories, nearest first, per key', () => {
    write(at('package.json'), '{"name":"root","workspaces":["proj"]}')
    write(at('.yarnrc'), `"@acme:registry" "${A}"\nregistry "${A}"\n`)
    const member = at('proj')
    expect(configFor(member).registry).toBe(A)
    write(at('proj', '.yarnrc'), `registry "${B}"\n`)
    const config = configFor(member)
    expect(registryFor('left-pad', config)).toBe(B)
    expect(registryFor('@acme/probe', config)).toBe(A)
  })

  it('puts ~/.yarnrc above the parent directories', () => {
    write(at('.yarnrc'), `registry "${A}"\n`)
    write(at('home', '.yarnrc'), `registry "${B}"\n`)
    expect(configFor(proj()).registry).toBe(B)
  })

  it('leaves credentials to .npmrc: a .yarnrc entry sends nothing', () => {
    write(
      at('proj', '.yarnrc'),
      `registry "${B}"\n"//127.0.0.1:4002/:_authToken" "T"\n"_authToken" "U"\n`,
    )
    write(at('proj', '.npmrc'), '//127.0.0.1:4002/:_authToken=N\n')
    expect(configFor(proj()).credentials).toEqual({
      '//127.0.0.1:4002/': { authToken: 'N' },
    })
  })

  it('puts --upgrade.registry above --registry whatever the file or order', () => {
    write(at('home', '.yarnrc'), `--registry "${A}"\n`)
    write(
      at('proj', '.yarnrc'),
      `--upgrade.registry "${B}"\n--registry "${C}"\n`,
    )
    expect(configFor(proj()).registry).toBe(B)
  })

  it("ignores another command's scoped flag, and a scope still beats --upgrade.registry", () => {
    write(
      at('proj', '.yarnrc'),
      `--install.registry "${B}"\n--upgrade.registry "${C}"\n`,
    )
    write(at('proj', '.npmrc'), `@acme:registry=${A}\n`)
    const config = configFor(proj())
    expect(registryFor('left-pad', config)).toBe(C)
    expect(registryFor('@acme/probe', config)).toBe(A)
    write(at('proj', '.yarnrc'), `--install.registry "${B}"\n`)
    expect(configFor(proj()).registry).toBe('https://registry.npmjs.org/')
  })

  describe('the filesystem root', () => {
    const withRootYarnrc = (content: string) => {
      // The project's own root: on Windows the temp dir and the checkout can
      // sit on different drives.
      const rootFile = path.join(path.parse(proj()).root, '.yarnrc')
      const real = fs.readFileSync
      return jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation(((
          file: fs.PathOrFileDescriptor,
          ...rest: unknown[]
        ) =>
          file === rootFile
            ? content
            : (real as (...args: unknown[]) => unknown)(
                file,
                ...rest,
              )) as typeof fs.readFileSync)
    }

    it('does not read /.yarnrc for ordinary keys', () => {
      withRootYarnrc(`registry "${B}"\n"@acme:registry" "${B}"\n`)
      const config = configFor(proj())
      expect(config.registry).toBe('https://registry.npmjs.org/')
      expect(config.scopedRegistries).toEqual({})
    })

    it('reads /.yarnrc for the flags, as yarn does', () => {
      withRootYarnrc(`--registry "${B}"\n`)
      expect(configFor(proj()).registry).toBe(B)
    })
  })

  it('matches the variables as loadNpmrc does: empty skipped, last match wins', () => {
    write(at('proj', '.yarnrc'), `registry "${C}"\n`)
    expect(
      configFor(proj(), { yarn_registry: '', YARN_REGISTRY: B }).registry,
    ).toBe(B)
    expect(
      configFor(proj(), { yarn_registry: A, YARN_REGISTRY: B }).registry,
    ).toBe(B)
    expect(
      configFor(proj(), { npm_config_registry: '', NPM_CONFIG_REGISTRY: A })
        .registry,
    ).toBe(A)
  })

  it('reads each .yarnrc once', () => {
    write(at('proj', '.yarnrc'), `registry "${A}"\n`)
    const spy = jest.spyOn(fs, 'readFileSync')
    configFor(proj())
    const reads = spy.mock.calls.filter(
      ([file]) => file === at('proj', '.yarnrc'),
    )
    expect(reads).toHaveLength(1)
  })

  it('returns the .npmrc view when nothing routes', () => {
    const sources = sourcesFor()
    const view = viewFor(proj(), sources)
    const base = registryConfigFrom(view, proj(), sources)
    expect(yarnRegistryConfig(proj(), base, sources, view)).toEqual(base)
  })

  it('reads the .npmrc layers once: loadNpmrc is not called again', () => {
    write(at('proj', '.npmrc'), `registry=${A}\n`)
    const reads = jest.spyOn(fs, 'readFileSync')
    expect(configFor(proj()).registry).toBe(A)
    expect(npmrcLoader.loadNpmrc).not.toHaveBeenCalled()
    expect(
      reads.mock.calls.filter(([file]) => file === at('proj', '.npmrc')),
    ).toHaveLength(1)
  })
})
