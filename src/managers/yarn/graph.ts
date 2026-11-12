import fs from 'fs'
import path from 'path'

import { packageJsonWorkspace, readManifest } from '@/managers/workspaces'
import { parseAlias, parseBareAlias } from '@/utils/aliasSpec'
import { graphBuilder } from '@/utils/graphBuilder'
import type { InstalledGraph } from '@/utils/installedGraph'
import { isRecord } from '@/utils/isRecord'
import { parseYaml } from '@/utils/yaml'

/** The package a descriptor `name@range` names: an alias's target, else the name before the range. */
const nameOf = (descriptor: string): string | undefined => {
  const at = descriptor.indexOf('@', 1)
  if (at === -1) return undefined
  const range = descriptor.slice(at + 1)
  return (
    parseAlias(range)?.name ?? parseBareAlias(range) ?? descriptor.slice(0, at)
  )
}

const DIRECT_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const

const stringValues = (block: unknown): [string, string][] =>
  isRecord(block)
    ? Object.entries(block).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string',
      )
    : []

/** `"a@^1", b@2` → `a@^1`, `b@2`: a key is quoted when it holds a comma, space or colon. */
const splitKeys = (header: string): string[] => {
  const keys: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < header.length; i++) {
    const c = header[i]
    if (c === '"') quoted = !quoted
    else if (c === '\\' && quoted) current += header[++i] ?? ''
    else if (c === ',' && !quoted) {
      keys.push(current.trim())
      current = ''
    } else current += c
  }
  keys.push(current.trim())
  return keys.filter((key) => key !== '')
}

const unquote = (text: string): string =>
  text.length > 1 && text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1)
    : text

interface V1Entry {
  keys: string[]
  version?: string
  dependencies: [string, string][]
}

/**
 * yarn v1's lockfile: a header of comma-separated descriptors ending in `:`,
 * then `version "x"` and the `dependencies:` and `optionalDependencies:`
 * blocks of `name "range"` (yarn writes no peers). A descriptor is quoted
 * when it holds a space, comma or colon.
 */
const parseV1 = (text: string): V1Entry[] => {
  const entries: V1Entry[] = []
  let entry: V1Entry | undefined
  let block = false
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue
    if (!line.startsWith(' ')) {
      entry = line.endsWith(':')
        ? { keys: splitKeys(line.slice(0, -1)), dependencies: [] }
        : undefined
      if (entry) entries.push(entry)
      block = false
      continue
    }
    if (!entry) continue
    if (!line.startsWith('    ')) {
      const field = /^ {2}(\S+?):?(?: (.*))?$/.exec(line)
      block =
        field?.[1] === 'dependencies' || field?.[1] === 'optionalDependencies'
      if (field?.[1] === 'version' && field[2] !== undefined) {
        entry.version = unquote(field[2])
      }
      continue
    }
    const dependency = block
      ? /^ {4}(?:"([^"]+)"|(\S+)) (.*)$/.exec(line)
      : null
    if (dependency) {
      entry.dependencies.push([
        dependency[1] ?? dependency[2],
        unquote(dependency[3]),
      ])
    }
  }
  return entries
}

/**
 * The installed graph from yarn v1's `yarn.lock`, which keys each entry by
 * the descriptors that resolve to it: an edge is a dependency `name "range"`
 * looked up as `name@range`. The lock has no workspace entries (a workspace
 * package is not in it, so the lookup skips it), so each workspace's direct
 * dependencies come from its package.json, read for the root and every
 * member the workspace patterns match. yarn v1 installs no peers, so there
 * are no peer edges. Undefined without a readable yarn.lock.
 */
export const readYarnV1Graph = (cwd: string): InstalledGraph | undefined => {
  let entries: V1Entry[]
  try {
    const text = fs.readFileSync(path.join(cwd, 'yarn.lock'), 'utf8')
    // Every v1 lockfile says so in its header; another format is not read.
    if (!text.includes('# yarn lockfile v1')) return undefined
    entries = parseV1(text)
  } catch {
    return undefined
  }

  const builder = graphBuilder()
  const ids = new Map<string, string>()
  for (const entry of entries) {
    const name = entry.keys[0] ? nameOf(entry.keys[0]) : undefined
    if (name === undefined || entry.version === undefined) continue
    const id = `${name}@${entry.version}`
    builder.node(id)
    for (const key of entry.keys) ids.set(key, id)
  }
  for (const entry of entries) {
    const name = entry.keys[0] ? nameOf(entry.keys[0]) : undefined
    if (name === undefined || entry.version === undefined) continue
    for (const [dependency, range] of entry.dependencies) {
      const target = ids.get(`${dependency}@${range}`)
      if (target) builder.edge(`${name}@${entry.version}`, dependency, target)
    }
  }

  for (const { path: workspace } of packageJsonWorkspace(cwd).manifests) {
    const importer = builder.importer(workspace)
    const manifest = readManifest(path.join(cwd, workspace))
    for (const field of DIRECT_FIELDS) {
      for (const [dependency, range] of stringValues(manifest?.[field])) {
        const target = ids.get(`${dependency}@${range}`)
        if (target) importer.set(dependency, target)
      }
    }
  }
  return builder.graph()
}

/**
 * The installed graph from berry's `yarn.lock` (`__metadata` version 10,
 * yarn 4.18.1; PnP or node-modules alike). An entry's `resolution` is
 * `<name>@npm:<version>` for an installed package (an alias's is its
 * target's), `<name>@workspace:<path>` for a workspace, which is an importer
 * and never a node; patches, git and file resolutions are not nodes. An edge
 * is a dependency `name: "npm:<range>"` looked up as `name@npm:<range>` in
 * the entries' keys; a `workspace:` value resolves to no node. berry records
 * no resolved peers, so there are no peer edges. Undefined without a readable
 * yarn.lock.
 */
export const readBerryGraph = (cwd: string): InstalledGraph | undefined => {
  let lock: Record<string, unknown>
  try {
    lock = parseYaml(fs.readFileSync(path.join(cwd, 'yarn.lock'), 'utf8'))
  } catch {
    return undefined
  }
  // Every berry lockfile starts with `__metadata`; another format is not read.
  if (!isRecord(lock.__metadata)) return undefined

  const builder = graphBuilder()
  const ids = new Map<string, string>()
  const nodes: { id: string; entry: Record<string, unknown> }[] = []
  const workspaces: { folder: string; entry: Record<string, unknown> }[] = []
  for (const [keys, entry] of Object.entries(lock)) {
    if (!isRecord(entry) || typeof entry.resolution !== 'string') continue
    const resolution = /^((?:@[^/@]+\/)?[^@]+)@(npm|workspace):(.*)$/.exec(
      entry.resolution,
    )
    if (!resolution) continue
    if (resolution[2] === 'workspace') {
      workspaces.push({ folder: resolution[3], entry })
      continue
    }
    const id = `${resolution[1]}@${resolution[3]}`
    builder.node(id)
    nodes.push({ id, entry })
    for (const descriptor of keys.split(/,\s*/)) ids.set(descriptor, id)
  }

  for (const { id, entry } of nodes) {
    for (const [name, spec] of stringValues(entry.dependencies)) {
      const target = ids.get(`${name}@${spec}`)
      if (target) builder.edge(id, name, target)
    }
  }
  for (const { folder, entry } of workspaces) {
    const importer = builder.importer(folder)
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const [name, spec] of stringValues(entry[field])) {
        const target = ids.get(`${name}@${spec}`)
        if (target) importer.set(name, target)
      }
    }
  }
  return builder.graph()
}
