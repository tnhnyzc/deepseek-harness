# @deepseek-ai/dsh-desktop-runtime

[English](README.md) | 中文

桌面应用用的独立 DeepSeek Harness 运行时进程。Electron 监督者在打包 Node 下
fork 本入口；它以编程方式启动 `web` profile 组成——与浏览器界面运行的同一
Harness——去掉 HTTP 分发行，经 fork IPC 通道上报就绪，并在关闭时处置整棵
Cordis 树。它从不启动 web 服务器，也从不解析自己的 stdout。自 stage 3 起，
它还在同一通道上服务桌面传输：fetch 兼容的请求/响应原语与不透明有序流，
背压由按方向的额度窗口提供。范围与接缝见 `SPEC.md` #7-#11 与
[上游契约](../desktop/docs/upstream-contract.md)。

## 构建

在仓库根目录运行（入口随 host face 一起打包）：

```sh
pnpm run build          # tsc -b + root tsdown emits apps/desktop-runtime/dist/index.js
```

## 运行

不要直接运行；桌面监督者以如下形式启动它：

```text
<bundled-node> <this package>/dist/index.js
```

带 IPC 通道、`DSH_DESKTOP=1`、`DSH_HOME=<desktop-managed-home>`。控制协议
上行 `runtime.ready`（版本加能力标志）、下行 `runtime.shutdown`（处置并
退出）、上行 `runtime.transport-closed`（一个传输通道代结束）。同一通道还
承载 stage 3 的传输帧——fetch 与流消息，靠类型标签与控制消息解复用。

## 测试

在仓库根目录运行：

```sh
pnpm test apps/desktop-runtime
```

`boot.spec.ts` 在临时 `DSH_HOME` 下启动真实组成；`dist/index.js` 未构建时
自跳过。`transport.spec.ts` 用 fake `ApiProxy` 驱动协议与运行时适配器；
`transport-boot.spec.ts` 经构建产物在真实 fork 子进程上走 fork IPC 驱动
同一表面，同样自跳过。

## 布局

- `src/index.ts` — 被 fork 的入口：IPC 协议、启动、传输挂载、处置。
- `src/transport.ts` — wire 协议（消息类型、解析器、额度窗口、port
  表面），同时以 `./transport` 子路径导出。
- `src/transport-runtime.ts` — 基于 `toFetchHandler` 与固定下行流的运行时
  适配器。
- `src/transport-process.ts` — fork IPC 的 `TransportPort` 适配器。
- `src/composition.ts` — 桌面 patch 栈（无 HTTP 覆盖层）。
- `src/shutdown.ts` — 有界的进程退出控制器。
- `config/agent-presets/` — 随附的 preset 名册（与 `apps/cli/config` 同一
  约定）。
