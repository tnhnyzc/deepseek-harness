/**
 * The renderer entry: owns the single `#root` for both the shell lifecycle
 * projection and the DSH client tree. The shell screens (stage 2/3) project
 * the supervised runtime lifecycle; once the runtime reports ready, the
 * existing DSH client application — `AppWebEntry` over the same client
 * packages the browser web UI uses — takes over the same root. It boots from
 * the desktop carrier (the pinned `__DSH_TRANSPORT__` seam over the stage 3
 * transport) and the runtime-published boot payload (entry graph, module
 * loader facade, preload bundle urls), so the page document stays the
 * desktop-owned shell and the pinned client tree runs unmodified. When the
 * runtime leaves the ready state, the app tree and its transport are torn
 * down and the shell projection resumes.
 * @module @deepseek-ai/dsh-desktop/src/renderer/main
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import './styles.css'
import type { DshBootPayload, RuntimeStateView } from '../shared/runtime-state.ts'
import { installDesktopCommands } from './desktop-commands.ts'
import { evaluateClassicScript, installDesktopCarrier, loadClientBundle } from './dsh-carrier.ts'
import { createDesktopTransport, type DesktopTransport } from './transport.ts'

const foundRoot = document.getElementById('root')
if (foundRoot === null) throw new Error('desktop renderer: missing #root')
const root: HTMLElement = foundRoot

let app: AppWebEntry | undefined
let transport: DesktopTransport | undefined
let booting = false
let appError: string | undefined

function clear(): void {
  root.replaceChildren()
}

function title(text: string): void {
  const heading = document.createElement('h1')
  heading.className = 'shell-title'
  heading.textContent = 'DeepSeek Harness'
  const status = document.createElement('p')
  status.className = 'shell-status'
  status.textContent = text
  const main = document.createElement('main')
  main.className = 'shell-state'
  main.append(heading, status)
  root.append(main)
}

function renderStarting(): void {
  clear()
  title('Starting Harness…')
}

function renderReady(view: RuntimeStateView): void {
  clear()
  const ready = view.ready
  title(
    ready === undefined
      ? 'Harness ready'
      : `Harness ready — runtime ${ready.runtimeVersion}, DSH ${ready.dshVersion}`,
  )
}

function renderStopping(): void {
  clear()
  title('Stopping Harness…')
}

function renderStopped(): void {
  clear()
  title('Harness stopped')
}

function renderFailed(view: RuntimeStateView): void {
  clear()
  const main = document.createElement('main')
  main.className = 'shell-state'
  const heading = document.createElement('h1')
  heading.className = 'shell-title'
  heading.textContent = 'DeepSeek Harness'
  const status = document.createElement('p')
  status.className = 'shell-status'
  status.textContent =
    view.state === 'failed'
      ? view.reason ?? 'Harness failed'
      : `Failed to start the Harness UI: ${appError ?? 'unknown error'}`
  main.append(heading, status)
  if (view.state === 'failed' && view.diagnostics !== undefined && view.diagnostics !== '') {
    const diagnostics = document.createElement('pre')
    diagnostics.className = 'shell-diagnostics'
    diagnostics.textContent = view.diagnostics
    main.append(diagnostics)
  }
  const button = document.createElement('button')
  button.className = 'shell-restart'
  button.textContent = 'Restart'
  button.addEventListener('click', () => {
    button.disabled = true
    if (view.state === 'failed') {
      void window.dshDesktop.requestRestart().then(() => {
        button.disabled = false
      })
    } else {
      // The runtime is healthy; the bootstrap failed — relaunch the page
      // (fresh transport, fresh payload pull) instead of a runtime restart.
      location.reload()
    }
  })
  main.append(button)
  root.append(main)
}

function render(view: RuntimeStateView): void {
  root.dataset.state = view.state
  if (app !== undefined) {
    // The DSH tree owns the root; the shell never paints over it.
    return
  }
  switch (view.state) {
    case 'starting':
      renderStarting()
      break
    case 'ready':
      if (appError !== undefined) renderFailed(view)
      else renderReady(view)
      break
    case 'stopping':
      renderStopping()
      break
    case 'stopped':
      renderStopped()
      break
    case 'failed':
      renderFailed(view)
      break
  }
}

/** Dispose the app tree and its transport; safe to call when nothing is live. */
async function teardownApp(): Promise<void> {
  const current = app
  app = undefined
  const port = transport
  transport = undefined
  // Dispose the tree first: it stops its stream controllers on a live
  // transport, so no operation is left pending for the channel teardown to
  // reject.
  if (current !== undefined) {
    try {
      await current.dispose()
    } catch {
      // Disposal raced a channel loss: the tree is already gone.
    }
  }
  if (port !== undefined) port.close()
}

/** Boot the DSH client tree into the shared root; a failure is projected on the shell. */
async function startApp(): Promise<void> {
  booting = true
  appError = undefined
  try {
    const port = await window.dshDesktop.openTransport()
    transport = createDesktopTransport(port)
    installDesktopCarrier(transport)
    const payload = await window.dshDesktop.getBootPayload()
    if (payload === null) throw new Error('the runtime published no client boot graph')
    await bootFromPayload(payload, transport)
    // Hand off an empty mount point: the pinned ui-renderer hydrates over
    // exactly the boot DOM it finds here, so the shell leaves no siblings.
    clear()
    const entry = new AppWebEntry(root)
    app = entry
    await entry.run()
  } catch (error) {
    appError = error instanceof Error ? error.message : String(error)
    await teardownApp()
    render(currentView())
  } finally {
    booting = false
  }
}

/**
 * Run the pinned boot protocol on the page: the loader facade, the preload
 * bundles, the graph global — in the order the web protocol requires, all
 * through the carrier.
 */
async function bootFromPayload(payload: DshBootPayload, carrier: DesktopTransport): Promise<void> {
  await evaluateClassicScript(payload.moduleLoaderScript)
  for (const url of payload.preloadBundles) {
    await loadClientBundle(carrier, url)
  }
  ;(globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = payload.graph
}

let lastView: RuntimeStateView | undefined
function currentView(): RuntimeStateView {
  if (lastView === undefined) {
    // Defensive only: the bootstrap always runs after the first state.
    return { state: 'ready' }
  }
  return lastView
}

async function onState(view: RuntimeStateView): Promise<void> {
  lastView = view
  switch (view.state) {
    case 'starting':
    case 'stopped':
    case 'failed':
      appError = undefined
      await teardownApp()
      render(view)
      break
    case 'ready':
      if (app !== undefined || booting) return
      render(view)
      if (appError !== undefined) return
      await startApp()
      break
    case 'stopping':
      await teardownApp()
      render(view)
      break
  }
}

// The desktop UX command bridge: live only while the DSH client tree is
// mounted; shell-screen states are deterministic no-ops (the adapter's
// isLive gate).
installDesktopCommands(() => app !== undefined)

window.dshDesktop.onRuntimeState((view) => {
  void onState(view)
})
void window.dshDesktop.getRuntimeState().then((view) => {
  void onState(view)
})
