# Agent Note: desktop 第三阶段 — IPC 传输（fetch + stream）

Status: implemented

[English](2026-08-23-desktop-ipc-transport.md) | 中文

## Problem

stage 3（SPEC #8–#11）必须在 renderer 与独立运行时之间加入 IPC 传输层：原语 A，fetch 兼容的请求/响应载体；原语 B，不透明的有序双向流载体；以及 Electron 主进程中的 dumb broker（哑中继）——它只能检查传输元数据（路由、生命周期、尺寸上限、取消、诊断），绝不解码业务负载。流必须支持无限长且缓冲有界——SPEC #10 点名「pause/resume 或按需的 credit 信令」——且不允许任何上游源码改动。每条通道的两端之间横着两个敌对的序列化边界：main 与 renderer 之间的 Electron IPC，以及 main 与运行时子进程之间的 fork IPC。

## Decision

协议落在运行时包 `apps/desktop-runtime/src/transport.ts`，经 `./transport` 子路径导出，使运行时与 desktop 应用共用同一个解析器：十六种 wire 消息类型（SPEC #9 全集外加 `fetch.response.credit` 与 `stream.credit`）、尺寸常量（64 KiB 最大帧、256 KiB 额度窗口、32 MiB 最大请求）、一个对畸形帧抛出 `TransportProtocolError` 的严格 wire 边界解析器、用于按方向做额度核算的 `TransportSendWindow`、作为通道 demux 判别式的 `isTransportMessage`，以及 Node 两种 port 都满足的结构化 `TransportPort` 表面。

背压采用 credit 信令，这正是 SPEC #10 明确允许的：每个方向最多在途 256 KiB，消费者按消费量回退额度——响应块在进入 `ReadableStream` 队列时、流帧在被消费者出队时——使被弃的消费者在一个窗口之内停住运行时，而不是无限缓冲。broker 的尺寸护栏只检查带 `data` 帧的 `data` 字节长度，对接收边界本会丢弃的帧不转发、而是向发起方合成一条 `frame-too-large` 错误回送。

main↔runtime 边界无法转移 `MessagePort`：Node `child_process` 根本没有 port 转移（实测：`child.postMessage` 不存在、`child.send(null, [port])` 抛 "This handle type cannot be sent"、`child.send(port)` 到达时是普通对象），因此 broker 直接在既有的结构化克隆 fork IPC 上转发 wire 消息本身，靠类型判别式与 `runtime.*` 控制消息解复用。同一边界还有第二个事实：child IPC 克隆会把 `Uint8Array`（甚至 `Buffer`）降级为普通对象。因此协议模块自带一个不透明 wire 编解码器——围绕 `data` 字段的 base64 标记——`toOpaqueTransportWire` / `fromOpaqueTransportWire`，在管道两端（supervisor 的收发与运行时的进程适配器）应用，使 broker 护栏、运行时解析器与 renderer 客户端永远只见到原始字节。

运行时适配器 `attachTransportRuntime(port, api)` 用真实的 `toFetchHandler` 接缝服务原语 A（它只按 `url.pathname` 路由，故客户端的假源 `http://dsh.local` 是安全的），用固定的下行映射服务原语 B——把流 `url` 解析为 DSH 客户端会给它起的名字：`/api/events.mux` 到 `api.events.mux`、`/api/events.host` 到 `api.events.host`——mux 输出按宿主精确的 `ServerRequest` 封包成帧。`runtime.transport-closed` 控制消息（或进程 `disconnect`）终结当前通道代的在途操作，但让适配器保持就绪以迎接下一代；只有 boot 期的 disposer 才会真正销毁它。运行时入口在 boot 落定后挂载传输，并在 `apiProxy` 服务缺失时显式失败。

Electron 主进程中的 dumb broker 拥有按代划分的通道对。只有 Electron 的 `MessageChannelMain` port 能跨越 `webContents` IPC——Node `worker_threads` port 不能，已实测确认——renderer 半边经 `webContents.postMessage(channel, message, [port])` 这个显式转移列表形式送达，因为 `webContents.send` 不转移 port。broker 双向透明转发，在运行时未就绪时拒绝打开，在 renderer port 关闭时终结运行时通道，在运行时离场时关闭 renderer port。

renderer 半边 port 根本无法跨越 `contextBridge`：活的 `MessagePort` 在页面里只会解析为一个惰性对象，而且即便事件被桥接，其 `data` 也会丢失，因为 `MessageEvent.data` 是原型访问器，桥接克隆会丢掉它。因此 preload 把真实 port 留在自己的隔离世界，把它的表面暴露为一组普通函数；消息事件以带自有属性的普通 `{ data }` 对象跨越。`openTransport()` 解析出该表面，在拒绝通道或 10 秒超时时 reject。

renderer 客户端 `createDesktopTransport(port)` 位于 `apps/desktop/src/renderer/transport.ts`：原语 A 暴露为 fetch 兼容函数，构造真实的浏览器 `Response`、其 body 是 `ReadableStream`（请求携带流 body 时加 `duplex: 'half'`；204/205/304 响应携带空 body，传输层从它的空流形态映射而来；abort 时发送 `fetch.abort` 并以 `AbortError` reject）；原语 B 暴露为 `openStream(url)`，解析为 `DesktopStream { id, outcome, frames(), send, close }`，按出队帧回退额度，上行帧超限时本地抛错。port 关闭时以 `transport-closed` 错误了结所有在途操作。

构建管线：`apps/desktop` 对 `@deepseek-ai/dsh-desktop-runtime` 增加一条 workspace dev 依赖（broker 导入协议子路径，且 main 构建先打包运行时，因为仓库根构建不覆盖 desktop 包）；`apps/desktop-runtime/tsconfig.json` 增加指向 `packages/host/apiproxy` 的项目引用，使适配器能给 `ApiProxy` 接缝定类型；根 `tsconfig.base.json` 增加协议子路径的唯一 paths 条目。

## Consequences

- 新的 workspace 边与入口：`apps/desktop` → `@deepseek-ai/dsh-desktop-runtime`、`./transport` 导出子路径、desktop 构建脚本里的显式构建顺序；`knip.json` 删除因此冗余的运行时 `src/index.ts` 条目（knip 从包 exports 推断它）。
- child IPC 中继是系统中唯一的非 `MessagePort` 边界；不透明编解码器被限制在管道两端，除 boot 套件外不出现于 broker、renderer 客户端或任何测试中。
- D2（契约「未知」清单）已解决：credit 信令已设计并测试，包括一个 600 KiB 响应体停在窗口上、随回退额度恢复，以及流载体上的逐帧额度。
- 固定的下行映射把 desktop 耦合到本 SHA 上客户端的流命名；新的 DSH 流端点只是一行映射表项，传输本身按 SPEC #9 保持流无关。
- 运行时控制协议新增 `runtime.transport-closed`——一个与进程死亡不同的通道代信号；supervisor 的强杀路径不变。
- stage 4 现在消费 `window.dshDesktop.openTransport()` 做 renderer 的 `__DSH_TRANSPORT__` 集成（契约 §3.5、C3）；客户端侧的 `AbstractApiClient` 子类是 stage 4 剩余工作。

## Alternatives considered

- 经 fork IPC 转移 `MessagePort` —— 不可能：Node `child_process` 不支持 port 转移（上文三条实测；文档化的可转移集合只有 net handle）。
- 在 Electron `utilityProcess` 中运行运行时 —— 否决：stage 2 的监督者已拥有完整 `DSH_HOME`/环境控制的固定 Node fork，`utilityProcess` 只会平添 ABI 与隔离面，传输上毫无收益。
- 让 renderer 创建通道并把它的 port 发给 main —— 在 main→renderer 投递失败期间考虑过；main 自持 `MessageChannelMain` 对加显式转移列表可行，且通道代所有权留在 broker 一处，保持拒绝/替换/拆除语义同处一地。
- 在单一 fork IPC 通道上手写 JSON-RPC —— 否决：没有按流的有序分帧与按流额度，且会把业务语义推进 main，SPEC #11 禁止。
- 更大窗口或无 credit —— SPEC #10 否决：「不要在 Electron main 里允许无界的 token 块数组」。
