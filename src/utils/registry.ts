import type { PackageLookup, RegistryConfig } from '@/types'
import logger from './logger'
import { loadRegistryConfig } from './npmrcLoader'
import type { RegistryClient, RegistryClientOptions } from './registryClient'
import type { RegistryReader } from './registryReader'
import {
  packumentUrl,
  type RegistryEndpoints,
  registryFor,
} from './registryRequest'

/** One command run's view of the registries: its .npmrc, its client, its cache. */
export interface RegistrySession {
  /** The run's .npmrc view: loaded on the first call, the same object after. */
  registryConfig(): RegistryConfig
  /** The run's one client; node:https, node:http and zlib load on the first call. */
  client(): Promise<RegistryClient>
  /**
   * Cooldown: every version's publish time from the full packument, from the
   * registry the package manager has resolved (respects .npmrc, scoped
   * registries and auth). One request per name per run. Any failure degrades
   * to an empty map, so the cooldown gate fails open rather than blocking
   * updates.
   */
  releaseTimes(name: string): Promise<Record<string, string>>
  /**
   * Latest, versions, deprecation and publish times, from the registry the
   * package manager has resolved. One lookup per name per run. Resolves for a
   * network, HTTP or parse failure too, as `ok: false` with a reason: the
   * caller decides what a failed lookup means.
   */
  lookup(name: string): Promise<PackageLookup>
  /** Destroys the client's agents. Safe to call twice, or when no client was made. */
  close(): void
}

export interface RegistrySessionOptions {
  /** Ask deps.dev about public npm names; default true (the config default). */
  depsDev?: boolean
  /** Test seam; default `loadRegistryConfig`. */
  loadConfig?: (cwd: string) => RegistryConfig
  /** Test seam: sleep, lookup. */
  clientOptions?: RegistryClientOptions
  /** Test seam: the public registries and deps.dev's URL. */
  endpoints?: RegistryEndpoints
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Nothing is read or loaded until it is asked for: the `.npmrc` layers on the
 * first `registryConfig()`, and the client (with node:http, node:https and
 * zlib) on the first request, so `--version`, `help` and `init` never pay for
 * either.
 */
export const createRegistrySession = (
  cwd: string,
  options: RegistrySessionOptions = {},
): RegistrySession => {
  const load = options.loadConfig ?? loadRegistryConfig
  let config: RegistryConfig | undefined
  let clientRequest: Promise<RegistryClient> | undefined
  let created: RegistryClient | undefined
  let reader: Promise<RegistryReader> | undefined
  // The in-flight request is cached, not its result: a workspace asks for the
  // same package once per manifest, at the same time.
  const releaseTimeCache = new Map<string, Promise<Record<string, string>>>()

  const registryConfig = (): RegistryConfig => {
    config ??= load(cwd)
    return config
  }

  const client = (): Promise<RegistryClient> => {
    clientRequest ??= import('./registryClient').then(
      ({ createRegistryClient }) => {
        created = createRegistryClient(registryConfig(), options.clientOptions)
        return created
      },
    )
    return clientRequest
  }

  const requestReleaseTimes = async (
    packageName: string,
  ): Promise<Record<string, string>> => {
    try {
      const registry = registryFor(packageName, registryConfig())
      const packument = await (await client()).getJson(
        packumentUrl(packageName, registry),
        registry,
      )
      const time = isRecord(packument) ? packument.time : undefined
      if (!isRecord(time)) return {}
      const times: Record<string, string> = {}
      for (const [version, published] of Object.entries(time)) {
        if (typeof published === 'string') times[version] = published
      }
      return times
    } catch (error) {
      logger.debug(
        `Failed to fetch registry metadata for ${packageName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return {}
    }
  }

  // The reader loads with the first lookup, not with the CLI.
  const readerOnce = (): Promise<RegistryReader> => {
    reader ??= Promise.all([import('./registryReader'), client()]).then(
      ([{ createRegistryReader }, registryClient]) =>
        createRegistryReader({
          registryConfig: registryConfig(),
          client: registryClient,
          depsDev: options.depsDev ?? true,
          endpoints: options.endpoints,
        }),
    )
    return reader
  }

  return {
    registryConfig,
    client,
    lookup: async (name) => (await readerOnce()).lookup(name),
    releaseTimes: (name) => {
      let request = releaseTimeCache.get(name)
      if (!request) {
        request = requestReleaseTimes(name)
        releaseTimeCache.set(name, request)
      }
      return request
    },
    close: () => {
      created?.destroy()
      // A client still loading is destroyed as soon as it exists.
      void clientRequest?.then(
        (pending) => pending.destroy(),
        () => undefined,
      )
    },
  }
}
