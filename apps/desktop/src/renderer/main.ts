/**
 * Thin renderer entry. Renders the shell boot state and, from stage 2, the
 * supervised Harness runtime lifecycle: a proper startup state while the
 * runtime boots, the readiness facts, and a recoverable failure screen with
 * a restart action. Stage 4 starts the existing DSH client application tree
 * from this same single root using the same client packages as the browser
 * Web UI.
 * @module @deepseek-ai/dsh-desktop/src/renderer/main
 */
import './styles.css'
import type { RuntimeStateView } from '../shared/runtime-state.ts'

const foundRoot = document.getElementById('root')
if (foundRoot === null) throw new Error('desktop renderer: missing #root')
const root: HTMLElement = foundRoot

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
  status.textContent = view.reason ?? 'Harness failed'
  main.append(heading, status)
  if (view.diagnostics !== undefined && view.diagnostics !== '') {
    const diagnostics = document.createElement('pre')
    diagnostics.className = 'shell-diagnostics'
    diagnostics.textContent = view.diagnostics
    main.append(diagnostics)
  }
  const button = document.createElement('button')
  button.className = 'shell-restart'
  button.textContent = 'Restart Harness'
  button.addEventListener('click', () => {
    button.disabled = true
    void window.dshDesktop.requestRestart().then(() => {
      button.disabled = false
    })
  })
  main.append(button)
  root.append(main)
}

function render(view: RuntimeStateView): void {
  root.dataset.state = view.state
  switch (view.state) {
    case 'starting':
      renderStarting()
      break
    case 'ready':
      renderReady(view)
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

window.dshDesktop.onRuntimeState(render)
void window.dshDesktop.getRuntimeState().then(render)
