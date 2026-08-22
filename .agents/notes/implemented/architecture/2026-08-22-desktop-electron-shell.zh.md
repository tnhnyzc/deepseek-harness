# Agent Note: desktop 第一阶段 — Electron 壳

Status: implemented

[English](2026-08-22-desktop-electron-shell.md) | 中文

## Problem

desktop 分叉必须把 Electron 应用加进 Harness monorepo，而 monorepo 的每道 gate 都是为「要发布的 release member」设计的：`scripts/check-workspace-constraints.ts` 要求每个 `apps/*` 包都是公开 release member，TypeScript solution 显式拆成 host/client 两个 face，pnpm 供应链策略默认拒绝 install 脚本与 git 托管的 subdependency。Electron 和 Electron Forge 各自撞上其中一条规则，而 stage 1 的壳（SPEC #6）必须在不为 desktop 重新设计 gate 的前提下，完整落在这些规则之内。

## Decision

`apps/desktop` 是**私有 workspace 成员**，不是 release member。分叉在 `scripts/check-workspace-constraints.ts` 里加了一条 `privateAppDirectory` 豁免（`apps/desktop`、`apps/desktop-runtime`），把这两个目录从 release-member 发布规则和 app 发布文件策略里剔除；随后通用分支会*强制*它们设 `private: true`。这就是[上游契约](../../../../apps/desktop/docs/upstream-contract.md)里的 B1 修订，在第一个 app 的 `package.json` 落地时一并应用。

壳只有一个 `BrowserWindow`：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`，stage 1 不放 preload（MessagePort 桥在 stage 3；在那之前 renderer 完全无特权）。导航被限制在 app 协议内，`setWindowOpenHandler` 拒绝一切新窗口（校验过的 http/https URL 交给 `shell.openExternal`，其余一律不交），webview 一律拒绝，session 拒绝所有 permission 请求。

renderer 只经由私有 `dsh-app://` 协议分发（app ready 之前注册为 `standard` + `secure`）。handler 把 URL 路径名映射到打包后的 renderer 分发目录，用 normalize 加前缀包含做隔离，拒绝解码后的 `..` 穿越、绝对路径与空字节，并在读字节前把解析出的文件对符号链接解析后的根目录做一次复检；主页面是 `dsh-app://app/index.html`，全程不使用 `file://`。页面带严格 CSP（`script-src 'self'`，无 `unsafe-inline`）。

renderer 入口刻意保持薄：单个处于启动状态的 `#root`，由 Vite 构建。stage 4 会从同一个根节点、用与 Web UI 相同的 client 包启动现有的 DSH client 应用树；在没有已启动 host 的情况下 renderer 如何取得 `__DSH_BOOT__`，是未决的 D1 问题，不在这里决定。

**Forge 在本 monorepo 的当前阶段只声明、不可运行。** Forge 7.11.2 的 CLI 系统检查要求 hoisted 的 pnpm 布局（或自定义 hoist pattern），monorepo 不能接受；Forge 7 里 `skipSystemCheck` 已不存在（只剩一个未文档化的 home 目录标志文件）。`forge.config.ts` 保留为打包规格（asar 加 `extraResource: 'dist/renderer'` → `Resources/renderer`，即打包后 `dsh-app://` handler 分发的目录），bundle 组装用 `@electron/packager` 18.4.4 —— Forge 内部使用的同一个 assembler —— 验证通过，`prune: false`（app 没有任何生产依赖）加 `node_modules` ignore（其 prod 依赖 walker 无法遍历 isolated pnpm 布局）即可。打包工具链在 stage 11 定案。

pnpm 策略在 `pnpm-workspace.yaml` 里新增两条 desktop 项：`allowBuilds.electron: true`（下载固定版本的 Electron 二进制）和一条把 `@electron/rebuild` 钉到 4.2.0 的 override，因为 Forge 包的 3.x rebuild 子依赖从 git 仓库解析 node-gyp，会被 `blockExoticSubdeps` 拒绝；rebuild 4.x 用 npm 上发布的 node-gyp，而且 Electron 壳本来就没有要 rebuild 的 native 模块（Harness 运行时从 stage 2 起是独立的纯 Node 进程）。

验证分两层：`tests/protocol.spec.ts` 直接单测路径隔离与 URL 校验函数；`tests/shell.spec.ts` 通过 Playwright 的 Electron 驱动启动构建好的 app，断言 stage 1 退出准则（dsh-app:// URL、启动状态、CSP 存在、renderer 内无 `require`/`process`、穿越请求 404、app 协议之外零请求、零 Electron 安全警告）；没有构建产物或没有 GUI 会话时自跳过。

## Consequences

- desktop 的 delta 触及 repo 级 gate：constraints 豁免、两个 tsconfig 聚合（`apps/desktop` 同时被 host face 与 client face 引用 —— 中性的单配置项目）、`knip.json`、`pnpm-workspace.yaml` 与 `.gitignore`。
- 豁免提前写了 `apps/desktop-runtime`（stage 2 的包），第二个 app 落地时 gate 已就绪。
- `pnpm run hygiene` 在 pin 本身处即为红：`rescope-vendor:check` 因两处与 desktop 无关的过期 exact edit 失败（已在 pin 的干净 worktree 中验证）。记入契约的 mismatch 清单；分叉级修复暂缓。
- D3（`dsh-app://` 下的 `isLoopback` 行为）未触及：stage 1 的 renderer 不运行任何 DSH client 代码。
- `THIRD_PARTY_NOTICES.md` 由 pre-commit hook 为新增的 Electron/Forge 依赖重新生成。

## Alternatives considered

- **`node-linker=hoisted`（或 hoist pattern）满足 Forge 系统检查** —— 否决：为一个壳根本用不到的 rebuild 路径，重排整个 monorepo 的 `node_modules`。
- **用 `file://` 或 loopback HTTP 服务 renderer** —— SPEC 否决：发布应用不用 `file://`，最终产品没有 localhost HTTP 服务器。
- **stage 1 就放 preload 桥** —— 否决：stage 1 没有要承载的 IPC；MessagePort 协议在 stage 3 定义之前，renderer 保持最大无特权。
- **彻底弃用 Electron Forge** —— 否决：SPEC 结构声明了 `forge.config.ts`；约束是环境性的，所以配置保留为 stage 11 的打包规格，而不是删除。
- **stage 1 就直接分发真实 DSH client 树** —— 否决：那会迫使 D1 的 `__DSH_BOOT__` 供给决策与 stage 4 的 transport 工作提前；退出准则明确允许「尚无 Harness 运行时」。
