import type { Reason, ReasonCode } from '@/types'

const PREFIXES: [string | RegExp, ReasonCode][] = [
  ['not targeted', 'not-targeted'],
  ['not applied by ', 'not-applied'],
  [/^cooldown: \d/, 'cooldown-fallback'],
  ['cooldown: ', 'cooldown'],
  ['controlled by ', 'override'],
  ['peer conflict: ', 'peer-conflict'],
  ['deprecated: ', 'deprecated'],
  ['license change: ', 'license-change'],
  [/^engines: \d/, 'engines-fallback'],
  ['engines: ', 'engines'],
  ['held with ', 'held-with'],
  ['held by rule', 'rule-hold'],
  ['not newer than installed', 'not-newer'],
  ['invalid version', 'invalid-version'],
  ['within range', 'within-range'],
  [/ beyond the range$/, 'outside-range'],
  [/\(rule followRange\)$/, 'rule-follow-range'],
]

/**
 * The reason a test row holds for a message, with the code its text implies;
 * `code` names it where the text is not enough (a fallback's `cooldown: …`).
 */
export const reasonFor = (message: string, code?: ReasonCode): Reason => {
  if (code) return { code, message }
  const found = PREFIXES.find(([pattern]) =>
    typeof pattern === 'string'
      ? message.startsWith(pattern)
      : pattern.test(message),
  )
  if (!found) throw new Error(`No reason code for "${message}"`)
  return { code: found[1], message }
}
