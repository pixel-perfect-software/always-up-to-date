// `pnpm run bench` loads its TypeScript through swc, as Jest does, and resolves
// the `@/…` paths the integration harness it reuses imports from src.
const fs = require('node:fs')
const { registerHooks } = require('node:module')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { transformSync } = require('@swc/core')

const ROOT = path.join(__dirname, '..')
const NODE_MODULES = path.join(ROOT, 'node_modules') + path.sep

// Under `"type": "module"` Node starts a `.ts` entry point (bench/run.ts,
// bench/gate.ts, a test's child process) through its ESM loader, which never
// calls the hook below and cannot resolve `@/…`. A `commonjs` format with no
// source hands the file to the CommonJS loader, so the hook below compiles it.
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const filename = fileURLToPath(url)
      if (filename.startsWith(ROOT) && !filename.startsWith(NODE_MODULES)) {
        return { format: 'commonjs', source: null, shortCircuit: true }
      }
    }
    return nextLoad(url, context)
  },
})

require.extensions['.ts'] = (module, filename) => {
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    jsc: {
      parser: { syntax: 'typescript' },
      target: 'es2023',
      baseUrl: ROOT,
      paths: { '@/*': ['src/*'] },
    },
    module: { type: 'commonjs' },
  })
  module._compile(code, filename)
}
