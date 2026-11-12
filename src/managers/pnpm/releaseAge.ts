import fs from 'fs'
import path from 'path'

import { PNPM_ENV, pnpmConfigDir } from '@/managers/pnpm/npmrc'
import type { ReleaseAgeGate } from '@/types'
import { envLayer, type NpmrcSources } from '@/utils/npmrcLoader'
import { exemptionOf } from '@/utils/releaseAgeGate'
import { parseYaml, type YamlNode } from '@/utils/yaml'

/** `minimumReleaseAge`'s default in pnpm 12: one day, in minutes. */
export const PNPM_DEFAULT_RELEASE_AGE = 1440

const readYaml = (file: string): Record<string, YamlNode> => {
  try {
    return parseYaml(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * pnpm's release-age gate (#168), a security default autd never overrides.
 * Verified on pnpm 12.16.1, 2026-11-03, with `pnpm install` against a local
 * registry with set publish times (p01-p19, the cases in `__tests__/releaseAgeGates.test.ts`):
 * - `minimumReleaseAge` in minutes, one day unless set (p01), 0 is off
 *   (p12), an empty key is unset (pnpm 12.18.0, 2026-11-12, #247); from
 *   `pnpm_config_minimum_release_age` (p10), then the project's
 *   `pnpm-workspace.yaml` (p13), then the global `config.yaml` (p14);
 * - `minimumReleaseAgeExclude`: names and globs whose `*` crosses `/`
 *   (`p-*`, `@acme/*`), each with an optional `@<exact versions>`
 *   (`p-fresh@1.0.2`, `p-fresh@1.0.1 || 1.0.2`) (p02-p05, p19); a range is
 *   an error pnpm fails on (p18);
 * - a version with no publish time is let through (p08), unless
 *   `minimumReleaseAgeIgnoreMissingTime: false`, where pnpm fails (p17).
 * With nothing old enough pnpm installs the lowest satisfying version (p06,
 * p15, p16; `minimumReleaseAgeStrict` fails instead, p07): autd then leaves
 * the package where it is.
 */
export const pnpmReleaseAgeGate = (
  cwd: string,
  sources: NpmrcSources,
): ReleaseAgeGate => {
  const env = envLayer(sources.env, PNPM_ENV).values
  const files = [
    readYaml(path.join(cwd, 'pnpm-workspace.yaml')),
    readYaml(path.join(pnpmConfigDir(cwd, sources), 'config.yaml')),
  ]
  const setting = (yamlKey: string, envKey: string): YamlNode | undefined => {
    const fromEnv = env[envKey]
    if (typeof fromEnv === 'string') return fromEnv
    return files.find((file) => file[yamlKey] !== undefined)?.[yamlKey]
  }

  // An empty key (`minimumReleaseAge:`, null or blank) is unset to pnpm, so
  // its default applies; `Number` would read it as 0, which is off (#247).
  const rawAge = setting('minimumReleaseAge', 'minimum-release-age')
  const age =
    rawAge === null || rawAge === undefined || String(rawAge).trim() === ''
      ? Number.NaN
      : Number(rawAge)
  const exclude = setting(
    'minimumReleaseAgeExclude',
    'minimum-release-age-exclude',
  )
  const patterns = Array.isArray(exclude)
    ? exclude.filter((item): item is string => typeof item === 'string')
    : typeof exclude === 'string'
      ? [exclude]
      : []
  const ignoreMissing = setting(
    'minimumReleaseAgeIgnoreMissingTime',
    'minimum-release-age-ignore-missing-time',
  )
  return {
    setting: 'minimumReleaseAge',
    minutes: Number.isFinite(age) && age >= 0 ? age : PNPM_DEFAULT_RELEASE_AGE,
    scopes: {},
    exempt: patterns.map((pattern) => exemptionOf(pattern, 'any')),
    missingTime: ignoreMissing === 'false' ? 'held' : 'allowed',
  }
}
