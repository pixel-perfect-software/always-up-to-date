import { build, type Metafile } from 'esbuild'
import fs from 'fs'
import path from 'path'
import {
  checkExternals,
  checkStartup,
  dependencyNames,
  GuardError,
  OUTFILE,
  type Output,
  packageOf,
  writeLicenses,
} from '../../scripts/guards'
import { tempDir } from '../fixtures/files'

// The checks scripts/build.mts runs on its bundle, on metafiles esbuild wrote
// for small projects in temp directories, never on hand-written ones.

type Files = Record<string, string>

let tmp: string

beforeEach(() => {
  tmp = tempDir('autd-guards-', { real: true })
})

const write = (files: Files) => {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(tmp, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}

/**
 * A package under node_modules/, flat or laid out as pnpm does: the files in
 * `node_modules/.pnpm/<name>@<version>/node_modules/<name>/`, linked from
 * `node_modules/<name>`, which esbuild resolves through.
 */
function installPackage(
  name: string,
  {
    pnpm = false,
    manifest = { name, version: '1.0.0', license: 'MIT' },
    files = {},
  }: { pnpm?: boolean; manifest?: object; files?: Files } = {},
): void {
  const dir = pnpm
    ? `node_modules/.pnpm/${name.replace('/', '+')}@1.0.0/node_modules/${name}`
    : `node_modules/${name}`
  write({
    [`${dir}/package.json`]: JSON.stringify(manifest),
    [`${dir}/index.js`]: 'module.exports = {}',
    ...Object.fromEntries(
      Object.entries(files).map(([file, content]) => [
        `${dir}/${file}`,
        content,
      ]),
    ),
  })
  if (pnpm) {
    const link = path.join(tmp, 'node_modules', name)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(path.join(tmp, dir), link, 'junction')
  }
}

/** esbuild's metafile for the project, built the way scripts/build.mts builds. */
async function bundle(external: string[] = []): Promise<Metafile> {
  const { metafile } = await build({
    absWorkingDir: tmp,
    entryPoints: ['src/index.ts'],
    outfile: OUTFILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
    logLevel: 'silent',
    external,
  })
  return metafile
}

const outputOf = (metafile: Metafile): Output => {
  const output = metafile.outputs[OUTFILE]
  if (!output) throw new Error(`the metafile has no ${OUTFILE}`)
  return output
}

/** The message of the GuardError `run` throws; fails on any other outcome. */
function guardMessage(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(GuardError)
    return (error as GuardError).message
  }
  throw new Error('expected a GuardError, but nothing was thrown')
}

describe('packageOf', () => {
  it.each([
    [
      'a plain package',
      'node_modules/commander/index.js',
      { name: 'commander', dir: 'node_modules/commander' },
    ],
    [
      'a file deep in a package',
      'node_modules/commander/lib/command.js',
      { name: 'commander', dir: 'node_modules/commander' },
    ],
    [
      'a scoped package',
      'node_modules/@inquirer/prompts/dist/index.js',
      { name: '@inquirer/prompts', dir: 'node_modules/@inquirer/prompts' },
    ],
    [
      "pnpm's layout",
      'node_modules/.pnpm/semver@7.8.6/node_modules/semver/lib/index.js',
      {
        name: 'semver',
        dir: 'node_modules/.pnpm/semver@7.8.6/node_modules/semver',
      },
    ],
    [
      "pnpm's layout for a scoped package",
      'node_modules/.pnpm/@inquirer+prompts@8.7.5/node_modules/@inquirer/prompts/dist/index.js',
      {
        name: '@inquirer/prompts',
        dir: 'node_modules/.pnpm/@inquirer+prompts@8.7.5/node_modules/@inquirer/prompts',
      },
    ],
    [
      'a package nested in another',
      'node_modules/commander/node_modules/semver/index.js',
      {
        name: 'semver',
        dir: 'node_modules/commander/node_modules/semver',
      },
    ],
    [
      'Windows separators',
      'node_modules\\commander\\lib\\command.js',
      { name: 'commander', dir: 'node_modules/commander' },
    ],
    [
      "pnpm's layout with Windows separators",
      'node_modules\\.pnpm\\@inquirer+prompts@8.7.5\\node_modules\\@inquirer\\prompts\\dist\\index.js',
      {
        name: '@inquirer/prompts',
        dir: 'node_modules/.pnpm/@inquirer+prompts@8.7.5/node_modules/@inquirer/prompts',
      },
    ],
  ])('names the package of %s', (_, file, expected) => {
    expect(packageOf(file)).toEqual(expected)
  })

  it('takes the last whole node_modules segment, not a directory ending in one', () => {
    expect(
      packageOf('node_modules/vendor_node_modules/helper/index.js'),
    ).toEqual({
      name: 'vendor_node_modules',
      dir: 'node_modules/vendor_node_modules',
    })
  })

  it.each([
    'src/cli.ts',
    'src\\commands\\check.ts',
    'package.json',
    'src/vendor_node_modules/helper.ts',
  ])('is null for the source file %s', (file) => {
    expect(packageOf(file)).toBeNull()
  })
})

describe('dependencyNames', () => {
  it('lists the names under "dependencies"', () => {
    expect(
      dependencyNames({
        dependencies: { '@inquirer/prompts': '8.7.5' },
        devDependencies: { esbuild: '0.28.2' },
      }),
    ).toEqual(['@inquirer/prompts'])
  })

  it.each([
    ['no dependencies field', { name: 'x' }],
    ['an array', { dependencies: ['x'] }],
    ['a manifest that is not an object', ['dependencies']],
    ['null', null],
  ])('fails on %s', (_, manifest) => {
    expect(guardMessage(() => dependencyNames(manifest))).toBe(
      'package.json has no "dependencies" object.',
    )
  })
})

describe('checkStartup', () => {
  // What `autd --version` loads: index.ts, then cli.ts (a dynamic import of
  // index.ts), the command definitions, the manager names, package.json and
  // commander. check.ts loads its action with import(), and the action
  // imports the pipeline, which is not on the startup list.
  const graph: Files = {
    'package.json': '{"name":"fixture","version":"1.0.0"}',
    'src/index.ts': "import('./cli')",
    'src/cli.ts':
      "import 'commander'\nimport '../package.json'\nimport './commands/index'",
    'src/commands/index.ts': "import './check'",
    'src/commands/check.ts':
      "import './options'\nimport '../managers/names'\nimport('./actions/check')",
    'src/commands/options.ts': 'export const options = []',
    'src/managers/names.ts': "export const names = ['npm']",
    'src/commands/actions/check.ts': "import '../../pipeline'",
    'src/pipeline.ts': "console.log('pipeline')",
  }
  const STARTUP_INPUTS = [
    'src/index.ts',
    'src/cli.ts',
    'src/commands/index.ts',
    'src/commands/check.ts',
    'src/commands/options.ts',
    'src/managers/names.ts',
    'package.json',
    'node_modules/commander/index.js',
  ]
  const CHAIN_TO_OPTIONS =
    'src/cli.ts → src/commands/index.ts → src/commands/check.ts → src/commands/options.ts'

  /** The graph with some files replaced, bundled; commander is installed flat. */
  async function startupMetafile(
    changes: Files = {},
    external: string[] = [],
  ): Promise<Metafile> {
    installPackage('commander')
    write({ ...graph, ...changes })
    return bundle(external)
  }

  /** The first line of the failure: the input and the chain that reaches it. */
  const failure = (metafile: Metafile): string =>
    guardMessage(() => checkStartup(metafile)).split('\n')[0]

  it('reaches the startup sources and commander, and counts them', async () => {
    const metafile = await startupMetafile()

    expect(checkStartup(metafile)).toBe(STARTUP_INPUTS.length)
  })

  it("accepts commander installed in pnpm's layout", async () => {
    installPackage('commander', { pnpm: true })
    write(graph)
    const metafile = await bundle()

    expect(Object.keys(metafile.inputs)).toContain(
      'node_modules/.pnpm/commander@1.0.0/node_modules/commander/index.js',
    )
    expect(checkStartup(metafile)).toBe(STARTUP_INPUTS.length)
  })

  it('does not follow a dynamic import, so the action it loads is not checked', async () => {
    const metafile = await startupMetafile()

    expect(Object.keys(metafile.inputs)).toEqual(
      expect.arrayContaining([
        'src/commands/actions/check.ts',
        'src/pipeline.ts',
      ]),
    )
    expect(checkStartup(metafile)).toBe(STARTUP_INPUTS.length)
  })

  it('does not flag a package left external when a startup source loads it with import()', async () => {
    const metafile = await startupMetafile(
      { 'src/commands/options.ts': "import('@inquirer/prompts')" },
      ['@inquirer/prompts'],
    )

    expect(checkStartup(metafile)).toBe(STARTUP_INPUTS.length)
  })

  it('lets a startup source import a Node builtin', async () => {
    const metafile = await startupMetafile({
      'src/commands/options.ts': "import 'node:fs'\nimport 'path'",
    })

    expect(checkStartup(metafile)).toBe(STARTUP_INPUTS.length)
  })

  it.each([
    ['an import statement', "import '../pipeline'"],
    ['a require call', "require('../pipeline')"],
  ])(
    'fails on a definition that reaches a non-startup source with %s, naming the chain',
    async (_, statement) => {
      const metafile = await startupMetafile({
        'src/commands/options.ts': statement,
      })

      expect(failure(metafile)).toBe(
        `src/pipeline.ts loads at startup: ${CHAIN_TO_OPTIONS} → src/pipeline.ts`,
      )
    },
  )

  it('starts the chain at src/index.ts when the entry itself imports a non-startup source', async () => {
    const metafile = await startupMetafile({
      'src/index.ts': "import('./cli')\nimport './pipeline'",
    })

    expect(failure(metafile)).toBe(
      'src/pipeline.ts loads at startup: src/index.ts → src/pipeline.ts',
    )
  })

  it('fails on a startup source that imports a bundled package other than commander', async () => {
    installPackage('semver')
    const metafile = await startupMetafile({
      'src/commands/options.ts': "import 'semver'",
    })

    expect(failure(metafile)).toBe(
      `node_modules/semver/index.js loads at startup: ${CHAIN_TO_OPTIONS} → node_modules/semver/index.js`,
    )
  })

  it("fails on such a package in pnpm's layout, by the package's name", async () => {
    installPackage('semver', { pnpm: true })
    const metafile = await startupMetafile({
      'src/commands/options.ts': "import 'semver'",
    })

    expect(failure(metafile)).toBe(
      `node_modules/.pnpm/semver@1.0.0/node_modules/semver/index.js loads at startup: ${CHAIN_TO_OPTIONS} → node_modules/.pnpm/semver@1.0.0/node_modules/semver/index.js`,
    )
  })

  it('judges a package nested under commander by its own name', async () => {
    installPackage('commander/node_modules/semver')
    const metafile = await startupMetafile({
      'node_modules/commander/index.js': "require('semver')",
    })

    expect(failure(metafile)).toBe(
      'node_modules/commander/node_modules/semver/index.js loads at startup: src/cli.ts → node_modules/commander/index.js → node_modules/commander/node_modules/semver/index.js',
    )
  })

  it.each([
    ['an import statement', "import '@inquirer/prompts'"],
    ['a require call', "require('@inquirer/prompts')"],
  ])(
    'fails on an external that is not a builtin, loaded with %s',
    async (_, statement) => {
      const metafile = await startupMetafile(
        { 'src/commands/options.ts': statement },
        ['@inquirer/prompts'],
      )

      expect(failure(metafile)).toBe(
        `@inquirer/prompts (not bundled) loads at startup: ${CHAIN_TO_OPTIONS} → @inquirer/prompts`,
      )
    },
  )

  it('fails when src/cli.ts is not in the bundle, because index.ts never loads it', async () => {
    write({ 'src/index.ts': "console.log('no cli')" })
    const metafile = await bundle()

    expect(guardMessage(() => checkStartup(metafile))).toBe(
      'src/cli.ts is not in the bundle, but the startup check starts from it.',
    )
  })
})

describe('checkExternals', () => {
  async function outputWith(
    source: string,
    external: string[],
  ): Promise<Output> {
    write({ 'src/index.ts': source })
    return outputOf(await bundle(external))
  }

  it('accepts a dependency loaded with import(), and Node builtins however they load', async () => {
    const output = await outputWith(
      "import('@inquirer/prompts')\nimport fs from 'node:fs'\nrequire('path')\nconsole.log(fs)",
      ['@inquirer/prompts'],
    )

    expect(() => checkExternals(output, ['@inquirer/prompts'])).not.toThrow()
  })

  it('matches a subpath import to its package, scoped or not', async () => {
    const output = await outputWith(
      "import('@inquirer/prompts/dist/esm')\nimport('lodash/fp')",
      ['@inquirer/prompts', 'lodash'],
    )

    expect(() =>
      checkExternals(output, ['@inquirer/prompts', 'lodash']),
    ).not.toThrow()
  })

  it('fails on an external that is not in "dependencies"', async () => {
    const output = await outputWith("import('left-pad')", ['left-pad'])

    expect(guardMessage(() => checkExternals(output, ['commander']))).toContain(
      'dist/index.js imports left-pad, which is not in "dependencies"',
    )
  })

  it('fails on a package of a scope when only another package of it is a dependency', async () => {
    const output = await outputWith("import('@inquirer/other')", [
      '@inquirer/other',
    ])

    expect(
      guardMessage(() => checkExternals(output, ['@inquirer/prompts'])),
    ).toContain('imports @inquirer/other, which is not in "dependencies"')
  })

  it.each([
    [
      'an import statement',
      "import * as prompts from '@inquirer/prompts'\nconsole.log(prompts)",
    ],
    ['a require call', "console.log(require('@inquirer/prompts'))"],
  ])(
    'fails on a dependency loaded with %s, which runs at startup',
    async (_, source) => {
      const output = await outputWith(source, ['@inquirer/prompts'])

      expect(
        guardMessage(() => checkExternals(output, ['@inquirer/prompts'])),
      ).toContain(
        'dist/index.js loads @inquirer/prompts statically (require-call',
      )
    },
  )
})

describe('writeLicenses', () => {
  const licensesFile = () =>
    fs.readFileSync(path.join(tmp, 'dist/third-party-licenses.txt'), 'utf8')

  /** The output of a bundle of src/index.ts importing the packages. */
  async function outputImporting(...names: string[]): Promise<Output> {
    write({
      'src/index.ts': names.map((name) => `import '${name}'`).join('\n'),
    })
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true })
    return outputOf(await bundle())
  }

  it('writes each package under its heading, ordered by code unit', async () => {
    // localeCompare would put abbrev before JSONStream.
    installPackage('abbrev', {
      manifest: { name: 'abbrev', version: '2.0.0', license: 'ISC' },
      files: { LICENSE: 'ISC text\n' },
    })
    installPackage('JSONStream', {
      pnpm: true,
      manifest: { name: 'JSONStream', version: '1.3.5', license: 'MIT' },
      files: { LICENSE: 'MIT text' },
    })
    const output = await outputImporting('abbrev', 'JSONStream')

    expect(writeLicenses(output, tmp)).toBe(2)
    expect(licensesFile()).toBe(
      [
        'Third-party licenses',
        '',
        'dist/index.js bundles the packages below. Their licenses follow.',
        '',
        'JSONStream 1.3.5 (MIT)',
        '----------------------',
        '',
        'MIT text',
        '',
        '',
        'abbrev 2.0.0 (ISC)',
        '------------------',
        '',
        'ISC text',
        '',
      ].join('\n'),
    )
  })

  it('covers a package once however many of its files are bundled', async () => {
    installPackage('many', {
      files: { LICENSE: 'text', 'other.js': 'module.exports = 2' },
    })
    const output = await outputImporting('many', 'many/other.js')

    expect(writeLicenses(output, tmp)).toBe(1)
  })

  it('carries every license file of a package, whatever the spelling', async () => {
    installPackage('spelled', {
      files: {
        LICENCE: 'british',
        'copying.md': 'gnu',
        'license-MIT': 'mit',
        'README.md': 'not a license',
      },
    })
    const output = await outputImporting('spelled')

    writeLicenses(output, tmp)

    expect(licensesFile()).toContain('british\n\ngnu\n\nmit')
    expect(licensesFile()).not.toContain('not a license')
  })

  it('ignores a directory whose name looks like a license file', async () => {
    installPackage('dirs', {
      files: { LICENSE: 'the notice', 'licenses/MIT.txt': 'in a directory' },
    })
    const output = await outputImporting('dirs')

    expect(writeLicenses(output, tmp)).toBe(1)
    expect(licensesFile()).toContain('the notice')
    expect(licensesFile()).not.toContain('in a directory')
  })

  it('fails on a bundled package with no license file', async () => {
    installPackage('unlicensed', { files: { 'README.md': 'readme' } })
    const output = await outputImporting('unlicensed')

    expect(guardMessage(() => writeLicenses(output, tmp))).toContain(
      'unlicensed is bundled into dist/index.js and has no license file in node_modules/unlicensed.',
    )
  })

  it.each([
    ['no version', { name: 'bad', license: 'MIT' }],
    [
      'a version that is not a string',
      { name: 'bad', version: 1, license: 'MIT' },
    ],
    ['no license', { name: 'bad', version: '1.0.0' }],
    [
      'a license object',
      { name: 'bad', version: '1.0.0', license: { type: 'MIT' } },
    ],
  ])('fails on a bundled package.json with %s', async (_, manifest) => {
    installPackage('bad', { manifest, files: { LICENSE: 'text' } })
    const output = await outputImporting('bad')

    expect(guardMessage(() => writeLicenses(output, tmp))).toBe(
      'node_modules/bad/package.json has no "version" or no "license" string.',
    )
  })
})
