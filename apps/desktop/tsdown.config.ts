import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships one main-process bundle. The renderer is a Vite
 * build; declarations are not published (private app).
 */
export default defineConfig({
  entry: ['src/main/index.ts'],
  outDir: 'dist/main',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: {
    neverBundle: ['electron'],
  },
})
