/**
 * The stage 2 supervision channel: the renderer projects the runtime
 * lifecycle (startup state, ready versions, recoverable failure with a
 * restart action). This is not the stage 3 client transport — it carries no
 * DSH client traffic, only the supervisor's state facts. The file is plain
 * CJS because a sandboxed renderer preload cannot use ESM imports; it is
 * checked in as a stable artifact and loaded from this package in both the
 * development layout and the packaged asar. Type contracts live in
 * `src/shared/runtime-state.ts`.
 * @module @deepseek-ai/dsh-desktop/src/preload/index
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const STATE_CHANNEL = 'dsh-desktop:runtime-state';
const GET_CHANNEL = 'dsh-desktop:runtime-get';
const RESTART_CHANNEL = 'dsh-desktop:runtime-restart';

const api = {
  getRuntimeState: () => ipcRenderer.invoke(GET_CHANNEL),
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
};

contextBridge.exposeInMainWorld('dshDesktop', api);
