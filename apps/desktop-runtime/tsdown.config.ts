import { defineConfig } from 'tsdown'

/**
 * The desktop runtime ships four entries: the bundle Electron's supervisor
 * forks under the packaged Node (`dist/index.js`, inlining its reachable
 * modules — app boot, Cordis, the include builtin, the host apiproxy seam),
 * the standalone transport protocol module (`dist/transport.js`) the desktop
 * app's main and renderer faces import, the native capability protocol
 * module (`dist/native.js`) the desktop app's main face imports, and the
 * desktop directory-picker plugin (`dist/directory-picker.js`) the
 * composition loads by file path as the `ctx.directoryPicker` provider.
 * Declarations come from `tsc -b` (dts: false).
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/transport.js', 'lib/types/native.js', 'lib/types/directory-picker.js'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
})
