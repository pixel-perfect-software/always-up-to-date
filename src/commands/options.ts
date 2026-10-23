import { Option } from 'commander'
import { supportedManagers } from '@/managers'

/** `--pm <manager>`: use this manager instead of detecting one. */
export const pmOption = (): Option =>
  new Option(
    '--pm <manager>',
    'Package manager to use, instead of detecting it',
  ).choices(supportedManagers)
