import type { RegistryConfig } from '@/types'
import { pathMarker } from './registryRequest'

let source: (() => RegistryConfig) | undefined
let patterns: Array<[text: string, shown: string]> | undefined

/**
 * Where the run's registry config comes from, read on the first `scrub` that
 * needs it, so a run that prints nothing with a URL in it reads no `.npmrc`.
 * One config per run; a new source replaces the last.
 */
export const trackRegistries = (load: () => RegistryConfig): void => {
  source = load
  patterns = undefined
}

/**
 * For each configured registry whose path is not the origin root: the URL
 * (`https://h/SECRET/acme`) and its nerf-dart form (`//h/SECRET/acme`),
 * longest first, each shown as `describeUrl` shows the registry:
 * `https://h/…[3fa9c1]`.
 */
const build = (config: RegistryConfig): Array<[string, string]> => {
  const found = new Map<string, string>()
  for (const registry of [
    config.registry,
    ...Object.values(config.scopedRegistries),
  ]) {
    try {
      const url = new URL(registry.trim())
      const path = url.pathname.replace(/\/+$/, '')
      if (path === '') continue
      const marker = pathMarker(path)
      found.set(`${url.origin}${path}`, `${url.origin}/${marker}`)
      found.set(`//${url.host}${path}`, `//${url.host}/${marker}`)
    } catch {
      // A registry that does not parse has nothing to match.
    }
  }
  return [...found].sort((a, b) => b[0].length - a[0].length)
}

/**
 * Text from outside autd (a manager's stderr, a message) with every
 * configured registry that has a path shown the way `describeUrl` shows it.
 * The single exit for the logger and `reportFailure`.
 */
export const scrub = (text: string): string => {
  if (!source || !text.includes('//')) return text
  if (!patterns) {
    try {
      patterns = build(source())
    } catch {
      patterns = []
    }
  }
  let result = text
  for (const [hidden, shown] of patterns) {
    result = result.split(hidden).join(shown)
  }
  return result
}
