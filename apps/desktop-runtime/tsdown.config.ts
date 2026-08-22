import { defineConfig } from 'tsdown'

/**
 * The desktop runtime ships two entries: the bundle Electron's supervisor
 * forks under the packaged Node (`dist/index.js`, inlining its reachable
 * modules — app boot, Cordis, the include builtin, the host apiproxy seam),
 * and the standalone transport protocol module (`dist/transport.js`) that
 * the desktop app's main and renderer faces import. Declarations come from
 * `tsc -b` (dts: false).
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/transport.js'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
})
