import fs from 'fs'
import path from 'path'
import { readPnpmCatalogs, updatePNPMWorkspaceYAML } from '@/utils/catalogs'
import { nextVersionSpec } from '@/utils/versionSpecs'
import { tempDir } from '../fixtures/files'

// The catalog writer and the one pnpm yaml reader agree on what is writable
// (#230): every catalog entry `parsePnpmYaml` reads, the writer can move.

let cwd: string
beforeEach(() => {
  cwd = tempDir('autd-catalog-writer-')
})

const write = async (
  yaml: string,
  versions: Record<string, string>,
  catalog?: string,
): Promise<string> => {
  const file = path.join(cwd, 'pnpm-workspace.yaml')
  fs.writeFileSync(file, yaml)
  await updatePNPMWorkspaceYAML(cwd, versions, undefined, catalog)
  return fs.readFileSync(file, 'utf8')
}

describe('a flow-map catalog', () => {
  it('moves the default catalog in place, keeping spacing, quotes, an exact pin and a comment', async () => {
    const yaml = [
      'packages: [packages/*]',
      `catalog: {react: ^18.0.0,  "ms": '2.1.1' , lodash: ~4.17.0 } # pinned`,
      'overrides: { ms: 2.1.1 }',
      '',
    ].join('\n')
    expect(await write(yaml, { react: '19.2.0', ms: '2.1.3' })).toBe(
      [
        'packages: [packages/*]',
        `catalog: {react: ^19.2.0,  "ms": '2.1.3' , lodash: ~4.17.0 } # pinned`,
        'overrides: { ms: 2.1.1 }',
        '',
      ].join('\n'),
    )
  })

  it('moves only the named catalog asked for, among block and flow ones', async () => {
    const yaml = [
      'catalogs:',
      '  react18: { react: ^18.0.0, react-dom: ^18.0.0 }',
      '  react19:',
      '    react: ^19.0.0',
      '  tools: &t { react: ~18.1.0 }',
      '',
    ].join('\n')
    expect(await write(yaml, { react: '18.3.1' }, 'react18')).toBe(
      yaml.replace('{ react: ^18.0.0,', '{ react: ^18.3.1,'),
    )
    expect(await write(yaml, { react: '18.3.1' }, 'tools')).toBe(
      yaml.replace('{ react: ~18.1.0 }', '{ react: ~18.3.1 }'),
    )
  })

  it('moves an anchored default catalog', async () => {
    expect(await write('catalog: &c { ms: ^2.1.1 }\n', { ms: '3.0.0' })).toBe(
      'catalog: &c { ms: ^3.0.0 }\n',
    )
  })

  it('writes a multi-comparator spec in the save style and keeps it whole', async () => {
    expect(
      await write('catalog: { ms: ">=2.1.1 <3", dayjs: 1.x }\n', {
        ms: '3.0.0',
        dayjs: '2.0.0',
      }),
    ).toBe('catalog: { ms: "^3.0.0", dayjs: ^2.0.0 }\n')
  })

  it.each([
    [
      'a nested flow map, which the reader leaves out',
      'catalog: { ms: { a: 1 } }\n',
    ],
    ['an unclosed map', 'catalog: { ms: ^2.1.1\n'],
    ['text after the map', 'catalog: { ms: ^2.1.1 } x\n'],
    ['a null value', 'catalog: { ms: ~ }\n'],
    ['a flow sequence value', 'catalog: { ms: [^2.1.1] }\n'],
    ['catalogs as one flow map', 'catalogs: { tools: { ms: ^2.1.1 } }\n'],
  ])('leaves %s byte for byte', async (_, yaml) => {
    expect(await write(yaml, { ms: '3.0.0' })).toBe(yaml)
  })

  it('moves the string entries beside a flow sequence', async () => {
    expect(
      await write('catalog: { a: [x, y], ms: ^2.1.1 }\n', { ms: '3.0.0' }),
    ).toBe('catalog: { a: [x, y], ms: ^3.0.0 }\n')
  })
})

describe('a byte order mark', () => {
  it('keeps the mark and moves the first-line catalog behind it', async () => {
    const yaml = '﻿catalog:\r\n  ms: ^2.1.1\r\noverrides:\r\n  ms: 2.1.1\r\n'
    expect(await write(yaml, { ms: '3.0.0' })).toBe(
      '﻿catalog:\r\n  ms: ^3.0.0\r\noverrides:\r\n  ms: 2.1.1\r\n',
    )
  })

  it('moves a flow-map catalog behind it', async () => {
    expect(await write('﻿catalog: { ms: ^2.1.1 }\n', { ms: '3.0.0' })).toBe(
      '﻿catalog: { ms: ^3.0.0 }\n',
    )
  })
})

describe('reader and writer agree', () => {
  it.each([
    [
      'block',
      'catalog:\n  ms: ^2.1.1\ncatalogs:\n  tools:\n    debug: ~4.3.1\n',
    ],
    [
      'flow',
      'catalog: { ms: ^2.1.1, \'@types/node\': "^20.0.0" }\ncatalogs:\n  tools: { debug: ~4.3.1 }\n',
    ],
    ['a byte order mark', '﻿catalog:\n  ms: ^2.1.1\n'],
    [
      'a byte order mark before a flow map',
      '﻿catalog: { ms: ^2.1.1 }\ncatalogs:\n  tools: { debug: ~4.3.1 }\n',
    ],
    [
      'anchors',
      'catalog: &c\n  ms: ^2.1.1\ncatalogs:\n  tools: &t\n    debug: ~4.3.1\n  ui: &u { react: ^18.0.0 }\n',
    ],
  ])('every entry read from the %s form is moved', async (_, yaml) => {
    const before = readPnpmCatalogs(yaml)
    const names = Object.values(before).flatMap((entries) =>
      Object.keys(entries),
    )
    expect(names.length).toBeGreaterThan(0)

    const written = await write(
      yaml,
      Object.fromEntries(names.map((name) => [name, '99.0.0'])),
    )
    expect(readPnpmCatalogs(written)).toEqual(
      Object.fromEntries(
        Object.entries(before).map(([catalog, entries]) => [
          catalog,
          Object.fromEntries(
            Object.entries(entries).map(([name, spec]) => [
              name,
              nextVersionSpec(spec, '99.0.0'),
            ]),
          ),
        ]),
      ),
    )
    // Only the specs changed: the same text with them put back.
    expect(written.replace(/99\.0\.0/g, 'X')).toBe(
      yaml.replace(/\d+\.\d+\.\d+/g, 'X'),
    )
  })
})
