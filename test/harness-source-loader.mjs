// Opt-in integration support: execute the checked-out Harness source unchanged.
// Only package resolution and TypeScript erasure are supplied here; authentication,
// routing, HTTP bridging, cookie signing, and Cordis lifecycle are all upstream code.
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const packages = {
  '@deepseek-ai/cordis': 'vendor/cordis/src/index.ts',
  '@deepseek-ai/cosmokit': 'vendor/cosmokit/src/index.ts',
  '@deepseek-ai/schemastery': 'vendor/schemastery/src/index.ts',
  '@deepseek-ai/dsh-brand': 'packages/util/brand/src/index.ts',
  '@deepseek-ai/dsh-scope': 'packages/core/scope/src/index.ts',
  '@deepseek-ai/dsh-credentials': 'packages/credentials/credentials/src/index.ts',
  '@deepseek-ai/dsh-storage': 'packages/storage/storage/src/index.ts',
  '@deepseek-ai/dsh-storage-json': 'packages/storage/storage-json/src/index.ts',
}
const external = Object.fromEntries(['zod', 'compression', 'ipaddr.js', 'negotiator']
  .map(name => [name, pathToFileURL(require.resolve(name)).href]))

export async function loadHarnessSource(directory) {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('The optional Harness source integration tests require Node.js 24 or newer.')
  }
  const root = realpathSync(resolve(directory))
  const sourceUrl = path => pathToFileURL(resolve(root, path)).href
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (packages[specifier]) return { url: sourceUrl(packages[specifier]), shortCircuit: true }
      if (external[specifier]) {
        return { url: external[specifier], shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.startsWith('file:')) {
        const path = fileURLToPath(url)
        if (path.startsWith(root + sep) && path.endsWith('.ts')) {
          return {
            format: 'module',
            source: stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'transform', sourceUrl: url }),
            shortCircuit: true,
          }
        }
      }
      return nextLoad(url, context)
    },
  })
  try {
    const [{ Context }, connection, { default: WebServer }, { default: Storage }, storageJson] = await Promise.all([
      import(sourceUrl(packages['@deepseek-ai/cordis'])),
      import(sourceUrl('packages/client/connection/src/index.ts')),
      import(sourceUrl('packages/host/webserver/src/index.ts')),
      import(sourceUrl(packages['@deepseek-ai/dsh-storage'])),
      import(sourceUrl(packages['@deepseek-ai/dsh-storage-json'])),
    ])
    return { Context, connection, WebServer, Storage, storageJson, disposeLoader: () => hooks.deregister() }
  } catch (error) {
    hooks.deregister()
    throw error
  }
}
