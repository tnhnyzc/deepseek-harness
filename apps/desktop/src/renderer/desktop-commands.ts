/**
 * The renderer face of the stage 7 desktop UX command bridge: the native
 * application menu (Electron main) can only express the closed
 * `DesktopCommand` vocabulary, and this module translates each intent into
 * the existing pinned DSH client UI action it names — a DOM gesture on the
 * live client tree. It owns no Harness semantics: it clicks the same
 * affordances a user would click (New session, the add-workspace button
 * whose add-only picker raises the composed directory flow into
 * `host.pickDirectory`, the composer's Stop, the selected row's Rename, the
 * settings trigger, the sidebar fold), and the pinned client does the rest.
 * While the shell screens are up (no live client tree) and for states the
 * tree cannot act on (no selected row, nothing generating, no picking
 * affordance), a command is a deterministic no-op — the menu stays safe in
 * every state instead of the page guessing.
 * The pinned client paints product copy in its active locale (zh or en), so
 * each gesture matches the closed label set of both shipped locales rather
 * than one language's strings.
 * @module @deepseek-ai/dsh-desktop/src/renderer/desktop-commands
 */
import type { DesktopCommand } from '../shared/desktop-command.ts'

/** Closed label sets per affordance, one entry per shipped locale (zh, en). */
const NEW_SESSION_LABELS = ['新建会话', 'New session'] as const
const ADD_WORKSPACE_LABELS = ['添加工作区', 'Add workspace'] as const
const STOP_GENERATING_LABELS = ['停止生成', 'Stop generating'] as const
const SIDEBAR_TOGGLE_LABELS = ['打开侧边栏', '收起侧边栏', 'Open sidebar', 'Collapse sidebar'] as const

/**
 * The first enabled button carrying one of the labels, or nothing.
 * @param scope - the node scope searched (document, or a column for scoped affordances)
 * @param labels - the closed locale label set
 * @returns the affordance button when the tree renders it in the current state
 */
function findButton(scope: ParentNode, labels: readonly string[]): HTMLButtonElement | undefined {
  for (const label of labels) {
    const button = scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    if (button !== null) return button
  }
  return undefined
}

/** The pinned client's root frame: ui-layout AppFrame's inline grid-template-columns style. */
function frame(): HTMLElement | undefined {
  const found = document.querySelector<HTMLElement>('#root [style*="grid-template-columns"]')
  return found !== null ? found : undefined
}

/** The frame's first column: the sidebar (wide or rail). */
function sidebar(): HTMLElement | undefined {
  const first = frame()?.firstElementChild
  return first instanceof HTMLElement ? first : undefined
}

/** Let one frame settle: React state updates from a dispatched gesture flush before the next animation frame. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve()
    })
  })
}

/**
 * The selected row's Rename gesture. Row-action menus portal to
 * document.body and stay open until Escape or an outside pointer, so a
 * previous gesture's menu is dismissed first (its document keydown listener
 * closes on Escape); the rename target is then the selected row's own menu,
 * whose first item is Rename (the pinned source's fixed item order:
 * rename, fork, archive).
 */
async function renameSelectedSession(): Promise<void> {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await nextFrame()
  const row = document.querySelector<HTMLElement>('div[role="treeitem"][aria-selected="true"]')
  const action = row?.querySelector('button')
  if (!(action instanceof HTMLButtonElement)) return
  action.click()
  await nextFrame()
  const firstItem = document.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]')
  if (firstItem !== null) firstItem.click()
}

async function execute(command: DesktopCommand): Promise<void> {
  switch (command) {
    case 'new-session': {
      findButton(document, NEW_SESSION_LABELS)?.click()
      return
    }
    case 'open-workspace': {
      // The add-only picker consumes the open and raises the composed
      // directory flow directly (no intermediate menu row): the native
      // occupant then drives host.pickDirectory into the desktop picker.
      findButton(document, ADD_WORKSPACE_LABELS)?.click()
      return
    }
    case 'cancel-run': {
      findButton(document, STOP_GENERATING_LABELS)?.click()
      return
    }
    case 'rename-session': {
      await renameSelectedSession()
      return
    }
    case 'open-settings': {
      // The settings trigger is the only aria-haspopup="dialog" button in
      // the sidebar column (the conversation's meters carry the same
      // attribute but live outside it).
      sidebar()?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')?.click()
      return
    }
    case 'toggle-sidebar': {
      findButton(document, SIDEBAR_TOGGLE_LABELS)?.click()
      return
    }
  }
}

/**
 * Install the command-bridge listener on the page: every closed-vocabulary
 * command arriving through the preload is translated into its DSH client
 * gesture while the client tree is live, and dropped otherwise.
 * @param isLive - whether the pinned client tree is currently mounted
 * @returns the listener disposer
 */
export function installDesktopCommands(isLive: () => boolean): () => void {
  const listener = (command: DesktopCommand): void => {
    if (!isLive()) return
    void execute(command).catch(() => {
      // A gesture the live tree declines (no selected row, nothing
      // generating, an affordance the current state does not render) is a
      // no-op: the menu may be safe in every state, and a refused intent
      // has no page error surface to report it.
    })
  }
  return window.dshDesktop.onDesktopCommand(listener)
}
