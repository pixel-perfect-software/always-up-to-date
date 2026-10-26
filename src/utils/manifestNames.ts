import fs from 'fs'
import path from 'path'
import type { OutdatedEntry, PackageInfo } from '@/types'

export { DEPENDENCY_FIELDS } from './dependencySpecs'

import { DEPENDENCY_FIELDS } from './dependencySpecs'

/**
 * The names package.json in `dir` uses, or undefined when it can't be read.
 * An `npm:` alias (`"dj": "npm:dayjs@1.11.9"`) comes back under another name
 * from most managers: npm keys it `dj:dayjs@1.11.9`, pnpm and bun use the
 * target name `dayjs`. Every later step (rules, manifest writes, the
 * manager's own `update dj`) needs the manifest key.
 */
const readNamer = (dir: string): ((reported: string) => string) | undefined => {
  let manifest: Record<string, Record<string, unknown> | undefined>
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    )
  } catch {
    return undefined
  }

  const keys = new Set<string>()
  const aliasFor = new Map<string, string>()
  for (const field of DEPENDENCY_FIELDS) {
    for (const [key, spec] of Object.entries(manifest[field] ?? {})) {
      keys.add(key)
      const target =
        typeof spec === 'string'
          ? /^npm:((?:@[^/@]+\/)?[^@]+)@/.exec(spec)?.[1]
          : undefined
      if (target && !aliasFor.has(target)) aliasFor.set(target, key)
    }
  }

  return (reported) =>
    reported.includes(':')
      ? reported.slice(0, reported.indexOf(':'))
      : !keys.has(reported) && aliasFor.has(reported)
        ? (aliasFor.get(reported) as string)
        : reported
}

/** Maps a reported package name to the key package.json in `dir` declares it under. */
export const manifestNamer = (dir: string): ((reported: string) => string) =>
  readNamer(dir) ?? ((reported) => reported)

/** Re-keys an outdated report by the names the project's package.json uses. */
export const toManifestNames = (
  cwd: string,
  outdated: Record<string, PackageInfo>,
): Record<string, PackageInfo> => {
  const nameOf = readNamer(cwd)
  if (!nameOf) return outdated

  const renamed: Record<string, PackageInfo> = {}
  for (const [reported, info] of Object.entries(outdated)) {
    const name = nameOf(reported)
    renamed[name] = { ...info, name }
  }
  return renamed
}

/**
 * Re-keys a workspace project's entries by the names their owning manifest
 * uses: an alias only a member declares takes that member's key.
 */
export const toEntryManifestNames = (
  cwd: string,
  entries: OutdatedEntry[],
): OutdatedEntry[] => {
  const namers = new Map<string, (reported: string) => string>()
  return entries.map((entry) => {
    let nameOf = namers.get(entry.workspace)
    if (!nameOf) {
      nameOf = manifestNamer(path.join(cwd, entry.workspace))
      namers.set(entry.workspace, nameOf)
    }
    return { ...entry, name: nameOf(entry.name) }
  })
}
