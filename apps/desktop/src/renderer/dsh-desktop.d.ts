import type { DshDesktopApi } from '../shared/runtime-state.ts'

declare global {
  interface Window {
    dshDesktop: DshDesktopApi
  }
}

export {}
