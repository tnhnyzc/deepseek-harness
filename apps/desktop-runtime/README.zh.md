# @deepseek-ai/dsh-desktop-runtime

[English](README.md) | 中文

桌面应用用的独立 DeepSeek Harness 运行时进程。Electron 监督者在打包 Node 下
fork 本入口；它以编程方式启动 `web` profile 组成——与浏览器界面运行的同一
Harness——去掉 HTTP 分发行，经 fork IPC 通道上报就绪，并在关闭时处置整棵
Cordis 树。它从不启动 web 服务器，也从不解析自己的 stdout。自 stage 3 起，
它还在同一通道上服务桌面传输：fetch 兼容的请求/响应原语与不透明有序流，
背压由按方向的额度窗口提供。自 stage 5 起，它还承载原生能力通道：DSH
目录选择器座位与网关的默认应用打开器经该通道到达 Electron main 的
`dialog`/`shell`，运行时提供桌面 `DirectoryPicker` 插件，取代宿主原生
子进程选择器。范围与接缝见 `SPEC.md` #7-#11 与
[上游契约](../desktop/docs/upstream-contract.md)。

## 构建

在仓库根目录运行（入口随 host face 一起打包）：

```sh
pnpm run build          # tsc -b + root tsdown emits the four dist entries
```

入口为 `dist/index.js`（被 fork 的运行时）、`dist/transport.js`（传输协议
子路径）、`dist/native.js`（原生能力协议子路径）、`dist/directory-picker.js`
（桌面目录选择器插件，由组合以 file URL 加载）。

## 运行

不要直接运行；桌面监督者以如下形式启动它：

```text
<bundled-node> <this package>/dist/index.js
```

带 IPC 通道、`DSH_DESKTOP=1`、`DSH_HOME=<desktop-managed-home>`。控制协议
上行 `runtime.ready`（版本加能力标志）、下行 `runtime.shutdown`（处置并
退出）、上行 `runtime.transport-closed`（一个传输通道代结束）。同一通道还
承载 stage 3 的传输帧——fetch 与流消息，靠类型标签与控制消息解复用——以及
stage 5 的原生能力族：上行 `native.request`（一个封闭的 OS 能力调用）、
下行 `native.response`/`native.cancel`。

## 测试

在仓库根目录运行：

```sh
pnpm test apps/desktop-runtime
```

`boot.spec.ts` 在临时 `DSH_HOME` 下启动真实组成；`dist/index.js` 未构建时
自跳过。`transport.spec.ts` 用 fake `ApiProxy` 驱动协议与运行时适配器；
`transport-boot.spec.ts` 经构建产物在真实 fork 子进程上走 fork IPC 驱动
同一表面，同样自跳过。`native-protocol.spec.ts` 锚定封闭的线路契约；
`native-bridge.spec.ts` 锚定子进程侧请求/响应客户端（id、贯穿整个生命
周期的 abort 终结态、过期与重复拒绝、拆除结算）；`directory-picker.spec.ts`
锚定提供方；`native-boot.spec.ts` 在真实 fork IPC 上以构建产物扮演 Electron
main 侧（选择成功/取消、打开成功/失败、取消映射、abort 并丢弃迟到结果），
同样自跳过。

## 布局

- `src/index.ts` — 被 fork 的入口：IPC 协议、启动、传输挂载、处置。
- `src/transport.ts` — wire 协议（消息类型、解析器、额度窗口、port
  表面），同时以 `./transport` 子路径导出。
- `src/transport-runtime.ts` — 基于进程内 fetch 载体（`toFetchHandler`）的
  运行时适配器：fetch 流量原样透传，流作为载体 GET 被泵成有序、按额度把关
  的帧。
- `src/transport-process.ts` — fork IPC 的 `TransportPort` 适配器。
- `src/native.ts` — 原生能力协议（封闭消息集合、严格解析器），同时以
  `./native` 子路径导出。
- `src/native-bridge.ts` — 子进程侧原生能力客户端，走 fork IPC（请求 id、
  贯穿整个生命周期的 abort、拆除结算）。
- `src/directory-picker.ts` — 桌面 `DirectoryPicker` 提供方：原生座位，其
  选择器经通道到达 Electron main。
- `src/composition.ts` — 桌面 patch 栈（无 HTTP 覆盖层，含提供方替换）。
- `src/shutdown.ts` — 有界的进程退出控制器。
- `config/agent-presets/` — 随附的 preset 名册（与 `apps/cli/config` 同一
  约定）。
