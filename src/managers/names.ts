/**
 * Every supported manager, in `adapters` order (./index.ts). Imports no
 * adapter, so the CLI's options load without one. `SupportedPackageManager`
 * (src/types.ts) is derived from it, and `adapters` must have one entry for
 * each.
 */
export const supportedManagers = ['npm', 'yarn', 'pnpm', 'bun'] as const
