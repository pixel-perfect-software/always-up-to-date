// Child process for the registry cache's concurrent-writers test:
//   node -r bench/register.cjs cacheWriter.ts <dir> <count> <id>
// Puts one key <count> times with a value only this writer and write could
// have made, so a reader can tell a whole entry from a torn one.
import { createRegistryCache } from '@/utils/registryCache'

const WRITER_ENDPOINT = 'https://registry.example/'
const WRITER_NAME = 'contended'
const WRITER_VERSIONS = 300

const writerValue = (id: string, write: number) => {
  const latest = `${write}.0.0`
  return {
    latest,
    versions: [
      ...Array.from({ length: WRITER_VERSIONS }, (_, index) => ({
        version: `0.${index}.0`,
        deprecated: false,
        deprecatedReason: `${id}`,
      })),
      { version: latest, deprecated: false },
    ],
  }
}

const [dir, count, id] = process.argv.slice(2)
if (dir === undefined || count === undefined || id === undefined)
  throw new Error('usage: cacheWriter.ts <dir> <count> <id>')

const cache = createRegistryCache({ dir })
for (let write = 0; write < Number(count); write++) {
  cache.put('packument', WRITER_ENDPOINT, WRITER_NAME, writerValue(id, write), {
    cacheControl: 'public, max-age=300',
    authenticated: false,
  })
}
cache.close()
