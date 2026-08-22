import { defineConfig } from 'tsdown'

/**
 * The desktop runtime ships one entry: the bundle Electron's supervisor forks
 * under the packaged Node. The root tsdown builds only `lib/types/index.js`,
 * so this override bundles it to `dist/index.js`; its reachable modules
 * (app boot, Cordis, the include builtin) inline with it. Declarations come
 * from `tsc -b` (dts: false).
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
})
