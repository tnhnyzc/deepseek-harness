# Agent Note: desktop 第四阶段 — 在传输上引导 DSH 客户端

Status: implemented

[English](2026-08-25-desktop-dsh-client-boot.md) | 中文

## Problem

stage 4（SPEC stage 4）必须在 desktop 的 renderer 里引导真实的固定 DSH 客户端/UI 树：一个应用根节点、没有第二个或替身的 UI、DSH 继续独占全部 agent 语义。renderer 经已完成的 stage 3 传输从宿主拿到一切：`__DSH_TRANSPORT__` 载体接缝、`__DSH_BOOT__` 图、`__ModuleLoader__` 门面与 bundle 字节。stage 0 契约留下两个需要在实现中证明的事项（D1：`__DSH_BOOT__` 供给方式；D3：`dsh-app://` 下的 loopback 门控能力），而固定的客户端树假设一个 HTTP 部署——由 webserver 行注册路由、渲染期注入 index、bundle 经 `/plugins/<id>/client.js` 服务——desktop 宿主刻意不运行它。

## Decision

**供给（D1）。** 图走进程内导出（契约 B3）：`apps/desktop-runtime/src/boot-graph.ts` 构建 `runtime.boot-graph` 子进程 IPC 消息——来自 `ClientModuleRegistry` 的组合 `WebBootGraph`、`__ModuleLoader__` 门面脚本、preload bundle 的 URL 列表——运行时入口在 `runtime.ready` **之前**经有序 fork 通道发出；supervisor 缓存它，经受信任的 `dsh-desktop:boot-graph` invoke 提供给 renderer（preload `getBootPayload()`）。bundle 字节留在传输的 fetch 通道上：运行时的 dispatch 把 `GET /plugins/*` 路由给 `createClientBundleFetch(clientModules)`，逐字节服务构建产物，其余请求先经连接的进程内 fetch handler、再落到 API proxy 回退。固定的 `AppWebEntry` 读取 `__DSH_BOOT__` 与 `__ModuleLoader__`，并在 `__DSH_TRANSPORT__.loadBundle` 存在时采用它（其 `prefetchImmediateTier` 恰以该条件跳过 HTTP 预取，`packages/client/web/src/boot.ts:97-110`），因此 renderer 从不解引用仅 HTTP 可达的 URL。

**Loopback（D3）。** `dsh-app://` 协议主机是 `127.0.0.1`（`APP_PROTOCOL_HOST`，`apps/desktop/src/main/protocol.ts`）：固定的 loopback 分类未改动地读取 `location.hostname`（`packages/client/connection/src/loopback-hostname.ts:14-20`），而 `127.0.0.1` 对它就是 loopback——loopback 门控的能力与 API 信任栅栏在不动固定栅栏的前提下正常工作。`APP_HOME_URL` 为 `dsh-app://127.0.0.1/index.html`。

**载体。** `apps/desktop/src/renderer/dsh-carrier.ts` 在 stage 3 desktop 传输之上把固定的 `__DSH_TRANSPORT__` 接缝（`createApiClient` / `fetch` / `loadBundle`）装到 `globalThis` 上。`DesktopApiClient extends AbstractApiClient` 覆写 `doFetch`：两条固定的事件路径路由到流原语，其余方法路由到 fetch 原语；`loadBundle` 取回 bundle 字节并以经典脚本形式经 blob object URL 执行（`evaluateClassicScript`）。事件路径常量经包已声明的 `./src/*` 子路径从固定的 `api-path.ts` 导入，因为构建出的 `/client` 入口是一个 CJS 模块工厂，其命名导出无法被 renderer 打包器静态读取（`ClientTransportHooks` 类型保持为对 `/client` 的 type-only 导入）；renderer 边界白名单恰好放宽到那一个源文件。

**上游扩展（三处，最窄）。** 固定树把客户端表面注册到 webserver 行上；desktop 宿主禁用了该行。三处改动让客户端半部在无 HTTP 时可用，同时让 web app 的每一个 HTTP 行为原样保留：

1. `packages/client/modules/src/index.ts` — `ClientModuleRegistry` 只注入 `['loader']`；`/plugins` bundle 路由与 `webserver/index-inject` 行仅在 `ctx.get('webServer')` 存在时注册。组合图、bundle 表与 `clientPath` 对任何带 Loader 的宿主都存在。
2. `packages/client/connection/src/index.ts` — `inject = []`；`/api` 路由与 WebSocket 下行仅在 webserver 存在时注册；`HostConnectionService` 及其 `createSharedFetchHandler`（运行时组合在 API proxy 回退之前的进程内 RPC 拦截 dispatch）无条件提供。
3. `packages/client/connection/src/rpc-host.ts` — 无 webserver 时 `register()` 返回空 disposer：非 HTTP 宿主上的通道只是 HTTP 不可达，不是错误。

**引导序列。** renderer 的 `main.ts` 保持 stage 2 的 shell 投影直到 `ready`；随后 `openTransport()` → `installDesktopCarrier` → `getBootPayload()` → 执行 loader 门面 → 执行 preload bundles → 设置 `__DSH_BOOT__` → `new AppWebEntry(root).run()`——先清空 `#root`：`AppWebEntry` 的 `BootPage` 会把它的 `div[data-dsh-boot]` 追加进容器，而固定的 `mountApp`（`packages/client/ui-renderer/src/client/index.ts:61-72`）在该子元素存在时对整个容器做 hydration，因此 shell 留下的任何兄弟节点都会破坏 hydration。一个根，固定的应用。teardown 先销毁客户端树再关闭传输，使其流操作在存活通道上结束。renderer 的 `index.html` CSP 在 `script-src` 中加入 `'unsafe-eval'`：固定的 Cordis loader 在模块作用域经 `new Function` 求值 `!!js` 配置表达式（`vendor/loader/src/config/utils.ts:5`），没有它固定树无法引导；Electron 的 "Insecure CSP" 警告是其有文档记载的后果，shell 冒烟测试恰好容忍这一条警告、对任何其他警告失败。

 **构建。** renderer 用 Vite 打包固定的客户端树：共享的客户端构建环境 define、React 去重为一份、`node:module` 别名到一个抛错的桩（loader 的 require shim 在浏览器中是惰性的）、客户端代码静态读取的 `process.*` 名称在构建期定义。该应用仍是根构建不覆盖的 fork 应用；`pnpm --filter @deepseek-ai/dsh-desktop run build` 按 runtime → main → renderer 顺序构建。face 隔离门禁按编译器 face 拆分本应用的类型检查：renderer 消费了拆分包 `client/connection` 的客户端半边，因此在客户端聚合下经 `apps/desktop/tsconfig.client.json` 检查；Electron main、preload 与共享契约则在宿主聚合下经 `apps/desktop/tsconfig.host.json` 检查；应用的 `tsconfig.json` 是横跨两个 face 的独立构建。

## Consequences

- D1 与 D3 已解决（契约「未知」清单）：图走子进程 IPC，bundle 走传输 fetch；协议主机为 `127.0.0.1`。
- 固定源码在这三处桌面端启用改动上分叉（如上）；web app 不受影响，因为三处改动都以 webserver 存在与否为守卫。（stage 8 其后新增共享正确性集 U1–U3，记录于上游契约 —— M1–M3 仍是完整的载体集。）
- renderer 按源码消费四个 DSH 包（`client-web`、`client-connection`、`client-modules`、`host-apiproxy`）；边界测试的 renderer 白名单就是该集合加那一个 `api-path.ts` 源导入，其余一律显式失败。
- broker 保持按代单通道；应用的 boot 通道即运行时存活期内应用的通道，运行时冒烟测试经该通道上应用自己的载体驱动其往返（第二个通道会替换 boot 通道，boot 流量的在途响应会与测试竞态）。
- `__DSH_TRANSPORT__.fetch` 是通用 RPC fetch：冒烟测试的无密钥 `session.list` 往返是常设的端到端证明（renderer port → broker → 子进程 IPC → 适配器 → 进程内 dispatch）。
- 一个固定的读取器行为对载体测试是承重的：`readSse` 以一条 `console.error` 日志丢弃畸形帧而不是杀死流（`packages/host/apiproxy/src/fetch/client.ts:369-408`）。

## Alternatives considered

- 经传输 fetch 服务渲染好的 index（D1 的另一分支）——否决：index 注入是 webserver 效果（`webserver/index-inject`），伪造它等于在 desktop 里合成 DSH 的渲染期产物，而进程内图就是注册表自己的数据。
- 裸 `app` 协议主机（stage 1 的形状）——在 D3 否决：固定分类对非 loopback 主机名判 false，能力与信任栅栏会看到非 loopback 源。
- 从构建出的 `/client` 入口再导出事件路径常量——试过并回退：在已声明的 `./src/*` 子路径本就服务源码消费者的地方，它放宽了 CJS bundle 的公共 API。
- 为冒烟或诊断流量开第二个传输通道——否决：broker 按设计按代划分；替换会杀死应用的活动连接，而经应用自己的载体驱动往返覆盖了同样的边界。
- 无 `'unsafe-eval'` 的 CSP 外加一个免除 eval 的 vendored loader 补丁——否决：在 vendored loader 内部做第四处上游改动，对比私有 fork 应用上一个有文档记载的 CSP token。
