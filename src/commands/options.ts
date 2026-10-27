import { Option } from 'commander'
import { supportedManagers } from '@/managers'

/** `--pm <manager>`: use this manager instead of detecting one. */
export const pmOption = (): Option =>
  new Option(
    '--pm <manager>',
    'Package manager to use, instead of detecting it',
  ).choices(supportedManagers)

/** `--no-cache`: ask the registries instead of autd's cache. */
export const noCacheOption = (): Option =>
  new Option('--no-cache', "Ask the registries instead of using autd's cache")
