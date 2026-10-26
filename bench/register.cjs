// `pnpm run bench` loads its TypeScript through swc, as Jest does, and resolves
// the `@/…` paths the integration harness it reuses imports from src.
const fs = require('node:fs')
const path = require('node:path')
const { transformSync } = require('@swc/core')

const ROOT = path.join(__dirname, '..')

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
