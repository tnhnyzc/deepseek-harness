# Agent Note: desktop 第二阶段 — 独立 Harness 运行时

Status: implemented

[English](2026-08-22-desktop-standalone-runtime.md) | 中文

## Problem

stage 2（SPEC #7）必须建立进程边界：Electron 壳监督一个独立的纯 Node Harness 运行时，且该运行时完全不提供 HTTP。上游 web 组成为 `dsh web` 而构建，其中 `webserver` 行监听端口，另有四行离开它根本无法激活；SPEC 禁止 `dsh web`、禁止端口探测、禁止解析 stdout 判定就绪，要求 app 自有的 `DSH_HOME`（绝不复用 `~/.dsh`）、以打包资源形式存在的固定 Node 二进制（而非首次启动时下载）、至多一次自动重启，以及经由正常 DSH 处置路径关闭、强制 kill 不留孤儿进程。

## Decision

运行时是一个新的私有 workspace 包 `apps/desktop-runtime`（stage 1 已在豁免中预留名字）。它是单文件 tsdown ESM bundle（`dist/index.js`，workspace 裸导入留作 external、运行时解析）——与 `apps/cli` bundle 同一约定——导入 `@deepseek-ai/dsh-app-boot` 导出的组成部件（`healProfilesModuleFallback`、`loadProfile`、`composeEntries`、`boot`），以 CLI 的 `web` profile 为基础重新启动，使 desktop 承载与浏览器界面相同的 Harness。

无 HTTP 覆盖层（契约 §1.2 的源码级细化）禁用五行：`webserver`（HTTP 监听者）、`web-runtime`（分发 dist、提供 `webRuntime`）、`connection`（绑定 `/api` 路由），以及 `modules` 与 `client-hmr`——后两行 stage 0 契约没有列出，因为它们的 `webServer` 依赖声明在插件注入列表里而非 bundle 的行配置中（`packages/client/modules/src/index.ts:283`、`packages/client/hmr/src/index.ts:28`）。覆盖层同时改挂目录选择器：`auto` 变体要解析 web 绑定主机并注入 `webServer`，故覆盖层禁用该行并插入既有的 `@deepseek-ai/dsh-host-directory-picker-native`——与 web 组成为固定 picker 的部署所文档化的「在 overlay 里挂 -native」同一种处理。`PatchOptions` 行 `name` 是校验护栏而非改挂手段，所以换挂是禁用加插入。

就绪即 `boot()` 返回的 settled `Promise<Context>`：无端口、无 stdout。随后运行时经 fork IPC 发送 `runtime.ready`，携带 `runtimeVersion`（自身包版本）、`dshVersion`（`@deepseek-ai/dsh-base`）与 `capabilities`（`apiProxy: true`、`httpServer: false`）。其 home 是壳在 Electron user-data 路径下创建的 app 自有目录，经 `DSH_HOME` 传入；子进程 `cwd` 为运行时包根目录，使 `.env` 层叠读取 app home。遥测沿用 CLI 的 `DSH_TELEMETRY_DISABLED` 任意非空值语义。

Node 在 `apps/desktop/node-versions.json` 中固定为 `v22.23.2`——验证 pin 所用的版本——每个目标（darwin-arm64、darwin-x64、win32-x64、linux-x64）带 sha256；`scripts/bundle-node.ts` 在构建时下载、校验并安装 `node/<target>/node`，打包 app 以资源形式携带。监督者以空 `execArgv` fork 该二进制，环境为精选集（`DSH_DESKTOP=1`、`DSH_HOME`、环境凭据；机密绝不走 argv）。

Electron 主进程中的监督者（`src/main/runtime.ts`）是一台 `stopped/starting/ready/stopping/failed` 状态机，非法迁移即抛错。它以 `stdio: ignore/pipe/pipe/ipc` fork（POSIX 上 `detached: true`，使强制 kill 命中整个进程组），维护有界的 stdout+stderr 诊断环，停止时发送 `runtime.shutdown`；子进程按 CLI 的 5 秒宽限模式等待 `ctx.fiber.dispose()`（因 bin 胶水不是可导入模块而镜像一份）并自我强制退出，父进程在进程树仍存活时强杀整个进程组。自动重试至多一次，且仅当时机在 ready 之前失败——spawn 错误不重试、ready 之后不重试；失败界面提供手动重启。

renderer 得到一个最小 CJS preload（沙箱 preload 无法加载 ESM），只暴露监督状态：当前视图、状态事件、重启。这是 stage 2 的桥；stage 3 的 client 传输（`__DSH_TRANSPORT__` 与 MessagePort 协议）刻意未动。renderer 投影生命周期与可恢复的失败界面。

验证：`apps/desktop/tests/runtime.spec.ts` 用 fixture 运行时经真实 fork IPC 驱动监督者（状态机、ready 后死亡、ready 前恰一次自动重试、ready 后不重试、优雅树关闭、拒绝配合的树被强杀、手动重启）；`apps/desktop-runtime/tests/boot.spec.ts` 在临时 `DSH_HOME` 下启动已构建的运行时，断言就绪事实、不存在任何 HTTP 监听、home 隔离、关闭时干净退出 0；`apps/desktop/tests/shell.spec.ts` 新增端到端块：启动已构建 app，经捆绑 Node 到达 `ready`，再干净退出。全部在缺少构建产物时自跳过。

## Consequences

- desktop 的 delta 再多触及一个 repo 级 gate 文件：根 `tsdown.config.ts` workspace 列表在 repo 构建中打包运行时；`tsconfig.host.json`、`knip.json` 与 `.gitignore` 登记新私有 app。`apps/desktop` 仍被两个 TypeScript face 引用（main/preload 是 host 代码，renderer 是 client 代码）——stage 1 的安排被确认而非重议。
- 记账：红的 `rescope-vendor:check`（两处过期 exact edit）是 stage 0.2 通过未覆盖的 gate 里既有的上游缺陷；已在 `UPSTREAM.md` 与契约 mismatch 清单中如此记录。
- 覆盖层耦合于 web profile 的行 id：若上游重命名或重构这些行，`DESKTOP_DISABLED_ROWS` 与 picker 改挂必须重新验证。耦合已记入契约 §1.2。
- D 类风险：未产生新的 D 风险。desktop 组成在捆绑 Node 下不激活任何 native 模块，D4 仍开放在其 stage 9/11 范围内；D3 与 D1 未触及（renderer 尚无 DSH client 代码）。
- `forge.config.ts` 的 `extraResource` 现在也暂存 `node`；打包后的运行时资源布局在 stage 11 定案。

## Alternatives considered

- **监督 `dsh web`（或 CLI bin）作为运行时** —— SPEC 否决：那会提供 HTTP，就绪就成了端口或打印的 URL 行，两者都被禁止。
- **在 Electron main 进程内加载 Harness** —— ARCHITECTURE 的进程分离否决：运行时崩溃不能带走壳，Harness 保持自己的纯 Node 依赖面。
- **壳与运行时之间另设 JSON-RPC 或 WebSocket 通道** —— 否决：`child_process.fork` IPC 是原生接缝且不带传输依赖；stage 3 的 renderer 传输是另一条通道、另有设计。
- **用 `name` 覆盖或新建 Electron 对话框 provider 包改挂 picker 行** —— 否决：`name` 是校验护栏而非改挂手段，且既有 `-native` provider 已在主机显示器上打开 OS 对话框；如有需要，shell 提供的对话框 provider 可稍后占用同一槽位。
- **首次启动时下载 Node 二进制** —— SPEC 否决：Node 可执行文件是打包资源，构建时校验和验证。
