import path from 'path'
import { type Manager, parseSelection } from '../__tests__/integration/harness'

/**
 * What the benchmark times: the five managers, with yarn berry twice. `berry`
 * is berry as installed, Plug'n'Play (yarn's default and what its users get);
 * `berry-nm` is its node-modules linker, the row the 2.1.0 baseline measured.
 */
export const TARGETS = [
  'npm',
  'pnpm',
  'yarn',
  'berry',
  'berry-nm',
  'bun',
] as const
export type Target = (typeof TARGETS)[number]

/** The package manager a target runs. */
export const managerOf = (target: Target): Manager =>
  target === 'berry-nm' ? 'berry' : target

/** `AUTD_BENCH_PM`: a comma-separated selection; unset or blank runs every target. */
export const selectedTargets = (value: string | undefined): Target[] =>
  parseSelection(value, TARGETS, 'AUTD_BENCH_PM')

/** `AUTD_BENCH_RUNS`: how many timed runs each `check` measurement gets; unset or blank is `fallback`. */
export const runsFrom = (
  value: string | undefined,
  fallback: number,
): number => {
  if (value === undefined || value.trim() === '') return fallback

  const runs = Number(value)
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`AUTD_BENCH_RUNS: ${value} is not a positive integer`)
  }
  return runs
}

/**
 * Where each cache that "cold" empties lives, under `root`: the environment
 * that points the manager there and the directories removed before each run.
 * Berry keeps no registry metadata cache (`yarn npm info` is as slow with its
 * global folder full), so its cold and warm times differ only by noise.
 *
 * autd has no cache of its own yet. When it gets one (#108), the cold prepare
 * must empty the folder autd uses on each platform (`~/Library/Caches/…` on
 * macOS, where `XDG_CACHE_HOME` has no effect), or the override variable #108
 * adds, pointed into `root` through `env`: add it to `env` and `dirs` here.
 */
export const coldCaches = (
  target: Target,
  root: string,
): { env: Record<string, string>; dirs: string[] } => {
  const dir = path.join(root, target)
  switch (managerOf(target)) {
    case 'npm':
      return { env: { npm_config_cache: dir }, dirs: [dir] }
    case 'pnpm':
      return {
        env: { npm_config_cache_dir: dir, pnpm_config_cache_dir: dir },
        dirs: [dir],
      }
    case 'yarn':
      return { env: { YARN_CACHE_FOLDER: dir }, dirs: [dir] }
    case 'berry':
      return { env: { YARN_GLOBAL_FOLDER: dir }, dirs: [dir] }
    case 'bun':
      return { env: { BUN_INSTALL_CACHE_DIR: dir }, dirs: [dir] }
  }
}
