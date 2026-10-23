import fs from 'fs'
import path from 'path'

import type { WorkspaceManifest } from '@/managers/adapter'
import { StepError } from '@/stepError'
import logger from '@/utils/logger'

/** The project's package.json, or undefined when it can't be read. */
export const readManifest = (
  cwd: string,
): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * npm, yarn and bun declare members in a `workspaces` field: an array of
 * globs, or an object with a `packages` field.
 */
const declaresWorkspaces = (workspaces: unknown): boolean =>
  Array.isArray(workspaces) ||
  (typeof workspaces === 'object' &&
    workspaces !== null &&
    !!(workspaces as { packages?: unknown }).packages)

/**
 * The `workspaces` patterns of a package.json (npm, yarn, bun): the array,
 * or the object form's `packages` array. Empty when there are none.
 */
export const workspacePatterns = (manifest: unknown): string[] => {
  const workspaces = (manifest as { workspaces?: unknown } | undefined)
    ?.workspaces
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : (workspaces as { packages?: unknown } | null | undefined)?.packages
  return Array.isArray(patterns)
    ? patterns.filter(
        (pattern): pattern is string => typeof pattern === 'string',
      )
    : []
}

/** Syntax this expansion does not support: extglobs such as `@(a|b)`. */
const UNSUPPORTED_SYNTAX = /[()]/

/** `{a,b}` alternatives, expanded into one pattern each, innermost first. */
const expandBraces = (pattern: string): string[] => {
  const brace = /\{([^{}]*)\}/.exec(pattern)
  if (!brace) return [pattern]
  const before = pattern.slice(0, brace.index)
  const after = pattern.slice(brace.index + brace[0].length)
  return brace[1]
    .split(',')
    .flatMap((option) => expandBraces(`${before}${option}${after}`))
}

export const toPosix = (value: string): string =>
  value.split(path.sep).join('/')

/**
 * A manager-reported owner as a path relative to the root ('.' for the root
 * itself). An owner outside the root (`..`, an absolute path) fails
 * discovery: apply writes the owner's package.json, and must not write
 * outside the project.
 */
export const ownerPath = (
  manager: string,
  name: string,
  relative: string,
): string => {
  const owner = toPosix(relative) || '.'
  if (owner === '..' || owner.startsWith('../') || path.isAbsolute(owner)) {
    throw new StepError(
      'discover',
      `${manager} reported ${name} in ${relative}, which is outside the project`,
    )
  }
  return owner
}

const segmentsOf = (pattern: string): string[] =>
  pattern
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')

/** A segment's `*`, `?` and `[…]` / `[!…]` wildcards as a regular expression. */
const segmentRegExp = (segment: string): RegExp => {
  let source = ''
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]
    const classEnd = char === '[' ? segment.indexOf(']', i + 1) : -1
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (classEnd > i + 1) {
      const body = segment.slice(i + 1, classEnd).replace(/\\/g, '\\\\')
      source += body.startsWith('!') ? `[^${body.slice(1)}]` : `[${body}]`
      i = classEnd
    } else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

const isDirectory = (dir: string): boolean => {
  try {
    return fs.lstatSync(dir).isDirectory()
  } catch {
    return false
  }
}

const hasManifest = (dir: string): boolean =>
  fs.existsSync(path.join(dir, 'package.json'))

const childDirectories = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Collects the directories `segments` match below `base` that have a package.json. */
const walk = (
  root: string,
  relative: string[],
  segments: string[],
  found: Set<string>,
): void => {
  const dir = path.join(root, ...relative)
  if (segments.length === 0) {
    if (relative.length > 0 && hasManifest(dir)) found.add(relative.join('/'))
    return
  }
  const [segment, ...rest] = segments

  if (segment === '**') {
    walk(root, relative, rest, found)
    for (const child of childDirectories(dir)) {
      if (child === 'node_modules' || child.startsWith('.')) continue
      walk(root, [...relative, child], segments, found)
    }
    return
  }

  if (!/[*?[]/.test(segment)) {
    if (isDirectory(path.join(dir, segment))) {
      walk(root, [...relative, segment], rest, found)
    }
    return
  }

  const matcher = segmentRegExp(segment)
  for (const child of childDirectories(dir)) {
    if (child === 'node_modules') continue
    if (child.startsWith('.') && !segment.startsWith('.')) continue
    if (matcher.test(child)) walk(root, [...relative, child], rest, found)
  }
}

/** Whether a relative path (as segments) matches a pattern (as segments). */
const matchesSegments = (pattern: string[], parts: string[]): boolean => {
  if (pattern.length === 0) return parts.length === 0
  const [segment, ...rest] = pattern
  if (segment === '**') {
    return (
      matchesSegments(rest, parts) ||
      (parts.length > 0 && matchesSegments(pattern, parts.slice(1)))
    )
  }
  return (
    parts.length > 0 &&
    segmentRegExp(segment).test(parts[0]) &&
    matchesSegments(rest, parts.slice(1))
  )
}

/**
 * The root's manifest, then every member directory the workspace patterns
 * match, sorted by path. Supported: literal directories, `{a,b}` braces, `*`,
 * `?` and `[…]` / `[!…]` classes inside a segment, `**` as a whole segment,
 * and `!` negations applied after the positive patterns. Extglobs
 * (`@(a|b)`) match nothing.
 * Only directories with a package.json count; `node_modules`, dot-directories
 * (unless the pattern segment itself starts with `.`) and symlinks are skipped.
 */
export const readWorkspaceManifests = (
  cwd: string,
  patterns: string[],
): WorkspaceManifest[] => {
  const found = new Set<string>()
  const negations: string[][] = []

  for (const pattern of patterns) {
    if (UNSUPPORTED_SYNTAX.test(pattern)) {
      logger.debug(
        `Workspace pattern "${pattern}" uses syntax autd does not expand; it matches nothing.`,
      )
      continue
    }
    const negated = pattern.startsWith('!')
    for (const expanded of expandBraces(negated ? pattern.slice(1) : pattern)) {
      if (negated) negations.push(segmentsOf(expanded))
      else walk(cwd, [], segmentsOf(expanded), found)
    }
  }

  const members = [...found]
    .filter(
      (member) =>
        !negations.some((negation) =>
          matchesSegments(negation, member.split('/')),
        ),
    )
    .sort()
    .map((member): WorkspaceManifest => {
      const name = readManifest(path.join(cwd, ...member.split('/')))?.name
      return typeof name === 'string'
        ? { path: member, name }
        : { path: member }
    })

  const rootName = readManifest(cwd)?.name
  return [
    typeof rootName === 'string'
      ? { path: '.', name: rootName }
      : { path: '.' },
    ...members,
  ]
}

/**
 * Resolves the workspace name a manager prints (yarn v1's and bun's
 * `Workspace` column) to the manifest's directory. Both print an empty cell
 * for a root without a `name` (verified on yarn 1.22.22 and bun 1.4.0), so
 * `''` is the root when the root is unnamed. Any other name no manifest
 * declares is a `discover` failure.
 */
export const workspaceOwner = (
  manifests: WorkspaceManifest[],
  manager: string,
): ((workspaceName: string) => string) => {
  const byName = new Map<string, string>()
  for (const { path: dir, name } of manifests) {
    if (name !== undefined && !byName.has(name)) byName.set(name, dir)
  }
  const root = manifests.find((manifest) => manifest.path === '.')

  return (workspaceName) => {
    const owner = byName.get(workspaceName)
    if (owner !== undefined) return owner
    if (workspaceName === '' && root && root.name === undefined) return '.'
    throw new StepError(
      'discover',
      `${manager} reported workspace "${workspaceName}", which no manifest matched by the workspaces patterns declares`,
    )
  }
}

/**
 * npm, yarn and bun: whether package.json declares workspaces, and the
 * manifests its patterns match, the root first.
 */
export const packageJsonWorkspace = (
  cwd: string,
): { isWorkspace: boolean; manifests: WorkspaceManifest[] } => {
  const manifest = readManifest(cwd)
  const isWorkspace = declaresWorkspaces(manifest?.workspaces)
  return {
    isWorkspace,
    manifests: readWorkspaceManifests(
      cwd,
      isWorkspace ? workspacePatterns(manifest) : [],
    ),
  }
}
