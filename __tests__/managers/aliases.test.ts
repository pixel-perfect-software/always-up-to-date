import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { check, plan } from '@/pipeline'
import { capturedRegistry, installPackages, projectFor } from '../fixtures'

jest.mock('@/utils/logger')
// The scratch project the fixtures come from: `dj` is an npm: alias.
const manifest = {
  dependencies: {
    zod: '3.x',
    express: '>=4.18.2 <5.0.0',
    semver: '~7.5.0 || ~7.6.0',
    dj: 'npm:dayjs@1.11.9',
    ms: '*',
  },
}

// What the scratch project had installed when the alias fixtures were captured.
const INSTALLED = {
  dj: '1.11.9',
  express: '4.22.3',
  semver: '7.6.3',
  zod: '3.25.76',
  ms: '2.1.3',
}
const AS_OF = '2026-10-23T10:42:18-03:00'

describe.each([
  { pm: 'npm', adapter: npm },
  { pm: 'pnpm', adapter: pnpm },
  { pm: 'yarn', adapter: yarn },
  { pm: 'bun', adapter: bun },
] as const)('$pm with an npm: alias', ({ pm, adapter }) => {
  let cwd: string
  let registry: ReturnType<typeof capturedRegistry>
  let lookup: jest.Mock

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-alias-${pm}-`))
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))
    installPackages(cwd, '.', INSTALLED)
    const captured = capturedRegistry(
      ['zod', 'express', 'semver', 'dayjs', 'ms'],
      { asOf: AS_OF },
    )
    lookup = jest.fn(captured.lookup)
    registry = { ...captured, lookup }
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('reports the alias under its manifest key', async () => {
    const outdated = await check(
      projectFor(adapter, cwd, { beyondRange: 'major' }, registry),
    )

    expect(Object.keys(outdated)).toContain('dj')
    expect(Object.keys(outdated)).not.toContain('dayjs')
    expect(Object.keys(outdated).some((name) => name.includes(':'))).toBe(false)
    expect(outdated.dj.name).toBe('dj')
  })

  it('looks the alias up by its target, never by its key', async () => {
    await check(projectFor(adapter, cwd, { beyondRange: 'major' }, registry))

    const asked = lookup.mock.calls.map(([name]) => name)
    expect(asked).toContain('dayjs')
    expect(asked).not.toContain('dj')
  })

  it('plans the alias like any other package', async () => {
    const project = projectFor(adapter, cwd, { beyondRange: 'major' }, registry)
    const outdated = await check(project)

    const results = await plan(project, outdated)

    expect(results.find((r) => r.name === 'dj')).toMatchObject({
      updated: true,
      target: '1.11.23',
    })
    expect(results.find((r) => r.name === 'zod')?.updated).toBe(true)
  })
})
