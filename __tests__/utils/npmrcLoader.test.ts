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
    execPath: path.join(tmp, 'prefix', 'bin', 'node'),
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
    it('falls back to the public registry when no .npmrc files exist', () => {
      const config = loadRegistryConfig(at('proj'), sourcesFor())

      expect(config.registry).toBe('https://registry.npmjs.org/')
      expect(config.scopedRegistries).toEqual({})
      expect(config.authTokens).toEqual({})
    })

    it('reads registry, scoped registry, and auth from the project .npmrc', () => {
      write(
        at('proj', '.npmrc'),
        [
          'registry=https://registry.example.com/',
          '@my-org:registry=https://npm.my-org.dev/',
          '//registry.example.com/:_authToken=abc123',
        ].join('\n'),
      )

      const config = loadRegistryConfig(at('proj'), sourcesFor())

      expect(config.registry).toBe('https://registry.example.com/')
      expect(config.scopedRegistries).toEqual({
        '@my-org': 'https://npm.my-org.dev/',
      })
      expect(config.authTokens).toEqual({ 'registry.example.com': 'abc123' })
    })

    it('substitutes ${VAR} env references inside values', () => {
      write(
        at('proj', '.npmrc'),
        '//registry.example.com/:_authToken=${MY_TOKEN}',
      )

      const config = loadRegistryConfig(
        at('proj'),
        sourcesFor({ MY_TOKEN: 'super-secret' }),
      )

      expect(config.authTokens['registry.example.com']).toBe('super-secret')
    })

    it('lets npm_config_* env vars override file config', () => {
      write(at('proj', '.npmrc'), 'registry=https://from-file.example/')

      const config = loadRegistryConfig(
        at('proj'),
        sourcesFor({ npm_config_registry: 'https://from-env.example/' }),
      )

      expect(config.registry).toBe('https://from-env.example/')
    })

    it('parses always-auth and strict-ssl as booleans', () => {
      write(at('proj', '.npmrc'), 'always-auth=true\nstrict-ssl=false')

      const config = loadRegistryConfig(at('proj'), sourcesFor())

      expect(config.alwaysAuth).toBe(true)
      expect(config.strictSSL).toBe(false)
    })

    it('reads ca and cafile', () => {
      write(at('proj', '.npmrc'), 'ca=PEM\ncafile=/etc/ca.pem')

      const config = loadRegistryConfig(at('proj'), sourcesFor())

      expect(config.ca).toBe('PEM')
      expect(config.cafile).toBe('/etc/ca.pem')
    })

    it('handles auth tokens for nested registry paths', () => {
      write(
        at('proj', '.npmrc'),
        '//npm.pkg.github.com/scope/:_authToken=ghp_xxx',
      )

      const config = loadRegistryConfig(at('proj'), sourcesFor())

      expect(config.authTokens).toEqual({
        'npm.pkg.github.com/scope': 'ghp_xxx',
      })
    })

    it('ignores keys it does not recognize', () => {
      write(
        at('proj', '.npmrc'),
        'registry=https://r.example/\nauto-install-peers=true\nsave-exact=true',
      )

      const config = loadRegistryConfig(at('proj'), sourcesFor())

      expect(config.registry).toBe('https://r.example/')
      expect(config.scopedRegistries).toEqual({})
      expect(config.authTokens).toEqual({})
    })
  })
})
