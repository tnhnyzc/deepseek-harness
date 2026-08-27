# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

DeepSeek Harness 桌面应用的私有 Electron 壳。stage 1 交付加固的窗口、私有
`dsh-app://` renderer 协议与薄 renderer 入口；stage 2 加入运行时监督者：main
进程在固定版本捆绑 Node 下 fork 独立的 Harness 运行时（`apps/desktop-runtime`），
经 fork IPC 驱动其 `stopped/starting/ready/stopping/failed` 生命周期，并在退出时
经正常 DSH 处置路径停止它。stage 3 加入 IPC 传输：运行时经 fork IPC 提供
fetch 兼容的请求/响应原语与不透明的有序流，main 中的哑中继 broker 把帧
转给 renderer，renderer 经 `window.dshDesktop.openTransport()` 使用两者。
stage 4 经该传输从这个 renderer 引导固定的 DSH 客户端/UI 树：运行时在
报告就绪之前发布客户端 boot 图，renderer 装上 `__DSH_TRANSPORT__` 载体
接缝，`AppWebEntry` 接管唯一的应用根节点——没有第二个 UI。stage 5 加入
原生能力边界：DSH 自有的 OS 操作（目录选择器、默认应用打开路径）经一条
封闭的 runtime↔main 通道（骑在 fork IPC 上）到达 Electron 的 `dialog`/
`shell`，renderer 绝不为它们调用 Electron。stage 6 证明桌面端对正常用户
工作流与 `dsh web` 语义对等（`tests/dsh-parity.spec.ts` 的十一表面
对等性套件）。stage 7 加入桌面 UX：内容尺寸调整的 native 窗口
（1280×800，最小 1024×600）与 native 应用菜单，其动作经封闭的六成员
命令词表加平台加速器驱动固定版客户端——载体从不变更 Harness 状态。
stage 8 端到端证明事件日志语义：突发折叠、已取消的运行、流中渲染器重载
各自保持持久日志与转录精确一致，待批审批与待答问题跨渲染器重载存活
（`tests/dsh-event-correctness.spec.ts` 的五属性套件）；stage 6 的三个
发现在 DSH 接缝解决——为 drain 属主设立的有界关闭延迟契约、在连接就绪
接缝武装的 inspect 清单、以及被证明安全的通道替换——无任何载体变更。
stage 9 证明崩溃恢复：被杀死的运行时（kill -9）让渲染器存活并呈现携带
死亡原因与保留诊断信息的失败屏，用户请求的重启启动新一代运行时，客户端
从持久日志重建会话，被打断的轮次由固定版持久化修复确定性闭合为
`interrupted`——绝不为 `completed`（`tests/dsh-crash-recovery.spec.ts`
的九属性套件），同样无任何载体变更。stage 10 是安全加固阶段：渲染器、
preload、主进程与运行时之间的每条信任边界现在都有界并钉住——传输线缆约束
全部元数据并封顶并发操作数，原生通道约束 id 与响应路径，BrowserWindow 面
在源码中钉住，权限策略默认拒绝、仅留唯一有源码出处的剪贴板写入例外，
preload 桥仅限主 frame，CSP 是钉住的最小化策略、其 'unsafe-eval' 与图片
blob URL 有固定版客户端源码出处，生产代码不创建任何网络监听器（Agent Note
`2026-08-27-desktop-stage10-security`）。范围、接缝、
已应用的本地改动与未决的 D4 问题（D1、D2、D3 已在 stage 3-4 解决）见
`SPEC.md` #6-#11、`ARCHITECTURE.md` 与[上游契约](./docs/upstream-contract.md)。

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
  （响应组装、流式请求体、逐数据路径的额度、序号校验、完整的 abort
  生命周期，以及打开/关闭的流生命周期）。
- `tests/transport-broker.spec.ts` 总是运行：main broker 对 fake（wire 门的
  丢弃与合成尺寸拒绝、双向中继、就绪拒绝、通道替换、拆除）。
- `tests/native-capabilities.spec.ts` 与 `tests/native-channel.spec.ts`
  总是运行：OS 能力注册表与 main 侧通道对注入的 fake（封闭的成功/取消/
  失败映射、有界的诊断、重复拒绝、畸形请求分类、拆除时对每个在途
  请求的取消，以及把迟到 OS 结果丢弃的调用方 abort 终结）。
- `tests/native-integration.spec.ts` 在缺少运行时 bundle 时自跳过：fork
  构建好的运行时，并用真实的 main 侧通道加可受控的 OS 端口应答它——选择
  正常结算，调用方 abort 立即清空 main 侧在途集合、迟到的对话框完成不
  发出任何东西，通道对下一个请求保持健康。
- `tests/security.spec.ts` 与 `tests/boundary.spec.ts` 总是运行：IPC 发端
  信任规则，以及 SPEC §31 架构边界扫描（main 无 DSH 产品导入、renderer 的
  DSH 导入限于 boot 集合、传输与原生能力层无业务字面量、renderer 与
  preload 无原生协议知识、无 HTTP 监听器）。
- `tests/dsh-carrier.spec.ts` 总是运行：`__DSH_TRANSPORT__` 载体对脚本化
  fake（接缝形状、API 客户端里的事件路径 vs fetch 路由，以及 bundle 加载
  器的 fetch + 经典脚本执行）。
- `tests/shell.spec.ts` 在缺少构建产物（端到端运行时块额外需要运行时 bundle
  与捆绑 Node）或没有 GUI 会话时自跳过；其运行时冒烟块断言 stage 4 交接
  （DSH 全局已安装、shell 状态已消失），并经应用自己的载体完成一次 fetch
  往返。`protocol.spec.ts` 总是运行。

## 打包

`forge.config.ts` 是打包规格（asar + `extraResource: dist/renderer` 与
`node` -> `Resources/`）。Forge 7 CLI 无法在本 monorepo 的 isolated pnpm
布局下运行系统检查；stage 1 用 `@electron/packager` 验证 bundle 组装（见
stage 1 Agent Note）。工具链在 stage 11 定案。

## 布局

- `src/main/` — Electron main 进程：窗口、`dsh-app://` 协议、session 加固、
  运行时监督者（`runtime.ts`、`runtime-paths.ts`）、哑传输 broker
  （`transport-broker.ts`），以及原生能力边界（`native-capabilities.ts`、
  `native-channel.ts`：封闭的 OS 注册表与经 supervisor fork IPC 的按代际
  请求/响应通道，调用方 abort 把其请求逻辑终结、迟到的 OS 完成被
  丢弃）。Node API 不达 renderer。
- `src/preload/index.cjs` — 签入的 CJS 监督桥（沙箱 preload 无法加载 ESM）；
  状态视图、状态事件、重启，以及把活传输 port 交给 renderer 的
  `openTransport()`。
- `src/shared/runtime-state.ts` — main、preload 与 renderer 共享的状态与
  传输类型。
- `src/renderer/` — 打包后的 renderer 入口（CSP 严格、无 `file://`）；投影
  运行时生命周期与可恢复的失败界面，携带 renderer 传输客户端
  （`transport.ts`），自 stage 4 起装上 DSH 载体（`dsh-carrier.ts`）并在
  就绪时把唯一根节点交给固定的 `AppWebEntry`；`node-module-stub.ts` 为
  loader 在浏览器中惰性的 `node:module` require 提供桩。
- `scripts/bundle-node.ts`、`node-versions.json` — 构建时按目标下载并做
  sha256 校验的固定 Node。
- `tests/` — 监督者、smoke、协议、renderer 客户端、broker、原生能力与
  端到端测试。
