/**
 * The Electron main process's OS capability registry: the two closed
 * capabilities the desktop native protocol can request — the OS directory
 * chooser and the default-application path opener. Only OS capability
 * vocabulary lives here: no DSH business concept, no request routing (the
 * native channel owns that), and the Electron API surface itself is an
 * injectable port so the capability behavior is testable without an
 * Electron runtime.
 * @module @deepseek-ai/dsh-desktop/src/main/native-capabilities
 */

import { dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import type { NativeErrorCode } from '@deepseek-ai/dsh-desktop-runtime/native'

/** One capability invocation's failure, tagged with the closed channel code. */
export class NativeCapabilityError extends Error {
  constructor(readonly code: NativeErrorCode, message: string) {
    super(message)
    this.name = 'NativeCapabilityError'
  }
}

/**
 * The OS operations the capabilities call. The real implementation binds the
 * Electron `dialog` and `shell` modules; tests inject fakes.
 */
export interface NativeCapabilityPorts {
  /**
   * Open the OS directory chooser.
   * @param window - the modal parent, or undefined when none is open.
   * @returns the operator's outcome; an empty selection is a cancel.
   */
  showOpenDialog: (window: BrowserWindow | undefined) => Promise<{ canceled: boolean; filePaths: string[] }>
  /**
   * Open one path with the default application.
   * @param path - the absolute path to open.
   * @returns the failure description; the empty string means success.
   */
  openPath: (path: string) => Promise<string>
}

/** The registry surface the native channel dispatches onto. */
export interface NativeCapabilities {
  /**
   * Open the OS directory chooser.
   * @param window - the modal parent, or undefined when none is open.
   * @returns the chosen absolute path, or null when the operator cancels.
   */
  pickDirectory(window: BrowserWindow | undefined): Promise<string | null>
  /**
   * Open one path with the default application.
   * @param path - the absolute path the DSH layer resolved and authorized.
   */
  openPath(path: string): Promise<void>
}

/**
 * The Electron port binding. Under a plain Node test runtime the `electron`
 * package resolves without a display, so this default is only reachable in
 * the real shell — suites inject ports.
 */
function electronPorts(): NativeCapabilityPorts {
  return {
    showOpenDialog: (window): Promise<{ canceled: boolean; filePaths: string[] }> => {
      return window === undefined
        ? dialog.showOpenDialog({ properties: ['openDirectory'] })
        : dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    },
    openPath: (path): Promise<string> => shell.openPath(path),
  }
}

/**
 * Create the OS capability registry.
 * @param ports - the OS operations (defaults to the Electron binding).
 * @returns the two closed capabilities.
 */
export function createNativeCapabilities(ports: NativeCapabilityPorts = electronPorts()): NativeCapabilities {
  return {
    pickDirectory: async (window): Promise<string | null> => {
      let outcome: { canceled: boolean; filePaths: string[] }
      try {
        outcome = await ports.showOpenDialog(window)
      } catch (error) {
        throw new NativeCapabilityError('dialog-failed', boundedMessage(error, 'the directory chooser could not be opened'))
      }
      if (outcome.canceled) return null
      const path = outcome.filePaths[0]
      return path === undefined || path === '' ? null : path
    },
    openPath: async (path): Promise<void> => {
      let failure: string
      try {
        failure = await ports.openPath(path)
      } catch (error) {
        throw new NativeCapabilityError('open-failed', boundedMessage(error, 'the path could not be opened'))
      }
      if (failure !== '') {
        throw new NativeCapabilityError('open-failed', failure.slice(0, MAX_DIAGNOSTIC_CHARS))
      }
    },
  }
}

/** The diagnostic bound: a channel message never carries more than this. */
export const MAX_DIAGNOSTIC_CHARS = 512

/**
 * Reduce one thrown value to a bounded, redaction-safe message.
 * @param error - the thrown value.
 * @param fallback - the message when the value carries none.
 * @returns the bounded message.
 */
function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message !== '' ? error.message : fallback
  return message.slice(0, MAX_DIAGNOSTIC_CHARS)
}
