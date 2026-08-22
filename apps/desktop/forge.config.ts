import type { ForgeConfig } from '@electron-forge/shared-types'

/**
 * Electron Forge packaging specification for the desktop shell. Forge 7's
 * CLI system check requires a hoisted pnpm layout, which this monorepo does
 * not use, so bundle assembly is driven by @electron/packager (the same
 * assembler) until a later stage settles the constraint; makers, signing,
 * and the updater join in later stages. The renderer distribution rides
 * beside the asar so the dsh-app:// protocol serves unpacked files.
 */
const config: ForgeConfig = {
  packagerConfig: {
    name: 'DeepSeek Harness Desktop',
    asar: true,
    // Copied to resources/renderer (basename); the packaged dsh-app://
    // handler serves from that directory. The `node` directory (built by
    // `bundle:node`) carries the pinned Node executable per target.
    extraResource: ['dist/renderer', 'node'],
  },
  rebuildConfig: {},
  makers: [],
}

export default config
