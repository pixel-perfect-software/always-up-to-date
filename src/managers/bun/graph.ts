import fs from 'fs'
import path from 'path'

import { graphBuilder } from '@/utils/graphBuilder'
import type { InstalledGraph } from '@/utils/installedGraph'
import { isRecord } from '@/utils/isRecord'

/**
 * bun.lock is JSON with trailing commas: a comma goes only when the next
 * character that isn't whitespace closes an object or an array, and a comma
 * inside a string stays.
 */
const withoutTrailingCommas = (text: string): string => {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === ',') {
      let next = i + 1
      while (next < text.length && /\s/.test(text[next])) next++
      if (text[next] === '}' || text[next] === ']') continue
    }
    out += c
  }
  return out
}

/**
 * The package names a `packages` key joins with `/`: `@tiptap/react/@tiptap/core`
 * is the copy of `@tiptap/core` nested under `@tiptap/react`. A segment
 * starting with `@` is a scope and takes the next one.
 */
const namesOf = (key: string): string[] => {
  const parts = key.split('/')
  const names: string[] = []
  for (let i = 0; i < parts.length; i++) {
    names.push(
      parts[i].startsWith('@') && i + 1 < parts.length
        ? `${parts[i]}/${parts[++i]}`
        : parts[i],
    )
  }
  return names
}

type DependencyField =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies'

const declared = (
  block: Record<string, unknown>,
  fields: readonly DependencyField[],
): string[] =>
  fields.flatMap((field) => {
    const found = block[field]
    return isRecord(found) ? Object.keys(found) : []
  })

/**
 * The installed graph from bun.lock (lockfileVersion 2, text; bun 1.4.4):
 * `workspaces` for each workspace's direct dependencies and `packages` for
 * what each installed copy depends on, whatever linker installed it. A
 * `packages` key is a package's name (the hoisted copy) or names joined by
 * `/` for a nested one, and its first element is the resolution
 * (`name@version`, `name@workspace:<path>` for a workspace: never a node;
 * an alias's key holds its target's resolution). bun installs peers, so
 * resolved peers are edges. Undefined without a bun.lock (the binary
 * bun.lockb is not read) or one that doesn't parse.
 */
export const readBunGraph = (cwd: string): InstalledGraph | undefined => {
  let lock: unknown
  try {
    lock = JSON.parse(
      withoutTrailingCommas(
        fs.readFileSync(path.join(cwd, 'bun.lock'), 'utf8'),
      ),
    )
  } catch {
    return undefined
  }
  if (!isRecord(lock) || !isRecord(lock.workspaces)) return undefined
  if (!isRecord(lock.packages)) return undefined

  /** `key` → its id and what it declares; a workspace package is left out. */
  const copies = new Map<
    string,
    { id: string; block: Record<string, unknown> }
  >()
  const workspaced = new Set<string>()
  for (const [key, found] of Object.entries(lock.packages)) {
    const resolution = Array.isArray(found) ? found[0] : undefined
    if (typeof resolution !== 'string') continue
    const at = resolution.indexOf('@', 1)
    if (at === -1) continue
    if (resolution.slice(at + 1).startsWith('workspace:')) {
      workspaced.add(key)
      continue
    }
    const info = (found as unknown[])[2]
    copies.set(key, { id: resolution, block: isRecord(info) ? info : {} })
  }

  /** The copy `name` resolves to from the package at `names`: its own nested one, then each ancestor's, then the hoisted. */
  const resolve = (names: string[], name: string): string | undefined => {
    for (let depth = names.length; depth >= 0; depth--) {
      const key = [...names.slice(0, depth), name].join('/')
      if (workspaced.has(key)) return undefined
      const copy = copies.get(key)
      if (copy) return copy.id
    }
    return undefined
  }

  const builder = graphBuilder()
  for (const [folder, found] of Object.entries(lock.workspaces)) {
    if (!isRecord(found)) continue
    const importer = builder.importer(folder === '' ? '.' : folder)
    const scope = typeof found.name === 'string' ? [found.name] : []
    for (const name of declared(found, [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ])) {
      const id = resolve(scope, name)
      if (id) importer.set(name, id)
    }
  }
  for (const [key, { id, block }] of copies) {
    builder.node(id)
    const names = namesOf(key)
    for (const name of declared(block, [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ])) {
      const target = resolve(names, name)
      if (target) builder.edge(id, name, target)
    }
  }
  return builder.graph()
}
