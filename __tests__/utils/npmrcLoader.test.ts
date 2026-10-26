import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadNpmrc,
  loadRegistryConfig,
  type NpmrcSources,
  npmrcBoolean,
} from '@/utils/npmrcLoader'

describe('npmrc loader', () => {
  let tmp: string

  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  const sourcesFor = (
    env: NodeJS.ProcessEnv = {},
    overrides: Partial<NpmrcSources> = {},
  ): NpmrcSources => ({
    env,
    home: at('home'),
    // Node's own layout, so npm's default prefix is <tmp>/prefix on both:
    // node.exe sits in the prefix on Windows, in <prefix>/bin elsewhere.
    execPath:
      process.platform === 'win32'
        ? path.join(tmp, 'prefix', 'node.exe')
        : path.join(tmp, 'prefix', 'bin', 'node'),
    platform: process.platform,
    ...overrides,
  })

  const globalFile = () => at('prefix', 'etc', 'npmrc')
  const userFile = () => at('home', '.npmrc')

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npmrc-')))
    write(at('proj', 'package.json'), '{}')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('loadNpmrc', () => {
    it('is empty when no .npmrc exists', () => {
      expect({ ...loadNpmrc(at('proj'), sourcesFor()) }).toEqual({})
    })

    it('reads each layer', () => {
      write(globalFile(), 'g=1')
      write(userFile(), 'u=1')
      write(at('proj', '.npmrc'), 'p=1')

      expect({
        ...loadNpmrc(at('proj'), sourcesFor({ npm_config_e: '1' })),
      }).toEqual({ g: '1', u: '1', p: '1', e: '1' })
    })

    it('lets env beat project, project beat user, user beat global', () => {
      write(globalFile(), 'key=global\nonlyGlobal=g')
      write(userFile(), 'key=user\nonlyUser=u')
      write(at('proj', '.npmrc'), 'key=project\nonlyProject=p')

      const read = (env: NodeJS.ProcessEnv) =>
        loadNpmrc(at('proj'), sourcesFor(env)).key
      expect(read({ npm_config_key: 'env' })).toBe('env')
      expect(read({})).toBe('project')

      fs.rmSync(at('proj', '.npmrc'))
      expect(read({})).toBe('user')

      fs.rmSync(userFile())
      expect(read({})).toBe('global')
    })

    it('treats an unreadable file as an empty layer', () => {
      fs.mkdirSync(at('proj', '.npmrc'))
      write(userFile(), 'u=1')

      expect({ ...loadNpmrc(at('proj'), sourcesFor()) }).toEqual({ u: '1' })
    })

    it('keeps an unset ${VAR} literal and substitutes a set one', () => {
      write(
        at('proj', '.npmrc'),
        'a=${NOPE}\nb=${SET}\n//r.example/:_authToken=${SET}',
      )

      const npmrc = loadNpmrc(at('proj'), sourcesFor({ SET: 'yes' }))

      expect(npmrc.a).toBe('${NOPE}')
      expect(npmrc.b).toBe('yes')
      expect(npmrc['//r.example/:_authToken']).toBe('yes')
    })

    describe('npm_config_* variables', () => {
      it('reads any case, skips empty values and dashes underscores', () => {
        const npmrc = loadNpmrc(
          at('proj'),
          sourcesFor({
            NPM_CONFIG_STRICT_SSL: 'false',
            npm_config_save_prefix: '~',
            Npm_Config_Fetch_Retries: '4',
            npm_config_empty: '',
          }),
        )

        expect({ ...npmrc }).toEqual({
          'strict-ssl': 'false',
          'save-prefix': '~',
          'fetch-retries': '4',
        })
      })

      it('keeps a leading underscore and // keys as written', () => {
        const npmrc = loadNpmrc(
          at('proj'),
          sourcesFor({
            'npm_config_//registry.example.com/:_authToken': 'tok',
            npm_config__auth: 'abc',
          }),
        )

        expect({ ...npmrc }).toEqual({
          '//registry.example.com/:_authToken': 'tok',
          _auth: 'abc',
        })
      })

      it('substitutes ${VAR} in values', () => {
        const npmrc = loadNpmrc(
          at('proj'),
          sourcesFor({ npm_config_registry: '${HOST}/', HOST: 'https://h' }),
        )

        expect(npmrc.registry).toBe('https://h/')
      })
    })

    describe('the project root', () => {
      it('walks up from a subdirectory to the package.json', () => {
        write(at('proj', '.npmrc'), 'k=proj')
        fs.mkdirSync(at('proj', 'src', 'deep'), { recursive: true })

        expect(loadNpmrc(at('proj', 'src', 'deep'), sourcesFor()).k).toBe(
          'proj',
        )
      })

      it('accepts a node_modules directory as the marker', () => {
        fs.mkdirSync(at('bare', 'node_modules'), { recursive: true })
        fs.mkdirSync(at('bare', 'src'), { recursive: true })
        write(at('bare', '.npmrc'), 'k=bare')

        expect(loadNpmrc(at('bare', 'src'), sourcesFor()).k).toBe('bare')
      })

      it('uses the directory itself when nothing marks a project', () => {
        write(at('loose', '.npmrc'), 'k=loose')

        expect(loadNpmrc(at('loose'), sourcesFor()).k).toBe('loose')
      })

      describe('from a workspace member', () => {
        const member = () => at('ws', 'packages', 'a')

        beforeEach(() => {
          write(at('ws', '.npmrc'), 'k=root')
          write(at('ws', 'packages', 'a', '.npmrc'), 'k=member')
          write(at('ws', 'packages', 'a', 'package.json'), '{"name":"a"}')
        })

        it('reads the root .npmrc and ignores the member one', () => {
          write(
            at('ws', 'package.json'),
            JSON.stringify({ workspaces: ['packages/*'] }),
          )

          expect(loadNpmrc(member(), sourcesFor()).k).toBe('root')
        })

        it('reads the object form of workspaces', () => {
          write(
            at('ws', 'package.json'),
            JSON.stringify({ workspaces: { packages: ['packages/*'] } }),
          )

          expect(loadNpmrc(member(), sourcesFor()).k).toBe('root')
        })

        it('matches a packages/** pattern against a nested member', () => {
          write(
            at('ws', 'package.json'),
            JSON.stringify({ workspaces: ['packages/**'] }),
          )
          write(at('ws', 'packages', 'team', 'b', 'package.json'), '{}')
          write(at('ws', 'packages', 'team', 'b', '.npmrc'), 'k=nested')

          expect(
            loadNpmrc(at('ws', 'packages', 'team', 'b'), sourcesFor()).k,
          ).toBe('root')
        })

        it('does not treat a matching directory without a package.json as a member', () => {
          write(
            at('ws', 'package.json'),
            JSON.stringify({ workspaces: ['packages/*'] }),
          )
          write(at('ws', 'packages', 'bare', 'node_modules', 'x', 'y'), '')
          write(at('ws', 'packages', 'bare', '.npmrc'), 'k=bare')

          expect(loadNpmrc(at('ws', 'packages', 'bare'), sourcesFor()).k).toBe(
            'bare',
          )
        })

        it('honors a negated pattern', () => {
          write(
            at('ws', 'package.json'),
            JSON.stringify({ workspaces: ['packages/*', '!packages/a'] }),
          )

          expect(loadNpmrc(member(), sourcesFor()).k).toBe('member')
        })

        it('uses the member .npmrc when the parent has no workspaces field', () => {
          write(at('ws', 'package.json'), '{}')

          expect(loadNpmrc(member(), sourcesFor()).k).toBe('member')
        })

        it('uses the member .npmrc when the parent does not list it', () => {
          write(
            at('ws', 'package.json'),
            JSON.stringify({ workspaces: ['other/*'] }),
          )

          expect(loadNpmrc(member(), sourcesFor()).k).toBe('member')
        })
      })
    })

    describe('the user config', () => {
      it('skips a project .npmrc that is the user config', () => {
        // Read as a project file, its userconfig line would redirect the user
        // layer to `other`; skipped, it is the user layer itself.
        write(at('home', 'package.json'), '{}')
        write(userFile(), `k=user\nuserconfig=${JSON.stringify(at('other'))}`)
        write(at('other'), 'k=other')

        expect(loadNpmrc(at('home'), sourcesFor()).k).toBe('user')
      })

      it('reads npm_config_userconfig instead of ~/.npmrc', () => {
        write(userFile(), 'k=home')
        write(at('elsewhere', 'rc'), 'k=elsewhere')

        const sources = sourcesFor({
          npm_config_userconfig: at('elsewhere', 'rc'),
        })

        expect(loadNpmrc(at('proj'), sources).k).toBe('elsewhere')
      })

      it('reads a userconfig set in the project .npmrc', () => {
        write(userFile(), 'k=home')
        write(at('elsewhere', 'rc'), 'k=elsewhere')
        write(
          at('proj', '.npmrc'),
          `userconfig=${JSON.stringify(at('elsewhere', 'rc'))}`,
        )

        expect(loadNpmrc(at('proj'), sourcesFor()).k).toBe('elsewhere')
      })

      it('resolves a relative userconfig against cwd and ~/ against home', () => {
        write(at('proj', 'rc'), 'k=relative')
        write(at('home', 'custom'), 'k=tilde')

        expect(
          loadNpmrc(at('proj'), sourcesFor({ npm_config_userconfig: 'rc' })).k,
        ).toBe('relative')
        expect(
          loadNpmrc(
            at('proj'),
            sourcesFor({ npm_config_userconfig: '~/custom' }),
          ).k,
        ).toBe('tilde')
      })
    })

    describe('the global config', () => {
      it('reads <PREFIX>/etc/npmrc', () => {
        write(at('custom', 'etc', 'npmrc'), 'k=prefix')

        const sources = sourcesFor({ PREFIX: at('custom') })

        expect(loadNpmrc(at('proj'), sources).k).toBe('prefix')
      })

      it('derives the prefix from execPath on posix: two directories up', () => {
        write(path.join(tmp, 'usr', 'etc', 'npmrc'), 'k=posix')

        const sources = sourcesFor(
          {},
          {
            platform: 'linux',
            execPath: path.join(tmp, 'usr', 'bin', 'node'),
          },
        )

        expect(loadNpmrc(at('proj'), sources).k).toBe('posix')
      })

      it('derives the prefix from execPath on win32: one directory up', () => {
        write(path.join(tmp, 'node', 'etc', 'npmrc'), 'k=win')

        const sources = sourcesFor(
          {},
          { platform: 'win32', execPath: path.join(tmp, 'node', 'node.exe') },
        )

        expect(loadNpmrc(at('proj'), sources).k).toBe('win')
      })

      it('ignores an empty PREFIX', () => {
        write(globalFile(), 'k=exec')

        expect(loadNpmrc(at('proj'), sourcesFor({ PREFIX: '' })).k).toBe('exec')
      })

      it('puts the default globalconfig under a prefix set in the user .npmrc', () => {
        write(at('custom', 'etc', 'npmrc'), 'k=from-prefix')
        write(globalFile(), 'k=exec')
        write(userFile(), `prefix=${JSON.stringify(at('custom'))}`)

        expect(loadNpmrc(at('proj'), sourcesFor()).k).toBe('from-prefix')
      })

      it('lets npm_config_prefix beat the project, user and PREFIX', () => {
        write(at('env', 'etc', 'npmrc'), 'k=env')
        write(at('custom', 'etc', 'npmrc'), 'k=user')
        write(userFile(), `prefix=${JSON.stringify(at('custom'))}`)

        const sources = sourcesFor({
          npm_config_prefix: at('env'),
          PREFIX: at('other'),
        })

        expect(loadNpmrc(at('proj'), sources).k).toBe('env')
      })

      it('reads a prefix set in the project .npmrc, as npm does', () => {
        write(at('custom', 'etc', 'npmrc'), 'k=project')
        write(at('proj', '.npmrc'), `prefix=${JSON.stringify(at('custom'))}`)

        expect(loadNpmrc(at('proj'), sourcesFor()).k).toBe('project')
      })

      describe("npm's builtin npmrc", () => {
        it('is the lowest layer on posix, under <prefix>/lib/node_modules/npm', () => {
          write(
            path.join(tmp, 'usr', 'lib', 'node_modules', 'npm', 'npmrc'),
            'k=builtin\nonly-builtin=yes',
          )
          write(path.join(tmp, 'usr', 'etc', 'npmrc'), 'k=global')

          const config = loadNpmrc(
            at('proj'),
            sourcesFor(
              {},
              {
                platform: 'linux',
                execPath: path.join(tmp, 'usr', 'bin', 'node'),
              },
            ),
          )

          expect(config.k).toBe('global')
          expect(config['only-builtin']).toBe('yes')
        })

        it('sits beside node.exe on win32', () => {
          write(
            path.join(tmp, 'node', 'node_modules', 'npm', 'npmrc'),
            'only-builtin=win',
          )

          const config = loadNpmrc(
            at('proj'),
            sourcesFor(
              {},
              {
                platform: 'win32',
                execPath: path.join(tmp, 'node', 'node.exe'),
              },
            ),
          )

          expect(config['only-builtin']).toBe('win')
        })

        it('can point globalconfig elsewhere, as Debian does', () => {
          write(
            path.join(tmp, 'usr', 'lib', 'node_modules', 'npm', 'npmrc'),
            `globalconfig=${JSON.stringify(at('etc', 'npmrc'))}`,
          )
          write(at('etc', 'npmrc'), 'k=debian')
          write(path.join(tmp, 'usr', 'etc', 'npmrc'), 'k=default')

          const config = loadNpmrc(
            at('proj'),
            sourcesFor(
              {},
              {
                platform: 'linux',
                execPath: path.join(tmp, 'usr', 'bin', 'node'),
              },
            ),
          )

          expect(config.k).toBe('debian')
        })
      })

      it('reads npm_config_globalconfig', () => {
        write(globalFile(), 'k=default')
        write(at('g', 'rc'), 'k=custom')

        const sources = sourcesFor({ npm_config_globalconfig: at('g', 'rc') })

        expect(loadNpmrc(at('proj'), sources).k).toBe('custom')
      })

      it('reads a globalconfig set in the user .npmrc', () => {
        write(at('g', 'rc'), 'k=custom')
        write(userFile(), `globalconfig=${JSON.stringify(at('g', 'rc'))}`)

        expect(loadNpmrc(at('proj'), sourcesFor()).k).toBe('custom')
      })
    })
  })

  describe('npmrcBoolean', () => {
    it('reads booleans and their string forms', () => {
      expect(npmrcBoolean(true)).toBe(true)
      expect(npmrcBoolean('false')).toBe(false)
      expect(npmrcBoolean('true')).toBe(true)
    })

    it('is undefined for anything else', () => {
      expect(npmrcBoolean('yes')).toBeUndefined()
      expect(npmrcBoolean(undefined)).toBeUndefined()
      expect(npmrcBoolean(['true'])).toBeUndefined()
      expect(npmrcBoolean(null)).toBeUndefined()
    })
  })

  describe('loadRegistryConfig', () => {
    const load = (npmrc: string, env: NodeJS.ProcessEnv = {}) => {
      write(at('proj', '.npmrc'), npmrc)
      return loadRegistryConfig(at('proj'), sourcesFor(env))
    }

    it('uses npm defaults when no .npmrc files exist', () => {
      expect(loadRegistryConfig(at('proj'), sourcesFor())).toEqual({
        registry: 'https://registry.npmjs.org/',
        scopedRegistries: {},
        credentials: {},
        ca: undefined,
        strictSSL: true,
        proxy: {},
        fetchRetries: 2,
        fetchTimeout: 300_000,
        maxSockets: 15,
      })
    })

    it('reads registry, scoped registry, and credentials from the project .npmrc', () => {
      const config = load(
        [
          'registry=https://registry.example.com/',
          '@my-org:registry=https://npm.my-org.dev/',
          '//registry.example.com/:_authToken=abc123',
        ].join('\n'),
      )

      expect(config.registry).toBe('https://registry.example.com/')
      expect(config.scopedRegistries).toEqual({
        '@my-org': 'https://npm.my-org.dev/',
      })
      expect(config.credentials).toEqual({
        '//registry.example.com/': { authToken: 'abc123' },
      })
    })

    it('substitutes ${VAR} env references inside values', () => {
      const config = load('//registry.example.com/:_authToken=${MY_TOKEN}', {
        MY_TOKEN: 'super-secret',
      })

      expect(config.credentials['//registry.example.com/']?.authToken).toBe(
        'super-secret',
      )
    })

    it('lets npm_config_* env vars override file config', () => {
      const config = load('registry=https://from-file.example/', {
        npm_config_registry: 'https://from-env.example/',
      })

      expect(config.registry).toBe('https://from-env.example/')
    })

    it('groups every credential field by its prefix, keeping a port in the prefix', () => {
      const config = load(
        [
          '//host.test:8443/npm/:_auth=dXNlcjpwYXNz',
          '//host.test:8443/npm/:username=user',
          '//host.test:8443/npm/:_password=cGFzcw==',
          '//host.test/:certfile=certs/c.pem',
          '//host.test/:keyfile=certs/k.pem',
        ].join('\n'),
      )

      expect(config.credentials).toEqual({
        '//host.test:8443/npm/': {
          auth: 'dXNlcjpwYXNz',
          username: 'user',
          password: 'cGFzcw==',
        },
        '//host.test/': {
          certfile: path.resolve(at('proj'), 'certs/c.pem'),
          keyfile: path.resolve(at('proj'), 'certs/k.pem'),
        },
      })
    })

    it('ignores unscoped credentials, non-string values and other keys', () => {
      const config = load(
        [
          '_authToken=unscoped',
          'always-auth=true',
          '//host.test/:_authToken',
          '//host.test/:email=a@b.test',
          'auto-install-peers=true',
        ].join('\n'),
      )

      expect(config.credentials).toEqual({})
      expect(config.scopedRegistries).toEqual({})
    })

    it('falls back to the public registry for an empty or unparsable registry', () => {
      expect(load('registry=').registry).toBe('https://registry.npmjs.org/')
      expect(load('registry=${REG?}', {}).registry).toBe(
        'https://registry.npmjs.org/',
      )
      expect(load('registry=${REG}').registry).toBe(
        'https://registry.npmjs.org/',
      )
      expect(load('registry=not a url').registry).toBe(
        'https://registry.npmjs.org/',
      )
    })

    it('ignores an empty or invalid scoped registry', () => {
      expect(
        load('@a:registry=\n@b:registry=${NOPE}\n@c:registry=https://c.test/')
          .scopedRegistries,
      ).toEqual({ '@c': 'https://c.test/' })
    })

    it('treats a credential with an unexpanded ${VAR} as absent', () => {
      const config = load(
        [
          '//a.test/:_authToken=${NPM_TOKEN}',
          '//b.test/:_auth=${A}',
          '//c.test/:username=${U}',
          '//c.test/:_password=${P}',
          '//d.test/:_authToken=real',
        ].join('\n'),
      )

      expect(config.credentials).toEqual({
        '//d.test/': { authToken: 'real' },
      })
    })

    it('does not read inherited object members as credential fields', () => {
      const config = load(
        '//a.test/:constructor=x\n//a.test/:toString=y\n//a.test/:__proto__=z',
      )

      expect(config.credentials).toEqual({})
    })

    it('clamps a huge fetch-timeout to the largest timer value', () => {
      expect(load('fetch-timeout=99999999999').fetchTimeout).toBe(2 ** 31 - 1)
    })

    it('reads strict-ssl as a boolean', () => {
      expect(load('strict-ssl=false').strictSSL).toBe(false)
      expect(load('strict-ssl=true').strictSSL).toBe(true)
    })

    describe('ca', () => {
      it('reads ca as a one-element list', () => {
        expect(load('ca=PEM').ca).toEqual(['PEM'])
      })

      it('reads ca[] and drops non-strings', () => {
        expect(load('ca[]=ONE\nca[]=TWO\nca[]').ca).toEqual(['ONE', 'TWO'])
      })

      it('treats an empty ca as unset, so Node keeps its default trust store', () => {
        expect(load('ca=').ca).toBeUndefined()
        expect(load('ca=""').ca).toBeUndefined()
        expect(load('ca[]=').ca).toBeUndefined()
      })

      it('drops an empty ca[] element and keeps the rest', () => {
        expect(load('ca[]=\nca[]=PEM').ca).toEqual(['PEM'])
      })

      it('treats an empty cafile as unset', () => {
        expect(load('cafile=\nca=PEM').ca).toEqual(['PEM'])
      })

      it('splits a cafile bundle into certificates, and it beats ca', () => {
        const end = '-----END CERTIFICATE-----'
        write(
          at('proj', 'bundle.pem'),
          `-----BEGIN CERTIFICATE-----\r\nA\r\n${end}\r\n\r\n-----BEGIN CERTIFICATE-----\r\nB\r\n${end}\r\n`,
        )

        expect(
          load(`cafile=${JSON.stringify('bundle.pem')}\nca=IGNORED`).ca,
        ).toEqual([
          `-----BEGIN CERTIFICATE-----\nA\n${end}`,
          `-----BEGIN CERTIFICATE-----\nB\n${end}`,
        ])
      })

      it('falls back to ca when the cafile is missing', () => {
        expect(load('cafile=missing.pem\nca=PEM').ca).toEqual(['PEM'])
      })

      it('resolves ~/ in cafile against the home directory', () => {
        write(at('home', 'ca.pem'), 'X-----END CERTIFICATE-----\n')

        expect(load('cafile="~/ca.pem"').ca).toEqual([
          'X-----END CERTIFICATE-----',
        ])
      })
    })

    describe('proxy', () => {
      it('is empty without settings', () => {
        expect(load('').proxy).toEqual({})
      })

      it('uses https-proxy for both protocols, ahead of proxy and the environment', () => {
        expect(
          load('https-proxy=http://a.test:1\nproxy=http://b.test:2', {
            HTTPS_PROXY: 'http://env.test:3',
          }).proxy,
        ).toEqual({
          HTTPS_PROXY: 'http://a.test:1',
          HTTP_PROXY: 'http://a.test:1',
        })
        expect(load('proxy=http://b.test:2').proxy).toEqual({
          HTTPS_PROXY: 'http://b.test:2',
          HTTP_PROXY: 'http://b.test:2',
        })
      })

      it('falls back to the environment, lower case first', () => {
        expect(
          load('', {
            https_proxy: 'http://lower.test',
            HTTPS_PROXY: 'http://upper.test',
            HTTP_PROXY: 'http://http-upper.test',
          }).proxy,
        ).toEqual({
          HTTPS_PROXY: 'http://lower.test',
          HTTP_PROXY: 'http://lower.test',
        })
      })

      it("gives an http registry npm's order: https_proxy, http_proxy, proxy", () => {
        expect(
          load('', {
            HTTP_PROXY: 'http://hu.test',
            http_proxy: 'http://hl.test',
          }).proxy,
        ).toEqual({ HTTP_PROXY: 'http://hl.test' })
        expect(load('', { HTTP_PROXY: 'http://hu.test' }).proxy).toEqual({
          HTTP_PROXY: 'http://hu.test',
        })
        expect(load('', { proxy: 'http://p.test' }).proxy).toEqual({
          HTTP_PROXY: 'http://p.test',
        })
        expect(
          load('', {
            HTTPS_PROXY: 'http://hs.test',
            http_proxy: 'http://h.test',
          }).proxy,
        ).toEqual({
          HTTPS_PROXY: 'http://hs.test',
          HTTP_PROXY: 'http://hs.test',
        })
      })

      it('treats an empty https-proxy as unset, falling to proxy and the environment', () => {
        expect(load('https-proxy=\nproxy=http://b.test:2').proxy).toEqual({
          HTTPS_PROXY: 'http://b.test:2',
          HTTP_PROXY: 'http://b.test:2',
        })
        expect(
          load('https-proxy=\nproxy=', { HTTPS_PROXY: 'http://env.test' })
            .proxy,
        ).toEqual({
          HTTPS_PROXY: 'http://env.test',
          HTTP_PROXY: 'http://env.test',
        })
        expect(
          load('', { https_proxy: '', HTTPS_PROXY: 'http://env.test' }).proxy
            .HTTPS_PROXY,
        ).toBe('http://env.test')
      })

      it('treats an empty noproxy as unset, falling to NO_PROXY', () => {
        expect(load('noproxy=', { NO_PROXY: 'env.test' }).proxy.NO_PROXY).toBe(
          'env.test,.env.test',
        )
        expect(
          load('noproxy[]=', { NO_PROXY: 'env.test' }).proxy.NO_PROXY,
        ).toBe('env.test,.env.test')
        expect(
          load('', { no_proxy: '', NO_PROXY: 'env.test' }).proxy.NO_PROXY,
        ).toBe('env.test,.env.test')
      })

      it('widens each bare noproxy host to match its subdomains', () => {
        expect(
          load('noproxy=example.test, .corp.test,*.lan').proxy.NO_PROXY,
        ).toBe('example.test,.example.test,.corp.test,*.lan')
      })

      it('joins noproxy[] entries', () => {
        expect(load('noproxy[]=a.test\nnoproxy[]=b.test').proxy.NO_PROXY).toBe(
          'a.test,.a.test,b.test,.b.test',
        )
      })

      it('reads NO_PROXY from the environment when .npmrc has none, lower case first', () => {
        expect(load('', { NO_PROXY: 'a.test' }).proxy.NO_PROXY).toBe(
          'a.test,.a.test',
        )
        expect(
          load('', { no_proxy: 'low.test', NO_PROXY: 'up.test' }).proxy
            .NO_PROXY,
        ).toBe('low.test,.low.test')
      })

      it('lets .npmrc noproxy override the environment', () => {
        expect(
          load('noproxy=mine.test', { NO_PROXY: 'env.test' }).proxy.NO_PROXY,
        ).toBe('mine.test,.mine.test')
      })
    })

    describe('numbers', () => {
      it('reads fetch-retries and maxsockets', () => {
        const config = load('fetch-retries=0\nmaxsockets=3')

        expect(config.fetchRetries).toBe(0)
        expect(config.maxSockets).toBe(3)
      })

      it('falls back to the defaults for invalid values', () => {
        const config = load(
          'fetch-retries=-1\nmaxsockets=0\nfetch-timeout=soon',
        )

        expect(config.fetchRetries).toBe(2)
        expect(config.maxSockets).toBe(15)
        expect(config.fetchTimeout).toBe(300_000)
      })

      it('reads fetch-timeout, where 0 means 30 seconds', () => {
        expect(load('fetch-timeout=1500').fetchTimeout).toBe(1500)
        expect(load('fetch-timeout=0').fetchTimeout).toBe(30_000)
      })
    })
  })
})
