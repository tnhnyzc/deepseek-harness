import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const rendererRoot = fileURLToPath(new URL('./src/renderer', import.meta.url))

/**
 * Renderer build: the thin shell page under dsh-app://. Stage 4 starts the
 * DSH client application tree from this same entry; the Web UI's chunking
 * and plugin machinery is not part of this build.
 */
export default defineConfig({
  root: rendererRoot,
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
})
