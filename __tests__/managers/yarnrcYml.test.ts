import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  berryRcFiles,
  berryRegistryConfig,
  berrySettings,
  parseYarnrcYml,
  substituteBerry,
} from '@/managers/yarn/yarnrcYml'
import type { NpmrcSources } from '@/utils/npmrcLoader'
import { readTls } from '../fixtures/registry'

jest.mock('@/utils/logger')

describe('parseYarnrcYml', () => {
  it('reads block maps, quoted keys and both sequence forms', () => {
    expect(
      parseYarnrcYml(
        [
          '# a comment',
          'nodeLinker: node-modules',
          'npmRegistryServer: "https://npm.example.com" # trailing',
          "npmAuthToken: 'it''s'",
          'npmScopes:',
          '  acme:',
          '    npmRegistryServer: https://npm.pkg.github.com',
          '    npmAlwaysAuth: true',
          'npmRegistries:',
          '  "//npm.example.com/":',
          '    npmAuthToken: "a#b"',
          'unsafeHttpWhitelist: ["localhost", \'*.internal\']',
          'supportedArchitectures:',
          '  os:',
          '  - linux',
          '  - darwin',
        ].join('\n'),
      ),
    ).toEqual({
      nodeLinker: 'node-modules',
      npmRegistryServer: 'https://npm.example.com',
      npmAuthToken: "it's",
      npmScopes: {
        acme: {
          npmRegistryServer: 'https://npm.pkg.github.com',
          npmAlwaysAuth: 'true',
        },
      },
      npmRegistries: { '//npm.example.com/': { npmAuthToken: 'a#b' } },
      unsafeHttpWhitelist: ['localhost', '*.internal'],
      supportedArchitectures: { os: ['linux', 'darwin'] },
    })
  })

  it('reads a sequence of maps, as `plugins` holds, and the keys after it', () => {
    expect(
      parseYarnrcYml(
        [
          'plugins:',
          '  - path: .yarn/plugins/a.cjs',
          '    spec: "@yarnpkg/plugin-a"',
          '  - path: .yarn/plugins/b.cjs',
          'npmRegistryServer: "https://r.example"',
        ].join('\r\n'),
      ),
    ).toEqual({
      plugins: [
        { path: '.yarn/plugins/a.cjs', spec: '@yarnpkg/plugin-a' },
        { path: '.yarn/plugins/b.cjs' },
      ],
      npmRegistryServer: 'https://r.example',
    })
  })

  it('leaves out a key it cannot read, never the file', () => {
    expect(
      parseYarnrcYml(
        [
          '\uFEFFpackageExtensions: { "a@*": { dependencies: { b: "*" } } }',
          'note: |',
          '  a block scalar',
          '  over two lines',
          'anchor: &x value',
          'npmRegistryServer: "https://r.example"',
        ].join('\n'),
      ),
    ).toEqual({ npmRegistryServer: 'https://r.example' })
  })

  it('decodes YAML escapes in double quotes and rejects an unknown one', () => {
    expect(
      parseYarnrcYml('a: "x\\ty\\u00e9\\\\"\nb: "bad \\q"\nc: "unclosed\n'),
    ).toEqual({ a: 'x\ty\u00e9\\' })
  })

  it('is empty for a tab in the indentation, which berry fails on', () => {
    expect(parseYarnrcYml('npmScopes:\n\tacme: {}\n')).toEqual({})
    expect(parseYarnrcYml('')).toEqual({})
  })
})

// The substitution in yarn 4.18.1's bundle (r16-r18).
describe('substituteBerry', () => {
  const env = { SET: 'v', EMPTY: '' }

  it.each([
    ['${SET}', 'v'],
    ['a${SET}b', 'avb'],
    ['${UNSET-x}', 'x'],
    ['${EMPTY-x}', ''],
    ['${EMPTY:-x}', 'x'],
    ['${UNSET:-${SET}}', 'v'],
    ['${UNSET:-${ALSO:-deep}}', 'deep'],
    ['${SET:-${UNSET}}', 'v'],
    ['\\${SET}', '${SET}'],
    ['a\\}b', 'a}b'],
    ['plain } brace', 'plain } brace'],
  ])('%s is %j', (input, expected) => {
    expect(substituteBerry(input, env)).toBe(expected)
  })

  it.each([
    ['${UNSET}', 'Environment variable not found (UNSET)'],
    ['${1BAD}', 'Invalid environment variable substitution syntax'],
    ['${UNSET:-x', 'Incomplete variable substitution'],
  ])('%s throws', (input, message) => {
    expect(() => substituteBerry(input, env)).toThrow(message)
  })
})

describe('berry settings', () => {
  let tmp: string
  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const sourcesFor = (env: NodeJS.ProcessEnv = {}): NpmrcSources => ({
    env,
    home: at('home'),
    execPath: at('prefix', 'bin', 'node'),
    platform: process.platform,
  })
  const proj = () => at('parent', 'proj')

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autd-yml-')))
    fs.mkdirSync(proj(), { recursive: true })
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('lists the directory, every parent, then the home file', () => {
    const files = berryRcFiles(proj(), sourcesFor())
    expect(files.slice(0, 2)).toEqual([
      at('parent', 'proj', '.yarnrc.yml'),
      at('parent', '.yarnrc.yml'),
    ])
    expect(files.at(-1)).toBe(at('home', '.yarnrc.yml'))
    expect(
      berryRcFiles(proj(), sourcesFor({ YARN_RC_FILENAME: '.ci.yml' }))[0],
    ).toBe(at('parent', 'proj', '.ci.yml'))
  })

  // `yarn config get --json` on 4.18.1, 2026-11-03, with these three files.
  it('merges the files as berry does: scalars nearest first, scopes per key, arrays concatenated', () => {
    write(
      at('parent', 'proj', '.yarnrc.yml'),
      'unsafeHttpWhitelist: ["proj"]\nnpmScopes:\n  acme:\n    npmRegistryServer: "http://proj"\n',
    )
    write(
      at('parent', '.yarnrc.yml'),
      'unsafeHttpWhitelist:\n  - parent\nnpmScopes:\n  acme:\n    npmAuthToken: PARENT\nhttpTimeout: 30s\nnpmRegistryServer: "https://parent"\n',
    )
    write(
      at('home', '.yarnrc.yml'),
      'unsafeHttpWhitelist: ["home"]\nnpmAlwaysAuth: true\nnpmRegistryServer: "https://home"\n',
    )

    const settings = berrySettings(proj(), sourcesFor())

    expect(settings.unsafeHttpWhitelist).toEqual(['home', 'parent', 'proj'])
    expect(settings.scopes.acme.npmRegistryServer?.value).toBe('http://proj')
    expect(settings.scopes.acme.npmAuthToken?.value).toBe('PARENT')
    expect(settings.scalars.npmRegistryServer?.value).toBe('https://parent')
    expect(settings.scalars.npmAlwaysAuth?.value).toBe('true')
    expect(settings.scalars.httpTimeout?.value).toBe('30s')
  })

  it('merges an npmRegistries key per field, and the nearer spelling wins whole', () => {
    write(
      at('parent', 'proj', '.yarnrc.yml'),
      'npmRegistries:\n  "//r.example":\n    npmAuthToken: P\n  "//s.example/":\n    npmAuthToken: S\n',
    )
    write(
      at('home', '.yarnrc.yml'),
      'npmRegistries:\n  "//r.example":\n    npmAlwaysAuth: true\n  "//s.example":\n    npmAlwaysAuth: true\n',
    )

    const { registries } = berrySettings(proj(), sourcesFor())

    expect(registries['//r.example'].npmAuthToken?.value).toBe('P')
    expect(registries['//r.example'].npmAlwaysAuth?.value).toBe('true')
    expect(registries['//s.example'].npmAuthToken?.value).toBe('S')
    expect(registries['//s.example'].npmAlwaysAuth).toBeUndefined()
  })

  it('lets YARN_* variables beat the files (r11, r12, r29), and substitutes ${…} (r16, r17)', () => {
    write(
      at('parent', 'proj', '.yarnrc.yml'),
      'npmRegistryServer: "https://file"\nnpmAuthToken: "${TOK_107}"\nnpmAuthIdent: "${UNSET_107:-d}"\n',
    )
    const settings = berrySettings(
      proj(),
      sourcesFor({
        YARN_NPM_REGISTRY_SERVER: 'https://env',
        YARN_NPM_ALWAYS_AUTH: 'true',
        TOK_107: 'v',
      }),
    )
    expect(settings.scalars.npmRegistryServer).toEqual({
      value: 'https://env',
      source: 'the environment',
      key: 'YARN_NPM_REGISTRY_SERVER',
    })
    expect(settings.scalars.npmAlwaysAuth?.value).toBe('true')
    expect(settings.scalars.npmAuthToken?.value).toBe('v')
    expect(settings.scalars.npmAuthIdent?.value).toBe('d')
  })

  it('leaves out a value whose ${…} fails, as berry fails the run (r18)', () => {
    write(at('parent', 'proj', '.yarnrc.yml'), 'npmAuthToken: "${UNSET_107}"\n')
    write(at('home', '.yarnrc.yml'), 'npmAuthToken: HOME\n')
    expect(
      berrySettings(proj(), sourcesFor()).scalars.npmAuthToken?.value,
    ).toBe('HOME')
  })

  describe('berryRegistryConfig', () => {
    it("uses berry's defaults with no file", () => {
      expect(berryRegistryConfig(proj(), sourcesFor())).toEqual({
        registry: 'https://registry.yarnpkg.com',
        scopedRegistries: {},
        credentials: {},
        berryAuth: {
          top: { alwaysAuth: false },
          scopes: {},
          registries: {},
        },
        releaseAgeGate: {
          setting: 'npmMinimalAgeGate',
          minutes: 1440,
          scopes: {},
          exempt: [],
          missingTime: 'held',
        },
        strictSSL: true,
        proxy: {},
        fetchRetries: 3,
        fetchTimeout: 60_000,
        maxSockets: 50,
      })
    })

    it('routes the default and scopes, and keeps each credential for its rule', () => {
      write(
        at('parent', 'proj', '.yarnrc.yml'),
        [
          'npmRegistryServer: "https://npm.example.com/"',
          'npmAuthToken: T',
          'npmScopes:',
          '  acme:',
          '    npmRegistryServer: "https://acme.example.com"',
          '    npmAuthIdent: "u:p"',
          '  "@other":',
          '    npmAuthToken: O',
          'npmRegistries:',
          '  "//npm.example.com/":',
          '    npmAuthToken: R',
          '    npmAlwaysAuth: true',
          'httpTimeout: 2m',
          'httpRetry: 0',
          'networkConcurrency: 8',
          'enableStrictSsl: false',
          'httpsProxy: "http://proxy.example:3128"',
        ].join('\n'),
      )

      const config = berryRegistryConfig(
        proj(),
        sourcesFor({ HTTPS_PROXY: 'http://ignored.example' }),
      )

      expect(config).toMatchObject({
        registry: 'https://npm.example.com/',
        scopedRegistries: { '@acme': 'https://acme.example.com' },
        berryAuth: {
          top: { token: 'T', alwaysAuth: false },
          scopes: {
            '@acme': { ident: 'u:p', alwaysAuth: false },
            '@other': { token: 'O', alwaysAuth: false },
          },
          registries: {
            '//npm.example.com': { token: 'R', alwaysAuth: true },
          },
        },
        strictSSL: false,
        proxy: { HTTPS_PROXY: 'http://proxy.example:3128' },
        fetchRetries: 0,
        fetchTimeout: 120_000,
        maxSockets: 8,
      })
    })

    it('records an http registry unsafeHttpWhitelist does not list as unusable', () => {
      write(
        at('parent', 'proj', '.yarnrc.yml'),
        [
          'npmRegistryServer: "http://127.0.0.1:4902"',
          'unsafeHttpWhitelist: ["*.internal"]',
          'npmScopes:',
          '  ok:',
          '    npmRegistryServer: "http://npm.corp.internal"',
          '  bad:',
          '    npmRegistryServer: "not a url"',
        ].join('\n'),
      )
      const file = at('parent', 'proj', '.yarnrc.yml')

      const config = berryRegistryConfig(proj(), sourcesFor())

      expect(config.registry).toBe('https://registry.yarnpkg.com')
      expect(config.scopedRegistries).toEqual({
        '@ok': 'http://npm.corp.internal',
      })
      expect(config.unusable).toEqual({
        registry: {
          key: 'npmRegistryServer',
          value: 'http://127.0.0.1:4902/',
          source: file,
          reason:
            'yarn refuses http registries unsafeHttpWhitelist does not list',
        },
        scopes: {
          '@bad': {
            key: 'npmScopes.bad.npmRegistryServer',
            value: '(value not shown)',
            source: file,
            reason: 'it is not a valid URL',
          },
        },
      })
    })

    // #166: yarn 4.18.1, probed 2026-11-03 with `yarn install` against a
    // local registry with set publish times.
    it("reads npmMinimalAgeGate in minutes, and a configured scope's own, one day by default", () => {
      write(
        at('parent', 'proj', '.yarnrc.yml'),
        [
          'npmMinimalAgeGate: 0',
          'npmScopes:',
          '  acme:',
          '    npmRegistryServer: "https://acme.example.com"',
          '  fast:',
          '    npmMinimalAgeGate: 2h',
          'npmPreapprovedPackages: ["p-exempt"]',
        ].join('\n'),
      )
      write(
        at('home', '.yarnrc.yml'),
        'npmPreapprovedPackages:\n  - "@acme/*@^1.0.0"\n',
      )

      expect(berryRegistryConfig(proj(), sourcesFor()).releaseAgeGate).toEqual({
        setting: 'npmMinimalAgeGate',
        minutes: 0,
        scopes: { '@acme': 1440, '@fast': 120 },
        exempt: [
          { name: '@acme/*', glob: 'segment', versions: '^1.0.0' },
          { name: 'p-exempt', glob: 'segment' },
        ],
        missingTime: 'held',
      })
    })

    it('reads YARN_NPM_MINIMAL_AGE_GATE, and keeps the default for a value berry cannot parse', () => {
      expect(
        berryRegistryConfig(
          proj(),
          sourcesFor({ YARN_NPM_MINIMAL_AGE_GATE: '30' }),
        ).releaseAgeGate?.minutes,
      ).toBe(30)
      write(at('parent', 'proj', '.yarnrc.yml'), 'npmMinimalAgeGate: "1 day"\n')
      expect(
        berryRegistryConfig(proj(), sourcesFor()).releaseAgeGate?.minutes,
      ).toBe(1440)
    })

    it('reads httpsCaFilePath relative to the file that sets it', () => {
      fs.writeFileSync(at('parent', 'ca.pem'), readTls('ca.pem'))
      write(at('parent', '.yarnrc.yml'), 'httpsCaFilePath: ./ca.pem\n')
      expect(berryRegistryConfig(proj(), sourcesFor()).ca).toEqual([
        readTls('ca.pem').trim(),
      ])
    })
  })
})
