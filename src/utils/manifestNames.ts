import fs from 'fs'
import path from 'path'
import type { PackageInfo } from '@/types'

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

/**
 * Re-keys an outdated report by the names package.json uses. An `npm:`
 * alias (`"dj": "npm:dayjs@1.11.9"`) comes back under another name from
 * most managers: npm keys it `dj:dayjs@1.11.9`, pnpm and bun use the
 * target name `dayjs`. Every later step (rules, manifest writes, the
 * manager's own `update dj`) needs the manifest key.
 */
export const toManifestNames = (
  cwd: string,
  outdated: Record<string, PackageInfo>,
): Record<string, PackageInfo> => {
  let manifest: Record<string, Record<string, unknown> | undefined>
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    )
  } catch {
    return outdated
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

  const renamed: Record<string, PackageInfo> = {}
  for (const [reported, info] of Object.entries(outdated)) {
    const name = reported.includes(':')
      ? reported.slice(0, reported.indexOf(':'))
      : !keys.has(reported) && aliasFor.has(reported)
        ? (aliasFor.get(reported) as string)
        : reported
    renamed[name] = { ...info, name }
  }
  return renamed
}
