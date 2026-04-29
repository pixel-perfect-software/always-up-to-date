import type { ReleaseType } from 'semver'
import type { CooldownByType, CooldownConfig } from '@/types'
import { MS_PER_DAY, parseDuration } from './duration'

export interface NormalizedCooldown {
  patch: number
  minor: number
  major: number
}

export const normalizeCooldown = (
  cooldown: CooldownConfig | undefined,
): NormalizedCooldown => {
  if (cooldown === undefined || cooldown === null) {
    return { patch: 0, minor: 0, major: 0 }
  }

  if (typeof cooldown === 'number' || typeof cooldown === 'string') {
    const days = parseDuration(cooldown)
    return { patch: days, minor: days, major: days }
  }

  const obj = cooldown as CooldownByType
  return {
    patch: parseDuration(obj.patch),
    minor: parseDuration(obj.minor),
    major: parseDuration(obj.major),
  }
}

export const isCooldownEnabled = (cooldown: CooldownConfig | undefined) => {
  const n = normalizeCooldown(cooldown)
  return n.patch > 0 || n.minor > 0 || n.major > 0
}

export const cooldownDaysFor = (
  cooldown: CooldownConfig | undefined,
  updateType: ReleaseType | null,
): number => {
  const n = normalizeCooldown(cooldown)
  switch (updateType) {
    case 'major':
    case 'premajor':
      return n.major
    case 'minor':
    case 'preminor':
      return n.minor
    case 'patch':
    case 'prepatch':
    case 'prerelease':
      return n.patch
    default:
      return 0
  }
}

export interface CooldownEvaluation {
  gated: boolean
  ageDays: number | undefined
  requiredDays: number
}

export const evaluateCooldown = (
  releaseTimeIso: string | undefined,
  updateType: ReleaseType | null,
  cooldown: CooldownConfig | undefined,
  now: number = Date.now(),
): CooldownEvaluation => {
  const requiredDays = cooldownDaysFor(cooldown, updateType)
  if (requiredDays <= 0) {
    return { gated: false, ageDays: undefined, requiredDays: 0 }
  }
  if (!releaseTimeIso) {
    return { gated: false, ageDays: undefined, requiredDays }
  }
  const releasedAt = Date.parse(releaseTimeIso)
  if (Number.isNaN(releasedAt)) {
    return { gated: false, ageDays: undefined, requiredDays }
  }
  const ageDays = (now - releasedAt) / MS_PER_DAY
  return {
    gated: ageDays < requiredDays,
    ageDays,
    requiredDays,
  }
}
