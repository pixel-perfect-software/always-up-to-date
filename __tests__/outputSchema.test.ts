import fs from 'fs'
import os from 'os'
import path from 'path'
import { supportedManagers } from '@/managers/names'
import npm from '@/managers/npm'
import { findOutdated, plan, update } from '@/pipeline'
import { StepError } from '@/stepError'
import type { AlwaysUpToDateConfig, UpdateResult } from '@/types'
import {
  errorDocument,
  OUTPUT_VERSION,
  planDocument,
  rowOf,
} from '@/utils/jsonDocument'
import { OUTCOMES, REASON_CODES } from '@/utils/reasons'
import packageJson from '../package.json'
import {
  capturedRegistry,
  installPackages,
  projectFor,
  writeWorkspaceProject,
} from './fixtures'
import { outputSchema, validateOutput } from './fixtures/outputSchema'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

// When the registry captures were taken, so no version drifts.
const AS_OF = '2026-10-23T16:38:12-03:00'

type Definitions = Record<string, { properties: Record<string, unknown> }>
const definitions = outputSchema.definitions as Definitions
const enumOf = (definition: string, property: string): unknown[] =>
  (definitions[definition].properties[property] as { enum: unknown[] }).enum

describe('schema/output.schema.json', () => {
  it('compiles under Ajv strict mode (validateOutput compiled it on import)', () => {
    expect(() => validateOutput({})).toThrow()
  })

  it('lists exactly the reason codes the code defines', () => {
    expect(enumOf('reason', 'code')).toEqual([...REASON_CODES])
  })

  it('lists exactly the outcomes the code defines', () => {
    expect(enumOf('row', 'outcome')).toEqual([...OUTCOMES])
  })

  it('lists exactly the managers the CLI supports', () => {
    expect(enumOf('planDocument', 'manager')).toEqual([...supportedManagers])
  })

  it("lists exactly the values the installed semver's diff returns", () => {
    // Read from the installed semver's source: a new release type fails here.
    const source = fs.readFileSync(
      path.join(__dirname, '../node_modules/semver/functions/diff.js'),
      'utf8',
    )
    const returned = new Set<string>()
    for (const [, prefix, name] of source.matchAll(
      /return (prefix \+ )?'([a-z]+)'/g,
    )) {
      returned.add(name)
      if (prefix) returned.add(`pre${name}`)
    }
    expect([...enumOf('row', 'updateType')].filter(Boolean).sort()).toEqual(
      [...returned].sort(),
    )
    expect(enumOf('row', 'updateType')).toContain(null)
  })

  it('pins version 1 and the package version is a string', () => {
    expect(OUTPUT_VERSION).toBe(1)
    expect(typeof packageJson.version).toBe('string')
  })
})

const manifest = {
  dependencies: {
    zod: '3.x',
    express: '>=4.18.2 <5.0.0',
    semver: '~7.5.0 || ~7.6.0',
    dj: 'npm:dayjs@1.11.9',
    ms: '*',
  },
}
const INSTALLED = {
  dj: '1.11.9',
  express: '4.22.3',
  semver: '7.6.3',
  zod: '3.25.76',
  ms: '2.1.3',
}

let cwd: string
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-output-schema-'))
})
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('documents from real pipeline runs validate', () => {
  const singlePackage = (config: Partial<AlwaysUpToDateConfig>) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))
    installPackages(cwd, '.', INSTALLED)
    const apply = jest.fn(async (_run, dir: string, { beyondRange }) =>
      installPackages(dir, '.', beyondRange),
    )
    return projectFor(
      { ...npm, apply },
      cwd,
      config,
      capturedRegistry(['zod', 'express', 'semver', 'dayjs', 'ms'], {
        asOf: AS_OF,
      }),
    )
  }

  it.each([
    ['default config', {}],
    ['beyondRange major', { beyondRange: 'major' as const }],
  ])('single package, %s: check, plan and update', async (_label, config) => {
    const project = singlePackage(config)
    const outdated = await findOutdated(project)
    const planned = await plan(project, outdated)
    const documents = [
      planDocument({
        command: 'check',
        phase: 'plan',
        manager: 'npm',
        results: planned,
      }),
      planDocument({
        command: 'update',
        phase: 'plan',
        manager: 'npm',
        results: planned,
      }),
      planDocument({
        command: 'update',
        phase: 'applied',
        manager: 'npm',
        results: await update(project),
      }),
    ]
    for (const document of documents) validateOutput(document)
    expect(documents[0].rows.length).toBeGreaterThan(0)
  })

  it('a workspace project: rows carry their manifest', async () => {
    writeWorkspaceProject(cwd)
    installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.1' })
    installPackages(cwd, 'packages/a', { ms: '2.1.2' })
    installPackages(cwd, 'packages/b', { debug: '4.3.1', dayjs: '1.11.9' })
    const project = projectFor(
      npm,
      cwd,
      {},
      capturedRegistry(['dayjs', 'ms', 'debug'], { asOf: AS_OF }),
    )
    const results = await plan(project, await findOutdated(project))
    const document = planDocument({
      command: 'check',
      phase: 'plan',
      manager: 'npm',
      results,
    })

    validateOutput(document)
    expect(
      new Set(document.rows.map((row) => row.workspace)).size,
    ).toBeGreaterThan(1)
  })

  it('a member run: member names the manifest', async () => {
    writeWorkspaceProject(cwd)
    installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.1', debug: '4.3.1' })
    const member = { path: 'packages/b', name: '@ws/b' }
    const project = projectFor(
      npm,
      cwd,
      {},
      capturedRegistry(['dayjs', 'debug'], { asOf: AS_OF }),
      member,
    )
    const results = await plan(project, await findOutdated(project))
    const document = planDocument({
      command: 'check',
      phase: 'plan',
      manager: 'npm',
      member: member.path,
      results,
    })

    validateOutput(document)
    expect(document.member).toBe('packages/b')
    expect(document.rows.map((row) => row.workspace)).toEqual([
      'packages/b',
      'packages/b',
    ])
  })
})

describe('every reason code and outcome validates', () => {
  const base: UpdateResult = {
    name: 'left-pad',
    current: '1.0.0',
    wanted: '1.0.0',
    latest: '1.3.0',
    updateType: 'minor',
    updated: false,
    reason: { code: 'outside-range', message: 'minor beyond the range' },
  }

  it.each(REASON_CODES)('%s', (code) => {
    const row = rowOf({ ...base, reason: { code, message: code } })
    validateOutput(
      planDocument({
        command: 'update',
        phase: 'applied',
        manager: 'npm',
        results: [
          { ...base, reason: { code, message: code } },
          { ...base, updated: true, target: '1.3.0', reason: row.reason },
          {
            ...base,
            updated: true,
            target: '1.2.0',
            warnings: [{ code, message: code }],
            releaseAge: 2.5,
            reason: row.reason,
          },
        ],
      }),
    )
  })

  it('maps a dependency that is not installed to current: null', () => {
    const row = rowOf({ ...base, current: 'missing' })
    expect(row.current).toBeNull()
  })

  it.each([
    [{ ...base, updated: true, target: '1.2.0' }, 'update'],
    [base, 'held'],
    [{ ...base, reason: { code: 'not-applied', message: 'x' } }, 'not-applied'],
    [
      { ...base, reason: { code: 'not-targeted', message: 'not targeted' } },
      'not-targeted',
    ],
  ] as const)('outcome %#', (row, outcome) => {
    expect(rowOf(row as UpdateResult).outcome).toBe(outcome)
  })
})

describe('error documents validate', () => {
  it.each([
    ['detect', 'detect'],
    ['discover', 'discover'],
    ['apply', 'apply'],
  ] as const)('a %s failure', (_label, step) => {
    const error = new StepError(step, 'it failed', { manifestWritten: true })
    validateOutput(
      errorDocument('update', {
        step: error.step,
        message: error.message,
        manifestWritten: error.manifestWritten,
      }),
    )
  })

  it('a failure outside a step (a malformed config)', () => {
    validateOutput(
      errorDocument('check', {
        step: null,
        message: 'bad config',
        manifestWritten: false,
      }),
    )
  })
})

describe('the schema rejects', () => {
  const valid = () =>
    planDocument({
      command: 'check',
      phase: 'plan',
      manager: 'npm',
      results: [
        {
          name: 'a',
          current: '1.0.0',
          wanted: '1.0.0',
          latest: '1.1.0',
          updateType: 'minor',
          updated: false,
          reason: { code: 'outside-range', message: 'minor beyond the range' },
        },
      ],
    })
  const mutate = (change: (document: Record<string, unknown>) => void) => {
    const document = JSON.parse(JSON.stringify(valid()))
    change(document)
    return document
  }

  it('accepts the unmodified document', () => {
    expect(() => validateOutput(valid())).not.toThrow()
  })

  it.each([
    ['a missing version', (d: Record<string, unknown>) => delete d.version],
    ['another version', (d: Record<string, unknown>) => (d.version = 2)],
    [
      'an unknown top-level field',
      (d: Record<string, unknown>) => (d.extra = 1),
    ],
    [
      'a row without a reason',
      (d: Record<string, unknown>) =>
        delete (d.rows as Record<string, unknown>[])[0].reason,
    ],
    [
      'an unknown row field',
      (d: Record<string, unknown>) =>
        ((d.rows as Record<string, unknown>[])[0].extra = true),
    ],
    [
      'the 3.x `updated` field',
      (d: Record<string, unknown>) =>
        ((d.rows as Record<string, unknown>[])[0].updated = false),
    ],
    [
      'an unknown outcome',
      (d: Record<string, unknown>) =>
        ((d.rows as Record<string, unknown>[])[0].outcome = 'skipped'),
    ],
    [
      'an unknown reason code',
      (d: Record<string, unknown>) =>
        ((
          (d.rows as Record<string, unknown>[])[0].reason as Record<
            string,
            unknown
          >
        ).code = 'because'),
    ],
    [
      'warnings that are strings',
      (d: Record<string, unknown>) =>
        ((d.rows as Record<string, unknown>[])[0].warnings = ['x']),
    ],
    [
      'the 3.x record keyed by name',
      (d: Record<string, unknown>) => {
        d.rows = {}
      },
    ],
  ])('%s', (_label, change) => {
    expect(() => validateOutput(mutate(change))).toThrow()
  })

  it('rejects a bare array, the 3.x shape', () => {
    expect(() => validateOutput([])).toThrow()
  })
})
