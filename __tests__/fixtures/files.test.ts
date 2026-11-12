import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  localRegistryConfig,
  npmrcSources,
  registryConfig,
  tempDir,
  write,
} from './files'

describe('tempDir', () => {
  let first: string

  it('makes an empty directory under the OS temp folder with the prefix', () => {
    first = tempDir('autd-files-test-')
    expect(path.dirname(first)).toBe(os.tmpdir())
    expect(path.basename(first).startsWith('autd-files-test-')).toBe(true)
    expect(fs.readdirSync(first)).toEqual([])
    write(path.join(first, 'a', 'b.txt'), 'x')
  })

  it('removes the previous test directory with what it held', () => {
    expect(fs.existsSync(first)).toBe(false)
  })

  it('removes a directory the test already deleted without failing', () => {
    fs.rmSync(tempDir('autd-files-test-'), { recursive: true })
  })

  it('resolves symlinks with real', () => {
    const dir = tempDir('autd-files-test-', { real: true })
    expect(dir).toBe(fs.realpathSync(dir))
  })

  it('makes a different directory each call', () => {
    expect(tempDir('autd-files-test-')).not.toBe(tempDir('autd-files-test-'))
  })
})

describe('write', () => {
  it('makes the parent directories and writes a string as is', () => {
    const file = path.join(tempDir('autd-files-test-'), 'x', 'y', 'z.txt')
    write(file, 'a\r\nb')
    expect(fs.readFileSync(file, 'utf8')).toBe('a\r\nb')
  })

  it('writes an empty file when no content is given', () => {
    const file = path.join(tempDir('autd-files-test-'), '.npmrc')
    write(file)
    expect(fs.readFileSync(file, 'utf8')).toBe('')
  })

  it('writes an object as compact JSON', () => {
    const file = path.join(tempDir('autd-files-test-'), 'package.json')
    write(file, { name: 'p', private: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('{"name":"p","private":true}')
  })

  it('replaces an existing file', () => {
    const file = path.join(tempDir('autd-files-test-'), 'f')
    write(file, 'one')
    write(file, 'two')
    expect(fs.readFileSync(file, 'utf8')).toBe('two')
  })
})

describe('npmrcSources', () => {
  it('roots home and the Node prefix under the directory', () => {
    const sources = npmrcSources('/r', { A: '1' })
    expect(sources.env).toEqual({ A: '1' })
    expect(sources.home).toBe(path.join('/r', 'home'))
    expect(sources.platform).toBe(process.platform)
    expect(sources.execPath).toBe(
      process.platform === 'win32'
        ? path.join('/r', 'prefix', 'node.exe')
        : path.join('/r', 'prefix', 'bin', 'node'),
    )
  })

  it('has an empty environment by default and takes overrides', () => {
    expect(npmrcSources('/r').env).toEqual({})
    expect(npmrcSources('/r', {}, { platform: 'linux' }).platform).toBe('linux')
  })
})

describe('registryConfig', () => {
  it('defaults to npm for the public registry', () => {
    expect(registryConfig()).toEqual({
      registry: 'https://registry.npmjs.org/',
      scopedRegistries: {},
      credentials: {},
      strictSSL: true,
      proxy: {},
      fetchRetries: 2,
      fetchTimeout: 300_000,
      maxSockets: 15,
    })
  })

  it('lets overrides replace a field', () => {
    expect(registryConfig({ fetchRetries: 0 }).fetchRetries).toBe(0)
  })
})

describe('localRegistryConfig', () => {
  it('points at the registry with no retries and a short timeout', () => {
    const config = localRegistryConfig('http://127.0.0.1:1/')
    expect(config.registry).toBe('http://127.0.0.1:1/')
    expect(config.fetchRetries).toBe(0)
    expect(config.fetchTimeout).toBe(5000)
  })

  it('lets overrides replace a field', () => {
    expect(
      localRegistryConfig('http://h/', { fetchRetries: 3 }).fetchRetries,
    ).toBe(3)
  })
})
