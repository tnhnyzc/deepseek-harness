/**
 * Stage 7 application-menu unit coverage: the template builder's closed
 * structure (menu per SPEC §16), the platform accelerators, the dev-gated
 * Developer Tools, the dispatch of every UX item onto the closed command
 * vocabulary, and the vocabulary itself — including the preload's CJS
 * mirror, which is source-pinned in lockstep because a sandboxed preload
 * cannot import the ESM shared module. Also the IPC channel inventory
 * regression: desktop main may only ever name the known bridge channels.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Menu, MenuItemConstructorOptions } from 'electron'
import { buildApplicationMenuTemplate, DESKTOP_APP_NAME } from '../src/main/menu.ts'
import { DESKTOP_COMMANDS, isDesktopCommand } from '../src/shared/desktop-command.ts'

interface TemplateItem {
  label?: string
  role?: string
  type?: string
  accelerator?: string | null
  enabled?: boolean
  /**
   * The template's own click closures take no arguments; the `never[]`
   * keeps Electron's 3-argument signature assignable while the test fires
   * them bare.
   */
  click?: (...args: never[]) => void
  submenu?: Menu | MenuItemConstructorOptions[]
}

/** The visible name of a template entry: role items (editMenu, close) and separators carry no label in the template. */
function name(entry: TemplateItem): string {
  return entry.label ?? entry.role ?? (entry.type === 'separator' ? 'separator' : 'unknown')
}

/** The item's submenu entries as template items (the builder always emits arrays, never Menu instances). */
function children(item: TemplateItem | undefined): TemplateItem[] {
  const submenu = item?.submenu
  if (submenu === undefined) return []
  if (Array.isArray(submenu)) return submenu
  // The builder only constructs arrays; the Menu arm is kept for the type and is unreachable in this suite.
  return submenu.items as unknown as TemplateItem[]
}

function template(overrides: { isMac?: boolean; devToolsAvailable?: boolean; send?: (command: string) => void; about?: () => void } = {}) {
  const sent: string[] = []
  const abouts: number[] = []
  const items = buildApplicationMenuTemplate({
    appName: DESKTOP_APP_NAME,
    isMac: overrides.isMac ?? false,
    devToolsAvailable: overrides.devToolsAvailable ?? false,
    sendCommand: (command) => {
      sent.push(command)
      overrides.send?.(command)
    },
    showAbout: () => {
      abouts.push(1)
      overrides.about?.()
    },
  }) as TemplateItem[]
  return { items, sent, abouts }
}

/** Find by top-down label path and return the item itself (not its children). */
function findSelf(items: TemplateItem[], path: string[]): TemplateItem | undefined {
  let pool = items
  for (const label of path) {
    const item = pool.find(candidate => candidate.label === label)
    if (item === undefined) return undefined
    if (label === path[path.length - 1]) return item
    pool = children(item)
  }
  return undefined
}

describe('application menu template', () => {
  it('offers the SPEC menu set on non-macOS platforms', () => {
    const { items } = template()
    expect(items.map(name)).toEqual(['File', 'editMenu', 'View', 'Session', 'Help'])
  })

  it('adds the macOS application and Window menus', () => {
    const { items } = template({ isMac: true })
    expect(items.map(name)).toEqual([
      DESKTOP_APP_NAME, 'File', 'editMenu', 'View', 'Session', 'Window', 'Help',
    ])
  })

  it('binds the platform accelerators to the SPEC shortcuts', () => {
    const { items } = template()
    expect(findSelf(items, ['File', 'New Session'])?.accelerator).toBe('CmdOrCtrl+N')
    expect(findSelf(items, ['File', 'Open Workspace…'])?.accelerator).toBe('CmdOrCtrl+O')
    expect(findSelf(items, ['View', 'Toggle Sidebar'])?.accelerator).toBe('CmdOrCtrl+\\')
    const { items: macItems } = template({ isMac: true })
    expect(findSelf(macItems, [DESKTOP_APP_NAME, 'Settings…'])?.accelerator).toBe('CmdOrCtrl+,')
    // Esc keeps the pinned UI's own semantics: no menu item claims it.
    for (const item of [items, macItems].flat()) {
      expect(item.accelerator).not.toBe('Esc')
    }
  })

  it('gates Developer Tools on development builds', () => {
    const viewOf = (isMac: boolean, dev: boolean): string[] =>
      children(template({ isMac, devToolsAvailable: dev }).items.find(item => item.label === 'View'))
        .map(entry => entry.role ?? entry.label ?? '')
    expect(viewOf(false, true)).toContain('toggleDevTools')
    expect(viewOf(false, false)).not.toContain('toggleDevTools')
    expect(viewOf(true, true)).toContain('toggleDevTools')
    expect(viewOf(true, false)).not.toContain('toggleDevTools')
  })

  it('keeps the SPEC File and Session items in order', () => {
    const { items } = template()
    expect(children(findSelf(items, ['File'])).map(name))
      .toEqual(['New Session', 'Open Workspace…', 'separator', 'close'])
    expect(children(findSelf(items, ['Session'])).map(entry => entry.label ?? ''))
      .toEqual(['New Session', 'Cancel Current Run', 'Rename Session'])
  })

  it('keeps the disabled Help placeholders and the non-mac About', () => {
    const { items, abouts } = template()
    const help = children(findSelf(items, ['Help']))
    const docs = help.find(entry => entry.label === 'DeepSeek Harness Documentation')
    const logs = help.find(entry => entry.label === 'View Runtime Logs')
    expect(docs?.enabled).toBe(false)
    expect(logs?.enabled).toBe(false)
    const about = help.find(entry => entry.label === `About ${DESKTOP_APP_NAME}`)
    expect(about).toBeDefined()
    about?.click?.()
    expect(abouts).toEqual([1])
    // macOS carries About in the application menu instead.
    const { items: macItems } = template({ isMac: true })
    const macHelp = children(findSelf(macItems, ['Help']))
    expect(macHelp.some(entry => entry.label?.startsWith('About ') === true)).toBe(false)
    expect(children(macItems[0]).some(entry => entry.role === 'about')).toBe(true)
  })

  it('dispatches every UX item onto the closed command vocabulary', () => {
    const { items, sent } = template({ isMac: true })
    findSelf(items, ['File', 'New Session'])?.click?.()
    findSelf(items, ['File', 'Open Workspace…'])?.click?.()
    findSelf(items, ['View', 'Toggle Sidebar'])?.click?.()
    findSelf(items, ['Session', 'New Session'])?.click?.()
    findSelf(items, ['Session', 'Cancel Current Run'])?.click?.()
    findSelf(items, ['Session', 'Rename Session'])?.click?.()
    findSelf(items, [DESKTOP_APP_NAME, 'Settings…'])?.click?.()
    expect(sent).toEqual([
      'new-session',
      'open-workspace',
      'toggle-sidebar',
      'new-session',
      'cancel-run',
      'rename-session',
      'open-settings',
    ])
  })
})

describe('the closed desktop command vocabulary', () => {
  it('is the complete stage 7 intent set', () => {
    expect([...DESKTOP_COMMANDS]).toEqual([
      'new-session',
      'open-workspace',
      'cancel-run',
      'rename-session',
      'open-settings',
      'toggle-sidebar',
    ])
  })

  it('accepts only vocabulary members', () => {
    for (const command of DESKTOP_COMMANDS) expect(isDesktopCommand(command)).toBe(true)
    expect(isDesktopCommand('session.delete')).toBe(false)
    expect(isDesktopCommand('SESSION.NEW')).toBe(false)
    expect(isDesktopCommand('')).toBe(false)
    expect(isDesktopCommand({})).toBe(false)
    expect(isDesktopCommand(null)).toBe(false)
  })

  it('pins the preload mirror in lockstep', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'preload', 'index.cjs'), 'utf8')
    const setBlock = source.match(/new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
    const mirrored = new Set([...setBlock.matchAll(/'([^']+)'/g)].map(entry => entry[1]))
    expect(mirrored).toEqual(new Set(DESKTOP_COMMANDS))
  })
})

describe('desktop IPC channel inventory', () => {
  /** The complete set of channel names desktop main may ever name. */
  const KNOWN_CHANNELS = new Set([
    'dsh-desktop:runtime-state',
    'dsh-desktop:runtime-get',
    'dsh-desktop:runtime-restart',
    'dsh-desktop:boot-graph',
    'dsh-desktop:transport-open',
    'dsh-desktop:transport-port',
    'dsh-desktop:transport-denied',
    'dsh-desktop:command',
  ])

  function listSources(root: string): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        const stats = statSync(path)
        if (stats.isDirectory()) walk(path)
        else if (entry.endsWith('.ts')) out.push(path)
      }
    }
    walk(root)
    return out
  }

  it('main and shared name only known bridge channels', () => {
    const desktopRoot = resolve(import.meta.dirname, '..')
    const sources = [...listSources(join(desktopRoot, 'src', 'main')), ...listSources(join(desktopRoot, 'src', 'shared'))]
    const named = new Set<string>()
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/'(dsh-desktop:[a-z-]+)'/g)) named.add(match[1] ?? '')
    }
    // The scan is not vacuous: it sees the bridge itself.
    expect(named.has('dsh-desktop:command')).toBe(true)
    expect(named.has('dsh-desktop:transport-open')).toBe(true)
    expect(named).toEqual(KNOWN_CHANNELS)
  })
})
