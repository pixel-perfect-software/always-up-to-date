import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { adapterFor } from '@/managers'
import { check } from '@/pipeline'
import { openProject } from '@/project'
import { StepError } from '@/stepError'
import type { SupportedPackageManager } from '@/types'
import logger from '@/utils/logger'
import {
  managerRegistryConfig,
  mergeNpmrcLayers,
  type NpmrcSources,
  registryConfigFrom,
} from '@/utils/npmrcLoader'
import { createRegistrySession } from '@/utils/registry'
import { describeUnusable, unusableRouteFor } from '@/utils/registryRequest'
import { isolateNpmConfig } from '../fixtures'

// #129. Every row was probed 2026-10-27 against local registries and a
// sentinel proxy for registry.npmjs.org: npm 11.19.1, pnpm 12.15.0, yarn
// 1.22.22 and bun 1.4.4, each running `install` (npm also `outdated`). A
// manager that fails on a registry value it cannot use does so when it
// resolves a package routed there, with no request sent anywhere; autd stops
// the same way instead of asking another registry. Where a manager skips the
// value (pnpm and a `${…}` in a project file), autd skips it too.

const A = 'http://127.0.0.1:4001/'

interface Setup {
  /** Files under the project directory. */
  project?: Record<string, string>
  /** Files under HOME. */
  home?: Record<string, string>
  env?: NodeJS.ProcessEnv
}

describe('a registry value the manager cannot use (#129)', () => {
  let tmp: string

  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  const route = (
    pm: SupportedPackageManager,
    { project = {}, home = {}, env = {} }: Setup,
    name: string,
  ) => {
    const cwd = path.join(tmp, 'proj')
    const homeDir = path.join(tmp, 'home')
    write(path.join(cwd, 'package.json'), '{}')
    fs.mkdirSync(homeDir, { recursive: true })
    for (const [file, text] of Object.entries(project)) {
      write(path.join(cwd, file), text)
    }
    for (const [file, text] of Object.entries(home)) {
      write(path.join(homeDir, file), text)
    }
    const sources: NpmrcSources = {
      env: { XDG_CONFIG_HOME: path.join(homeDir, '.config'), ...env },
      home: homeDir,
      execPath: path.join(tmp, 'prefix', 'bin', 'node'),
      platform: 'linux',
    }
    const config = managerRegistryConfig(adapterFor(pm), cwd, sources)
    return unusableRouteFor(name, config)
  }

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autd-bad-')))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const npmrc = (text: string): Setup => ({ project: { '.npmrc': text } })

  describe('npm fails on every one', () => {
    it.each([
      ['an unparseable URL', 'http://127.0.0.1:$PORT/', 'not a valid URL'],
      ['text', 'not a url', 'not a valid URL'],
      ['a non-http(s) URL', 'ftp://x/', 'not an http(s) URL'],
      ['an unset variable', '${UNSET}', 'unexpanded'],
    ])('as the default registry: %s', (_, value, reason) => {
      const bad = route('npm', npmrc(`registry=${value}\n`), 'probe-unscoped')
      expect(bad).toMatchObject({
        key: 'registry',
        source: path.join(tmp, 'proj', '.npmrc'),
      })
      expect(bad?.reason).toContain(reason)
    })

    it('as a scope route, for that scope only', () => {
      const setup = npmrc(`@acme:registry=not a url\nregistry=${A}\n`)
      expect(route('npm', setup, '@acme/probe')?.key).toBe('@acme:registry')
      expect(route('npm', setup, 'probe-unscoped')).toBeUndefined()
      expect(route('npm', setup, '@other/probe')).toBeUndefined()
    })

    it('when it is the winning value, not when a higher layer shadows it', () => {
      const shadowed: Setup = {
        project: { '.npmrc': `registry=${A}\n` },
        home: { '.npmrc': 'registry=${UNSET}\n' },
      }
      expect(route('npm', shadowed, 'left-pad')).toBeUndefined()
    })

    it('for an empty default registry, but not an empty scope', () => {
      expect(route('npm', npmrc('registry=\n'), 'left-pad')?.reason).toContain(
        'empty',
      )
      expect(
        route('npm', npmrc(`@acme:registry=\nregistry=${A}\n`), '@acme/probe'),
      ).toBeUndefined()
    })

    it('but uses a ${VAR} that is set', () => {
      expect(
        route(
          'npm',
          { ...npmrc('registry=http://h:${PORT}/\n'), env: { PORT: '1' } },
          'a',
        ),
      ).toBeUndefined()
    })
  })

  describe('bun fails on every one', () => {
    it('the issue: .npmrc registry=http://127.0.0.1:$PORT/ (bun expands $VAR only as a whole value)', () => {
      const bad = route(
        'bun',
        {
          ...npmrc('registry=http://127.0.0.1:$PORT/\n'),
          env: { PORT: '4002' },
        },
        '@acme/probe',
      )
      expect(bad).toMatchObject({
        key: 'registry',
        value: 'http://127.0.0.1:$PORT/',
      })
    })

    it('for a bunfig.toml registry, over a usable .npmrc one', () => {
      const bad = route(
        'bun',
        {
          project: {
            'bunfig.toml': '[install]\nregistry = "not a url"\n',
            '.npmrc': `registry=${A}\n`,
          },
        },
        'left-pad',
      )
      expect(bad).toMatchObject({
        key: 'install.registry',
        source: path.join(tmp, 'proj', 'bunfig.toml'),
      })
    })

    it('for a bunfig.toml scope with a $ in the URL, for that scope only', () => {
      const setup: Setup = {
        project: {
          'bunfig.toml': '[install.scopes]\nacme = "http://h:$PORT/"\n',
          '.npmrc': `registry=${A}\n`,
        },
      }
      expect(route('bun', setup, '@acme/probe')?.key).toBe(
        'install.scopes."@acme"',
      )
      expect(route('bun', setup, 'left-pad')).toBeUndefined()
    })

    it.each([
      'BUN_CONFIG_REGISTRY',
      'NPM_CONFIG_REGISTRY',
      'npm_config_registry',
    ])('for %s', (name) => {
      expect(
        route('bun', { env: { [name]: 'not a url' } }, 'left-pad')?.key,
      ).toBe(name)
    })

    it('not for a bunfig.toml route that overrides a bad .npmrc one', () => {
      expect(
        route(
          'bun',
          {
            project: {
              'bunfig.toml': `[install]\nregistry = "${A}"\n`,
              '.npmrc': 'registry=not a url\n',
            },
          },
          'left-pad',
        ),
      ).toBeUndefined()
    })

    it('but skips an empty route', () => {
      expect(route('bun', npmrc('registry=\n'), 'left-pad')).toBeUndefined()
    })
  })

  describe('yarn v1 fails on every one', () => {
    it.each([['not a url'], ['ftp://x/'], ['${UNSET}']])(
      'for .npmrc registry=%s',
      (value) => {
        expect(
          route('yarn', npmrc(`registry=${value}\n`), 'left-pad')?.key,
        ).toBe('registry')
      },
    )

    it('for a .yarnrc registry when nothing above it sets one', () => {
      expect(
        route(
          'yarn',
          { project: { '.yarnrc': 'registry "not a url"\n' } },
          'a',
        ),
      ).toMatchObject({
        key: 'registry',
        source: path.join(tmp, 'proj', '.yarnrc'),
      })
    })

    it('not for a .yarnrc registry that .npmrc overrides', () => {
      expect(
        route(
          'yarn',
          {
            project: {
              '.yarnrc': 'registry "not a url"\n',
              '.npmrc': `registry=${A}\n`,
            },
          },
          'left-pad',
        ),
      ).toBeUndefined()
    })

    it('for a .yarnrc scope, for that scope only', () => {
      const setup: Setup = {
        project: { '.yarnrc': '"@acme:registry" "ftp://x/"\n' },
      }
      expect(route('yarn', setup, '@acme/probe')?.key).toBe('@acme:registry')
      expect(route('yarn', setup, 'left-pad')).toBeUndefined()
    })

    it('for YARN_REGISTRY', () => {
      expect(
        route('yarn', { env: { YARN_REGISTRY: 'not a url' } }, 'a')?.key,
      ).toBe('YARN_REGISTRY')
    })

    it('but skips an empty route', () => {
      expect(route('yarn', npmrc('registry=\n'), 'left-pad')).toBeUndefined()
    })
  })

  describe('pnpm', () => {
    it.each([
      ['an unparseable URL', 'http://127.0.0.1:$PORT/'],
      ['text', 'not a url'],
      ['a non-http(s) URL', 'ftp://x/'],
    ])('fails on %s in the project .npmrc', (_, value) => {
      expect(route('pnpm', npmrc(`registry=${value}\n`), 'left-pad')?.key).toBe(
        'registry',
      )
    })

    it('falls through a ${…} in a project .npmrc, to the next source', () => {
      const setup: Setup = {
        project: { '.npmrc': 'registry=${UNSET}\n' },
        home: { '.npmrc': `registry=${A}\n` },
      }
      expect(route('pnpm', setup, 'left-pad')).toBeUndefined()
    })

    it('falls through a ${…} in pnpm-workspace.yaml', () => {
      expect(
        route(
          'pnpm',
          { project: { 'pnpm-workspace.yaml': 'registry: ${UNSET}\n' } },
          'a',
        ),
      ).toBeUndefined()
    })

    it.each([
      ['registry: ftp://x/\n', 'registry'],
      ['registries:\n  default: not a url\n', 'registries.default'],
    ])('fails on pnpm-workspace.yaml %j', (yaml, key) => {
      expect(
        route(
          'pnpm',
          {
            project: {
              'pnpm-workspace.yaml': yaml,
              '.npmrc': `registry=${A}\n`,
            },
          },
          'left-pad',
        )?.key,
      ).toBe(key)
    })

    it('fails on a yaml scope, for that scope only', () => {
      const setup: Setup = {
        project: {
          'pnpm-workspace.yaml': 'registries:\n  "@acme": not a url\n',
        },
      }
      expect(route('pnpm', setup, '@acme/probe')?.key).toBe(
        'registries."@acme"',
      )
      expect(route('pnpm', setup, 'left-pad')).toBeUndefined()
    })

    it('fails on an unset ${VAR} in the user .npmrc, which pnpm expands to nothing', () => {
      expect(
        route('pnpm', { home: { '.npmrc': 'registry=${UNSET}\n' } }, 'left-pad')
          ?.reason,
      ).toContain('empty')
    })

    it('fails on pnpm_config_registry, and ignores npm_config_registry', () => {
      expect(
        route('pnpm', { env: { pnpm_config_registry: 'not a url' } }, 'a')?.key,
      ).toBe('pnpm_config_registry')
      expect(
        route('pnpm', { env: { npm_config_registry: 'not a url' } }, 'a'),
      ).toBeUndefined()
    })
  })

  describe('the value shown never carries a credential', () => {
    it('drops userinfo, the query and a path token, keeping the host', () => {
      const shown = describeUnusable(
        'ftp://user:SECRET@h.test/TOKEN/acme/?k=SECRET2',
      )
      expect(shown).toMatch(/^ftp:\/\/h\.test\/…\[[0-9a-f]{6}\]$/)
      expect(shown).not.toMatch(/SECRET|TOKEN|user/)
    })

    it.each([
      'https://alice:s3cr/et@npm.acme.com/',
      'https://alice:s3cr?et@npm.acme.com/',
      'https://alice:s3cr#et@npm.acme.com/path',
      'https://alice@x:s3cr/et@npm.acme.com/',
    ])('keeps a password holding / ? # or @ out: %s', (value) => {
      const shown = describeUnusable(value)
      expect(shown).toMatch(/^https:\/\/npm\.acme\.com\//)
      expect(shown).not.toMatch(/alice|s3cr|et@/)
    })

    it.each([
      '@acme:registry=npm_AbCdEf1234567890',
      'npm_AbCdEf1234567890',
      'alice:hunter2',
      'not a url',
      'https://',
      'https://alice:hunter2@/',
    ])('shows a value with no scheme and host as not shown: %s', (value) => {
      const shown = describeUnusable(value)
      expect(shown).toBe('(value not shown)')
      expect(shown).not.toMatch(/alice|hunter2|npm_AbCd/)
    })

    it('shows a value that is only variable references', () => {
      expect(describeUnusable('${REGISTRY}')).toBe('${REGISTRY}')
      expect(describeUnusable(' $REG ${OTHER?} ')).toBe('$REG ${OTHER?}')
    })
  })

  describe('a variable inside a URL that parses', () => {
    it.each(['npm', 'bun', 'yarn'] as const)(
      '%s fails on https://${REGISTRY_HOST}/ and on https://$HOST/',
      (pm) => {
        // npm 11.19.1: ENOTFOUND for a host named ${unset} / $unset.
        for (const value of ['https://${REGISTRY_HOST}/', 'https://$HOST/']) {
          const bad = route(pm, npmrc(`registry=${value}\n`), 'left-pad')
          expect(bad?.reason).toMatch(/unexpanded/)
          fs.rmSync(path.join(tmp, 'proj'), { recursive: true, force: true })
        }
      },
    )

    it('pnpm still falls through a project-file https://${REGISTRY_HOST}/', () => {
      expect(
        route('pnpm', npmrc('registry=https://${REGISTRY_HOST}/\n'), 'a'),
      ).toBeUndefined()
    })
  })

  describe('pnpm global config.yaml', () => {
    const globalYaml = (yaml: string): Setup => ({
      home: { '.config/pnpm/config.yaml': yaml },
    })

    it.each([
      ['registries:\n  default: ${UNSET}\n', 'registries.default'],
      ['registries:\n  "@acme": ${UNSET}\n', 'registries."@acme"'],
      ['registries:\n  "@acme": ""\n', 'registries."@acme"'],
      ['registry: ${UNSET}\n', 'registry'],
    ])('fails on %j (an unset variable expands to nothing)', (yaml, key) => {
      const bad = route('pnpm', globalYaml(yaml), '@acme/probe')
      expect(bad?.key).toBe(key)
      expect(bad?.reason).toContain('empty')
    })
  })

  describe('a whitespace-only value counts as empty', () => {
    it('in a .yarnrc: yarn skips it', () => {
      expect(
        route('yarn', { project: { '.yarnrc': 'registry "   "\n' } }, 'a'),
      ).toBeUndefined()
    })

    it('in a bunfig.toml: bun skips it', () => {
      expect(
        route(
          'bun',
          {
            project: {
              'bunfig.toml': '[install]\nregistry = "   "\n',
              '.npmrc': `registry=${A}\n`,
            },
          },
          'a',
        ),
      ).toBeUndefined()
    })

    it('in an .npmrc: npm fails on a default, skips a scope', () => {
      expect(route('npm', npmrc('registry=   \n'), 'a')?.reason).toContain(
        'empty',
      )
    })
  })

  describe('the key named is the one the source spells', () => {
    it('a pnpm-workspace.yaml URL-keyed entry is named by its scope, not its URL', () => {
      const bad = route(
        'pnpm',
        {
          project: {
            'pnpm-workspace.yaml':
              'registries:\n  ftp://user:SECRET@h.test/TOKEN/:\n    scopes: ["@acme"]\n',
          },
        },
        '@acme/probe',
      )
      expect(bad?.key).toBe('registries (a URL-keyed entry for "@acme")')
      expect(JSON.stringify(bad)).not.toMatch(/SECRET|TOKEN/)
    })

    it.each([
      ['npm', 'npm_config_registry'],
      ['yarn', 'npm_config_registry'],
      ['bun', 'npm_config_registry'],
      ['pnpm', 'PNPM_CONFIG_REGISTRY'],
    ] as const)('%s names the variable %s', (pm, name) => {
      expect(route(pm, { env: { [name]: 'not a url' } }, 'left-pad')?.key).toBe(
        name,
      )
    })
  })

  describe('the session refuses an unusable route (#129)', () => {
    let server: http.Server
    let requests: string[]

    beforeEach(async () => {
      requests = []
      server = http.createServer((req, res) => {
        requests.push(req.url ?? '')
        res.writeHead(404).end('{}')
      })
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      )
    })

    afterEach(() => {
      server.close()
    })

    const sessionFor = () => {
      const { port } = server.address() as AddressInfo
      // @acme has an unusable route; everything else goes to the local server,
      // which is what a fall-through to "the default" would reach.
      const config = registryConfigFrom(
        mergeNpmrcLayers([
          {
            kind: 'file',
            file: path.join(tmp, '.npmrc'),
            values: {
              registry: `http://127.0.0.1:${port}/`,
              '@acme:registry': 'not a url',
            },
          },
        ]),
        tmp,
        { env: {}, home: tmp, execPath: tmp, platform: 'linux' },
      )
      return createRegistrySession(tmp, { loadConfig: () => config })
    }

    it('releaseTimes asks no registry for a package routed there', async () => {
      const session = sessionFor()
      try {
        expect(await session.releaseTimes('@acme/probe')).toEqual({})
        expect(requests).toEqual([])
        await session.releaseTimes('left-pad')
        expect(requests).toEqual(['/left-pad'])
      } finally {
        session.close()
      }
    })

    it('lookup answers invalid with the same reason, and asks nothing', async () => {
      const session = sessionFor()
      try {
        const result = await session.lookup('@acme/probe')
        expect(result).toMatchObject({ ok: false, kind: 'invalid' })
        expect(result.ok ? '' : result.reason).toContain(
          '@acme:registry `(value not shown)`',
        )
        expect(requests).toEqual([])
      } finally {
        session.close()
      }
    })
  })

  describe('check', () => {
    let restore: () => void
    const saved: Record<string, string | undefined> = {}

    beforeEach(() => {
      restore = isolateNpmConfig(tmp)
      // A fall-through would try registry.npmjs.org: send it to a closed port.
      for (const key of ['HTTPS_PROXY', 'https_proxy', 'XDG_CONFIG_HOME']) {
        saved[key] = process.env[key]
      }
      process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
      process.env.https_proxy = 'http://127.0.0.1:1'
      delete process.env.XDG_CONFIG_HOME
    })

    afterEach(() => {
      restore()
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      logger.configure({})
    })

    const project = (pm: SupportedPackageManager, npmrcText: string) => {
      const cwd = path.join(tmp, 'e2e')
      write(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          name: 'e2e',
          dependencies: { 'left-pad': '^1.0.0', '@acme/probe': '1.0.0' },
        }),
      )
      write(
        path.join(cwd, 'node_modules', 'left-pad', 'package.json'),
        '{"name":"left-pad","version":"1.0.0"}',
      )
      write(
        path.join(cwd, 'node_modules', '@acme', 'probe', 'package.json'),
        '{"name":"@acme/probe","version":"1.0.0"}',
      )
      write(path.join(cwd, '.npmrc'), npmrcText)
      write(
        path.join(cwd, '.always-up-to-date.json'),
        '{"depsDev":false,"silent":true}',
      )
      return openProject(cwd, { pm, cache: false })
    }

    it("bun's registry=http://127.0.0.1:$PORT/ fails the check, naming the file and key", async () => {
      const failure = await check(
        project('bun', 'registry=http://127.0.0.1:$PORT/\n'),
      ).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(StepError)
      const error = failure as StepError
      expect(error.step).toBe('discover')
      expect(error.message).toContain("bun can't use registry")
      expect(error.message).toContain('http://127.0.0.1:$PORT/')
      expect(error.message).toContain(path.join(tmp, 'e2e', '.npmrc'))
      expect(error.message).toContain('fix or remove it')
    })

    it('leaves a credential out of the message', async () => {
      const failure = await check(
        project('npm', 'registry=ftp://user:SECRET@h.test/TOKEN/\n'),
      ).then(
        () => undefined,
        (error: unknown) => error,
      )
      const message = (failure as StepError).message
      expect(message).toContain('h.test')
      expect(message).not.toMatch(/SECRET|TOKEN|user/)
    })
  })
})
