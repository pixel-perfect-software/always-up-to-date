import type { SupportedPackageManager } from '@/types'
import type { ManagerAdapter } from './adapter'
import bun from './bun'
import npm from './npm'
import pnpm from './pnpm'
import yarn from './yarn'

export type {
  ApplyPlan,
  ManagerAdapter,
  RunManager,
  Workspace,
} from './adapter'

/**
 * Every supported manager. Lockfile detection checks them in this order and
 * keeps the last match.
 */
export const adapters = {
  npm,
  yarn,
  pnpm,
  bun,
} satisfies Record<SupportedPackageManager, ManagerAdapter>

export const adapterFor = (name: SupportedPackageManager): ManagerAdapter =>
  adapters[name]
