# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

DeepSeek Harness 桌面应用的私有 Electron 壳。stage 1 交付加固的窗口、私有
`dsh-app://` renderer 协议与薄 renderer 入口；stage 2 加入运行时监督者：main
进程在固定版本捆绑 Node 下 fork 独立的 Harness 运行时（`apps/desktop-runtime`），
经 fork IPC 驱动其 `stopped/starting/ready/stopping/failed` 生命周期，并在退出时
经正常 DSH 处置路径停止它。stage 3 加入 IPC 传输：运行时经 fork IPC 提供
fetch 兼容的请求/响应原语与不透明的有序流，main 中的哑中继 broker 把帧
转给 renderer，renderer 经 `window.dshDesktop.openTransport()` 使用两者。
DSH client 应用树在 stage 4 从这个 renderer 启动。范围、接缝与未决的
D1、D3、D4 问题（D2 已在 stage 3 解决）见 `SPEC.md` #6-#11、
`ARCHITECTURE.md` 与[上游契约](./docs/upstream-contract.md)。

## 构建

```sh
pnpm install
pnpm run build          # tsdown -> dist/main, vite -> dist/renderer
pnpm run bundle:node    # download + sha256-verify the pinned Node into node/
```

运行时本身是一个 workspace 包：在仓库根目录运行 `pnpm run build` 会打包出
`apps/desktop-runtime/dist/index.js`。desktop 的 `pnpm run build` 先构建
运行时，再打包 main 与 renderer。

## 运行

```sh
pnpm start              # electron . from the package root (dev)
```

开发需要两个构建产物：运行时 bundle 与本平台对应的捆绑 Node
（`pnpm run bundle:node`）。运行时的 home 是 `<Electron user-data>/harness`
—— app 自有的 `DSH_HOME`；绝不复用 CLI 的 `~/.dsh`。

## 测试

在仓库根目录运行（monorepo 约定）：

```sh
pnpm test apps/desktop  # supervisor, smoke, and protocol tests
```

- `tests/runtime.spec.ts` 总是运行：监督者对 fixture 运行时、经真实 fork IPC
  （状态机、死亡、ready 前恰一次自动重试、优雅与强杀进程树关闭、重启）。
- `tests/desktop-transport.spec.ts` 总是运行：renderer 客户端对 fake port
  （响应组装、流请求体、双向额度、序号校验、完整的 abort 生命周期，以及
  打开/关闭的流生命周期）。
- `tests/transport-broker.spec.ts` 总是运行：main broker 对 fake（wire 门的
  丢弃与合成尺寸拒绝、双向中继、就绪拒绝、通道替换、拆除）。
- `tests/security.spec.ts` 与 `tests/boundary.spec.ts` 总是运行：IPC 发端
  信任规则，以及 SPEC §31 架构边界扫描（main 无 DSH 产品导入、renderer 无
  electron/Node、传输无业务字面量、无 HTTP 监听器）。
- `tests/shell.spec.ts` 在缺少构建产物（端到端运行时块额外需要运行时 bundle
  与捆绑 Node）或没有 GUI 会话时自跳过；其 smoke 块现在还在活传输上完成
  一次 fetch 往返。`protocol.spec.ts` 总是运行。

## 打包

`forge.config.ts` 是打包规格（asar + `extraResource: dist/renderer` 与
`node` -> `Resources/`）。Forge 7 CLI 无法在本 monorepo 的 isolated pnpm
布局下运行系统检查；stage 1 用 `@electron/packager` 验证 bundle 组装（见
stage 1 Agent Note）。工具链在 stage 11 定案。

## 布局

- `src/main/` — Electron main 进程：窗口、`dsh-app://` 协议、session 加固、
  运行时监督者（`runtime.ts`、`runtime-paths.ts`）与哑传输 broker
  （`transport-broker.ts`）。Node API 不达 renderer。
- `src/preload/index.cjs` — 签入的 CJS 监督桥（沙箱 preload 无法加载 ESM）；
  状态视图、状态事件、重启，以及把活传输 port 交给 renderer 的
  `openTransport()`。
- `src/shared/runtime-state.ts` — main、preload 与 renderer 共享的状态与
  传输类型。
- `src/renderer/` — 打包后的 renderer 入口（CSP 严格、无 `file://`）；投影
  运行时生命周期与可恢复的失败界面，并携带 renderer 传输客户端
  （`transport.ts`）。
- `scripts/bundle-node.ts`、`node-versions.json` — 构建时按目标下载并做
  sha256 校验的固定 Node。
- `tests/` — 监督者、smoke、协议、renderer 客户端、broker 与端到端测试。
