/**
 * The closed desktop UX command vocabulary: the complete set of renderer
 * intents the native application menu can express. Electron main forwards a
 * command as a whole; the renderer translates each one into the existing
 * pinned DSH client action for it (a DOM gesture on the current UI). No
 * command is a DSH wire method and main never mutates Harness state — the
 * vocabulary is desktop UX intent only.
 * @module @deepseek-ai/dsh-desktop/src/shared/desktop-command
 */

/** The main→renderer command channel (main frame only, never broadcast). */
export const DESKTOP_COMMAND_CHANNEL = 'dsh-desktop:command'

/** The complete, closed command vocabulary. */
export const DESKTOP_COMMANDS = [
  'new-session',
  'open-workspace',
  'cancel-run',
  'rename-session',
  'open-settings',
  'toggle-sidebar',
] as const

/** One desktop UX command the renderer can be asked to perform. */
export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number]

/**
 * Whether a value crossing the command channel is a member of the closed
 * vocabulary. The preload applies it before a command ever reaches the
 * renderer page; main only ever sends vocabulary members, so a failure here
 * means a broken main, and the command is dropped rather than executed.
 * @param value - the channel payload
 * @returns true only for a string that names a vocabulary member
 */
export function isDesktopCommand(value: unknown): value is DesktopCommand {
  return typeof value === 'string' && (DESKTOP_COMMANDS as readonly string[]).includes(value)
}
