import type { Reason, UpdateResult } from '@/types'
import logger from '@/utils/logger'
import type { UpdatePolicy } from '@/utils/updateChecker'
import { heldFor, withWarning } from './rows'
import type { PlanRegistry } from './types'

/** The most of a registry's message a report row shows. */
const MESSAGE_LIMIT = 400

/**
 * A registry's deprecation message on one line, as it lands in a terminal
 * row: line breaks, other control characters (an escape sequence's ESC among
 * them), zero-width and bidirectional formatting characters (which can make
 * a row read as something else) and runs of spaces become one space, and a
 * message past `MESSAGE_LIMIT` characters is cut with `…`.
 */
export const oneLine = (text: string): string => {
  const line = text
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g,
      ' ',
    )
    .trim()
  return line.length > MESSAGE_LIMIT
    ? `${line.slice(0, MESSAGE_LIMIT).trimEnd()}…`
    : line
}

/**
 * Holds a moving row whose target the registry marks deprecated
 * (`deprecated: <message>`, #195); a `latest` rule moves it anyway, with the
 * message as a warning. When the installed version carries the same
 * deprecation, the move takes on nothing it doesn't have, so it goes ahead
 * with the warning: holding would keep an older deprecated version (every
 * next 14.0.x, for one). It judges the final target, so it runs after the cooldown, whose
 * fallbacks are never deprecated. It reads only the session's own lookups.
 */
export const holdDeprecated = async (
  results: UpdateResult[],
  registry: PlanRegistry,
  policy: UpdatePolicy,
  lookupName: (row: UpdateResult) => string,
): Promise<UpdateResult[]> => {
  const { lookedUp } = registry
  if (!lookedUp) return results
  return Promise.all(
    results.map(async (result) => {
      const { target, current } = result
      if (!result.updated || !target) return result
      const name = lookupName(result)
      const found = await lookedUp(name)
      if (!found) {
        logger.debug(
          `No lookup of ${name} in this session; its deprecation isn't checked`,
        )
        return result
      }
      if (!found.ok) return result
      const { versions } = found.package
      const deprecation = versions.find((v) => v.version === target)
      if (!deprecation?.deprecated) return result

      const message = oneLine(deprecation.deprecatedReason ?? '')
      const reason: Reason = {
        code: 'deprecated',
        message: `deprecated: ${message || 'no message given'}`,
      }
      // The installed version carries the same deprecation, so the move takes
      // on nothing new; a different message is a new reason, and holds.
      const installed = versions.find((v) => v.version === current)
      const sameAsInstalled =
        installed?.deprecated === true &&
        oneLine(installed.deprecatedReason ?? '') === message
      return sameAsInstalled || policy.ruleFor(result.name) === 'latest'
        ? withWarning(result, reason)
        : heldFor(result, reason)
    }),
  )
}
