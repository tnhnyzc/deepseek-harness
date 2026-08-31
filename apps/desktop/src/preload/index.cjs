/**
 * The desktop bridge: the stage 2 supervision channel (the renderer projects
 * the runtime lifecycle — startup state, ready versions, recoverable failure
 * with a restart action), the stage 3 transport open (the renderer receives
 * the half of a MessageChannel the dumb broker relays to the runtime; the
 * port itself carries the DSH client traffic, this file never interprets
 * it), and the stage 4 boot-payload pull (the runtime-published boot graph
 * and host-owned boot scripts, cached by the supervisor; passed through as
 * structured data, never interpreted). The file is plain CJS because a
 * sandboxed renderer preload cannot use ESM imports; it is checked in as a
 * stable artifact and loaded from this package in both the development
 * layout and the packaged asar. Type contracts live in
 * `src/shared/runtime-state.ts`.
 * @module @deepseek-ai/dsh-desktop/src/preload/index
 */

'use strict';

// The privileged bridge is main-frame only: a preload installs into every
// frame of a document, so a subframe of any embedded document would otherwise
// see the same surface. Main refuses subframe IPC independently (the sender
// frame check); this guard is the renderer-side half of the same rule.
if (window.top !== window.self) return;

const { contextBridge, ipcRenderer } = require('electron');

const STATE_CHANNEL = 'dsh-desktop:runtime-state';
const GET_CHANNEL = 'dsh-desktop:runtime-get';
const RESTART_CHANNEL = 'dsh-desktop:runtime-restart';
const BOOT_GRAPH_CHANNEL = 'dsh-desktop:boot-graph';
const TRANSPORT_OPEN_CHANNEL = 'dsh-desktop:transport-open';
const TRANSPORT_PORT_CHANNEL = 'dsh-desktop:transport-port';
const TRANSPORT_DENIED_CHANNEL = 'dsh-desktop:transport-denied';
const TRANSPORT_OPEN_TIMEOUT_MS = 10000;
const COMMAND_CHANNEL = 'dsh-desktop:command';
// Test-only, environment-gated: the packaged-app smoke's fact report. The
// method is absent from the bridge unless DSH_DESKTOP_SMOKE=1 was set on
// the app process (main refuses to register the handler the same way).
const SMOKE_CHANNEL = 'dsh-desktop:smoke-report';
// The closed desktop UX command vocabulary (stage 7), mirrored here because
// a sandboxed preload cannot load the ESM shared module. The preload is the
// enforcement point: a payload that is not a vocabulary member never
// reaches the page. Keep in lockstep with
// src/shared/desktop-command.ts (the menu unit test pins both sides).
const DESKTOP_COMMANDS = new Set([
  'new-session',
  'open-workspace',
  'cancel-run',
  'rename-session',
  'open-settings',
  'toggle-sidebar',
]);

const api = {
  getRuntimeState: () => ipcRenderer.invoke(GET_CHANNEL),
  getBootPayload: () => ipcRenderer.invoke(BOOT_GRAPH_CHANNEL),
  onRuntimeState: (callback) => {
    const listener = (_event, view) => {
      callback(view);
    };
    ipcRenderer.on(STATE_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(STATE_CHANNEL, listener);
    };
  },
  requestRestart: () => ipcRenderer.invoke(RESTART_CHANNEL),
  openTransport: () =>
    new Promise((resolve, reject) => {
    const onPort = (event) => {
      const port = event.ports && event.ports[0];
      if (!port) return;
      settle(() => {
        port.start();
        // contextBridge cannot carry a live MessagePort (it crosses as an
        // inert object); expose the real port's surface as plain functions.
        // Message events cross as plain `{ data }` objects: the contextBridge
        // clone drops prototype accessors, so MessageEvent.data would be lost.
        const wrappedMessageListeners = new Map();
        let listenerSequence = 0;
        resolve({
          addEventListener: (type, listener, options) => {
            if (type === 'message' && typeof listener === 'function') {
              const wrapped = (event) => listener({ data: event.data });
              wrappedMessageListeners.set(listener, wrapped);
              port.addEventListener(type, wrapped, options);
            } else {
              port.addEventListener(type, listener, options);
            }
          },
          removeEventListener: (type, listener, options) => {
            if (type === 'message' && typeof listener === 'function') {
              const wrapped = wrappedMessageListeners.get(listener);
              if (wrapped !== undefined) {
                wrappedMessageListeners.delete(listener);
                port.removeEventListener(type, wrapped, options);
                return;
              }
            }
            port.removeEventListener(type, listener, options);
          },
          postMessage: (message) => port.postMessage(message),
          start: () => port.start(),
          close: () => port.close(),
        });
      });
    };
      const onDenied = (_event, reason) => {
        settle(() => reject(new Error(`transport open denied: ${String(reason)}`)));
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error('transport open timed out')));
      }, TRANSPORT_OPEN_TIMEOUT_MS);
      const settle = (finish) => {
        clearTimeout(timer);
        ipcRenderer.removeListener(TRANSPORT_PORT_CHANNEL, onPort);
        ipcRenderer.removeListener(TRANSPORT_DENIED_CHANNEL, onDenied);
        finish();
      };
      ipcRenderer.once(TRANSPORT_PORT_CHANNEL, onPort);
      ipcRenderer.once(TRANSPORT_DENIED_CHANNEL, onDenied);
      ipcRenderer.send(TRANSPORT_OPEN_CHANNEL);
    }),
  onDesktopCommand: (callback) => {
    const listener = (_event, command) => {
      if (typeof command === 'string' && DESKTOP_COMMANDS.has(command)) {
        callback(command);
      }
    };
    ipcRenderer.on(COMMAND_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(COMMAND_CHANNEL, listener);
    };
  },
};

if (process.env.DSH_DESKTOP_SMOKE === '1') {
  api.smokeReport = () => ipcRenderer.invoke(SMOKE_CHANNEL);
}

contextBridge.exposeInMainWorld('dshDesktop', api);
