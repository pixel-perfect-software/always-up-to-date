import fs from 'fs'
import os from 'os'
import path from 'path'
import { readInstalledPeers } from '@/utils/peers'

describe('readInstalledPeers', () => {
  let cwd: string

  const install = (dir: string, manifest: Record<string, unknown>) => {
    fs.mkdirSync(path.join(cwd, dir), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, dir, 'package.json'),
      JSON.stringify(manifest),
    )
  }

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-peers-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('collects peer ranges from hoisted packages, scoped ones included', () => {
    install('node_modules/react-dom', {
      name: 'react-dom',
      version: '18.2.0',
      peerDependencies: { react: '^18.2.0' },
    })
    install('node_modules/@tanstack/react-query', {
      name: '@tanstack/react-query',
      version: '4.29.5',
      peerDependencies: { react: '^16.8.0 || ^17.0.0 || ^18.0.0' },
    })
    install('node_modules/dayjs', { name: 'dayjs', version: '1.11.9' })

    expect(readInstalledPeers(cwd).get('react')).toEqual(
      expect.arrayContaining([
        { name: 'react-dom', version: '18.2.0', range: '^18.2.0' },
        {
          name: '@tanstack/react-query',
          version: '4.29.5',
          range: '^16.8.0 || ^17.0.0 || ^18.0.0',
        },
      ]),
    )
    expect(readInstalledPeers(cwd).get('dayjs')).toBeUndefined()
  })

  it('reads packages from the pnpm store', () => {
    install(
      'node_modules/.pnpm/react-dom@18.2.0_react@18.2.0/node_modules/react-dom',
      {
        name: 'react-dom',
        version: '18.2.0',
        peerDependencies: { react: '^18.2.0' },
      },
    )
    install(
      'node_modules/.pnpm/@reduxjs+toolkit@1.9.5_react@18.2.0/node_modules/@reduxjs/toolkit',
      {
        name: '@reduxjs/toolkit',
        version: '1.9.5',
        peerDependencies: { react: '^16.9.0 || ^17.0.0 || ^18' },
      },
    )

    expect(readInstalledPeers(cwd).get('react')).toHaveLength(2)
  })

  it('returns nothing when node_modules is missing', () => {
    expect(readInstalledPeers(cwd).size).toBe(0)
  })
})
