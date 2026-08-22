 # DeepSeek Harness Desktop Architecture

## Overview

This document defines the architectural principles, boundaries, and major design decisions for a native desktop application built around DeepSeek Harness.

The desktop application is not a new agent framework.

It is:

```
DeepSeek Harness
+
Desktop client/carrier
+
Native OS integration
+
Reproducible packaged runtime
```

The goal is to provide a first-class desktop experience while preserving DeepSeek Harness as the single source of truth for agent execution, sessions, tools, models, plugins, and runtime behavior.

The desktop layer exists to deliver and extend Harness, not replace it.

---

# High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    DeepSeek Desktop Application              │
│                                                              │
│  Electron Renderer                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Existing DeepSeek Client/UI Packages                  │  │
│  │                                                        │  │
│  │ - sessions                                             │  │
│  │ - conversations                                        │  │
│  │ - trajectories                                         │  │
│  │ - approvals                                            │  │
│  │ - user questions                                       │  │
│  │ - settings                                             │  │
│  │ - model/provider UI                                    │  │
│  └───────────────────────┬────────────────────────────────┘  │
│                          │                                   │
│                  Generic IPC Transport (Fetch + Stream)       │
│                          │                                   │
│  ┌───────────────────────▼────────────────────────────────┐  │
│  │ Electron Main                                           │  │
│  │                                                         │  │
│  │ - window lifecycle                                     │  │
│  │ - IPC broker                                           │  │
│  │ - native OS APIs                                       │  │
│  │ - updater                                              │  │
│  │ - crash supervision                                    │  │
│  │                                                         │  │
│  │ Does NOT implement agent logic                         │  │
│  └───────────────────────┬────────────────────────────────┘  │
│                          │                                   │
│                    Process IPC                                │
│                          │                                   │
│  ┌───────────────────────▼────────────────────────────────┐  │
│  │ Standalone Node Runtime                                │  │
│  │                                                         │  │
│  │ DeepSeek Harness                                       │  │
│  │                                                         │  │
│  │ - Cordis runtime                                       │  │
│  │ - sessions                                              │  │
│  │ - agents                                                │  │
│  │ - tools                                                 │  │
│  │ - approvals                                             │  │
│  │ - plugins                                               │  │
│  │ - providers                                             │  │
│  │ - persistence                                           │  │
│  │ - subagents                                             │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

# Core Architectural Principle

There must be exactly one owner of agent semantics:

```
DeepSeek Harness
```

The desktop application must not recreate Harness concepts.

The following must NOT exist:

```
DesktopSession
DesktopAgent
DesktopTool
DesktopApproval
DesktopModel
DesktopConversation
```

The desktop application consumes Harness capabilities.

It does not duplicate them.

---

# Desktop Framework Decision: Electron

The desktop application uses Electron rather than Tauri.

## Reasoning

DeepSeek Harness is already:

- TypeScript-based;
- Node-based;
- web/client-oriented;
- designed around existing client packages;
- designed around transport abstraction.

The intended architecture naturally maps to:

```
Electron
    ↓
Existing web client
    ↓
DeepSeek Harness runtime
```

A Tauri architecture would become:

```
Rust shell
    ↓
WebView frontend
    ↓
Node runtime bridge
    ↓
DeepSeek Harness
```

This reduces the shell size but does not remove the Node runtime requirement.

It introduces an additional:

```
Rust/WebView ↔ Node
```

boundary without removing the primary runtime.

The goal is not the smallest possible executable.

The goal is the fewest architectural translations and strongest alignment with upstream Harness design.

---

# Runtime Separation

Electron and DeepSeek Harness must run as separate processes.

Architecture:

```
Electron Renderer
        |
        | IPC
        ↓
Electron Main
        |
        | child process IPC
        ↓
Standalone Node Runtime
        |
        ↓
DeepSeek Harness
```

The Electron application must not execute Harness directly inside the Electron main process.

Reasons:

- Electron and Node versions can evolve independently.
- Harness dependencies run in a normal Node environment.
- Native module compatibility is easier to manage.
- Harness crashes cannot directly crash the desktop shell.
- Runtime upgrades become reproducible.
- Process boundaries improve security and debugging.

Electron is the application shell.

DeepSeek Harness is the application runtime.

---

# Renderer Architecture

The renderer should reuse existing DeepSeek client/UI packages.

The renderer owns:

- presentation;
- interaction;
- UI state;
- user input;
- visual rendering.

The renderer does NOT own:

- agent execution;
- filesystem authority;
- subprocess lifecycle;
- credentials;
- tool execution;
- model execution.

The renderer communicates with Harness through the existing client abstractions.

---

# IPC Transport Principle

The IPC layer must remain generic.

The desktop application implements a generic IPC transport layer with two
primitives:

```
A. Fetch-compatible request/response transport
   - normal API calls
   - configuration
   - commands
   - queries

B. Opaque bidirectional stream transport
   - live event streams
   - realtime updates
   - websocket-style communication
   - future streaming APIs
```

Correct:

```
DeepSeek Client
        |
        ↓
Generic IPC Transport
(Fetch + Stream carriers)
        |
        ↓
DeepSeek Harness host API
```

Incorrect:

```
Electron IPC

├── createSession()
├── runAgent()
├── approveTool()
├── listModels()
├── executeCommand()
└── getConversation()
```

The IPC layer must not know Harness business concepts.

It transports requests, responses, ordered frames, streams, and
cancellation.

It does not define the application protocol.

The desktop transport moves Harness protocols; it does not define Harness
protocols.

A future Harness feature should work without requiring Electron changes.

---

# Streaming Transport

Live Harness events do not travel as Fetch responses in the current pinned
revision. They arrive on websocket-style downlinks that the Harness host
serves directly. Fetch and Stream are therefore separate generic carriers.

Fetch carrier:

```
client request
        |
        ↓
zero or more responses, possibly streamed
```

Stream carrier:

```
client opens stream          server pushes frames
client sends frames          client reads frames
client closes stream
```

The stream carrier is business-logic agnostic. It transports generic ordered
frames:

```
stream.open(streamId)
stream.frame(streamId, bytes)
stream.close(streamId)
```

It must not expose concepts such as:

```
session stream
approval stream
tool stream
agent stream
```

The stream identifier and frame bytes are opaque to every desktop layer.

Which streams exist, and what their frames mean, is decided entirely by the
DSH client and the DSH runtime.

---

# No Production localhost Server

The final desktop architecture should NOT be:

```
Electron Renderer
        |
        ↓
localhost HTTP server
        |
        ↓
dsh web
```

This may be useful for early experiments but is not the intended design.

The final architecture is:

```
Electron Renderer
        |
        ↓
IPC Transport (Fetch + Stream)
        |
        ↓
DeepSeek Harness Runtime
```

The desktop application should use Harness directly.

It should not wrap the browser server.

---

# Renderer Origin Security

The packaged frontend should use a private application protocol.

Preferred:

```
dsh-app://
```

Avoid:

```
file://
```

Reasoning:

- custom protocols provide explicit resource boundaries;
- reduce filesystem exposure;
- improve URL handling;
- align better with Electron security practices.

The protocol choice only affects asset loading.

The client/runtime architecture remains:

```
Local frontend
+
IPC transport
+
Harness runtime
```

---

# Native Capability Model

Desktop-native features must enter through explicit capability boundaries.

Example:

```
DeepSeek Harness
        |
        ↓
Native capability request
        |
        ↓
Electron Main
        |
        ↓
Operating System
        |
        ↓
Response
        |
        ↓
DeepSeek Harness
```

Examples:

- directory picker;
- file picker;
- notifications;
- reveal in filesystem;
- external URL opening;
- document opening flows (general openDocument, settings documents,
  agent preset documents).

The renderer must not bypass Harness and directly mutate runtime state.

---

# Security Model

The renderer must remain unprivileged.

Required Electron settings:

```
nodeIntegration = false
contextIsolation = true
sandbox = true
webSecurity = true
```

Avoid:

```
window.electron = ipcRenderer
```

or any unrestricted IPC bridge.

Privileged operations require:

- explicit schemas;
- validation;
- controlled permissions;
- cancellation support.

---

# DeepSeek Harness Versioning

DeepSeek Harness is evolving quickly and may introduce compatibility-breaking changes.

Desktop releases must pin exact versions.

A release represents:

```
Desktop Version
+
Electron Version
+
Node Runtime Version
+
DeepSeek Harness Commit
+
Client/UI Version
```

Never dynamically consume:

```
master
latest packages
unversioned dependencies
```

The desktop application is a reproducible distribution of a known-good Harness environment.

---

# External Agent Integrations

External agents are Harness providers.

They are not desktop foundations.

Architecture:

```
DeepSeek Harness
        |
        +── Codex Provider
        |       |
        |       +── Codex app-server
        |
        +── Claude Provider
        |
        +── OpenCode Provider (future ACP)
```

The desktop application must not directly manage:

- Codex app-server;
- OpenCode runtime;
- Claude Code sessions.

Harness remains the orchestrator.

---

# Codex Relationship

Codex app-server is a useful reference architecture because it demonstrates:

- bidirectional communication;
- streaming;
- approvals;
- thread/turn lifecycle.

However, the desktop application should not become a Codex client.

Correct:

```
Desktop UI
        |
        ↓
DeepSeek Harness
        |
        ↓
DSH Codex Provider
        |
        ↓
Codex app-server
```

Codex is a subordinate execution backend.

It is not the desktop runtime.

---

# OpenCode Relationship

OpenCode should not replace DeepSeek Harness.

Incorrect:

```
Desktop UI
        |
        ↓
OpenCode
        |
        ↓
Models/tools
```

This creates competing ownership of:

- sessions;
- tools;
- approvals;
- permissions;
- execution state.

If OpenCode integration is added, it should exist as:

```
DeepSeek Harness
        |
        ↓
ACP Provider
        |
        ↓
OpenCode
```

The desktop application should not need to know whether the provider is OpenCode.

---

# Architectural Invariants

These rules must remain true.

## One orchestration owner

DeepSeek Harness owns:

- agents;
- tools;
- sessions;
- approvals and user questions;
- providers;
- execution lifecycle.

## Generic transport

IPC transports Harness communication through a Fetch-compatible
request/response carrier and an opaque bidirectional stream carrier.

It does not become a second Harness API.

The desktop transport moves Harness protocols; it does not define
Harness protocols.

## Replaceable runtime

Electron, Node, and Harness versions are independently replaceable through tested release combinations.

## Renderer isolation

The renderer displays and interacts.

It does not execute privileged operations.

## Provider abstraction

External agents remain providers.

The desktop application does not contain provider-specific logic.

---

# Final Mental Model

The correct architecture:

```
DeepSeek Harness
+
Desktop Client
+
Native OS Integration
+
Reproducible Runtime Packaging
```

The incorrect architecture:

```
A new desktop agent framework
that happens to use DeepSeek Harness
```

The desktop application is a carrier and native interface for DeepSeek Harness.

It is not a competing agent runtime.