import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { clientBuildEnvironmentDefines } from '../../scripts/client-build-environment.ts'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const rendererRoot = src('./src/renderer')

/**
 * Renderer build: the single page under dsh-app://. Stage 4 builds the DSH
 * client application tree (`AppWebEntry` and its client packages, consumed
 * as built lib products) into this page. The page document stays the
 * desktop shell; module-plugin bundles are not part of this build — the
 * runtime's module registry serves their bytes over the transport and they
 * execute at boot.
 */
export default defineConfig({
  root: rendererRoot,
  build: {
    outDir: src('./dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    // One instance per shared npm identity: a bare specifier otherwise
    // resolves from the importer's directory, so a diverging range ships a
    // second React and splits hook and element identity. Entries are package
    // ids — they cover react/jsx-runtime and react-dom/client — and resolve
    // from this package's node_modules, so react must stay a devDependency
    // here. Workspace packages need no entry: pnpm links each of them to a
    // single directory.
    dedupe: ['react', 'react-dom'],
    // Workspace packages are consumed as built lib products: each resolves
    // through its own package.json exports from the importer's directory.
    // The remaining alias browserizes the vendored Cordis Loader's only
    // Node import.
    alias: [
      { find: /^node:module$/, replacement: src('./src/renderer/node-module-stub.ts') },
    ],
  },
  define: {
    ...clientBuildEnvironmentDefines(process.env),
    // vendored loader internal.ts: fromInternal() probes the Node major —
    // "0.0.0" takes neither branch, returning undefined (exactly the empty
    // internal slot the shell boot fills with the client module loader).
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    // vendored loader index.ts: envData falls to its default branch.
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
