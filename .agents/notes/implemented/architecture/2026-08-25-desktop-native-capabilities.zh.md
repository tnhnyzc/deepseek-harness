# Agent Note: desktop 第五阶段 — 原生桌面能力提供方

Status: implemented

[English](2026-08-25-desktop-native-capabilities.md) | 中文

## Problem

stage 5（SPEC stage 5）必须为 desktop 建立原生能力边界：凡是触碰操作系统的 DSH 自有操作——选择目录、用默认应用打开路径——必须按 `DSH 客户端 UI → DSH API → DSH 运行时能力/提供方 → native.request → Electron main → Electron/OS API → native.response → DSH 运行时 → DSH 结果` 流转，renderer 绝不为 DSH 自有操作直接调用 Electron。stage 2 的临时安排——desktop 运行时子进程借固定的 `dsh-host-directory-picker-native` 提供方自行拉起 osascript/Zenity/KDialog/COM 选择器——不合适：被 fork 的子进程不应是拥有 OS 对话框的进程，宿主侧的默认应用打开器也不应在子进程里以子进程方式运行，而应经由 Electron。固定源码里恰好只有两个消费者（目录选择器座位与 `ApiProxyDefaults` 打开器），别无其他（没有文件选择器、没有 OS 通知），因此方法集合封闭于这两者。

## Decision

**通道。** 一条私有的 runtime↔main 通道骑在 supervisor 的 fork IPC 上——绝不经过 renderer、绝不经过 stage 3 传输端口、绝不使用 localhost。supervisor 在转发给传输中继之前先从子进程通道解复用出 `native.request` 与 `native.abort`（`apps/desktop/src/main/runtime.ts`，在 `RuntimeTransport` 旁新增 `RuntimeNative` 表面），运行时子进程侧的 bridge 以同样方式反向解复用（传输进程适配器按传输判别位忽略它）。封闭的线路契约位于 `apps/desktop-runtime/src/native.ts`，作为新的 `@deepseek-ai/dsh-desktop-runtime/native` 子路径发布（exports + tsdown 入口 + tsconfig `paths` 门面）：`native.request`（`directory.pick` / 带非空、无 NUL、≤32768 字符路径的 `path.open`）、`native.response`（成功，或封闭失败码 `unknown-method`、`malformed-request`、`dialog-failed`、`open-failed`、`cancelled`）、`native.cancel`（代际拆除时 main→child）、以及 `native.abort`（调用方的 abort 终结一个已派发的在途请求时，child→main 恰好发一次）。所有自由文本字段（`message` 与两个 `reason`）以 `NATIVE_MAX_DIAGNOSTIC_CHARS`（512）设界，并由解析器在线路边界强制执行——由生产方截断自己的出站值并不是契约。没有 `native.call(method, payload)`；消息中没有任何 DSH 业务词汇；方法、码表与界值都是解析器强制执行的常量。

**运行时侧。** `createNativeBridge`（`apps/desktop-runtime/src/native-bridge.ts`）是子进程侧的请求/响应客户端：唯一请求 id、持有调用方的 `AbortSignal` 贯穿操作整个生命周期（abort 以 `AbortError` 终结态结算、操作变为终结态、此后一切迟到的响应或取消都被忽略）、拒绝过期与重复 id，并在 dispose 或 supervisor 断连时以 `channel-closed` 结算每一个在途操作——没有任何操作能活过通道。在途 abort 还会把调用方的放弃以恰好一条 `native.abort` 传给 main（设界的字符串 signal reason，或固定兜底）——但仅限请求已派发之后；从未派发的请求不伪造远程取消，赢得竞态的响应也不产生 abort。DSH 座位消费它：`DesktopDirectoryPicker`（`apps/desktop-runtime/src/directory-picker.ts`）是新的 `ctx.directoryPicker` 提供方——同一个原生座位、一个在座位存活期内稳定的 `{ kind: 'native', pick }` 能力对象、`pick` 委托给 bridge——运行时入口同时提供该服务与 `nativeOpeners` 服务，并在拆除时先 dispose bridge 再销毁 fiber。

**提供方替换。** desktop 组合（`apps/desktop-runtime/src/composition.ts`）保持 stage 2 的 overlay 形态——禁用 web 的 `auto` `directory-picker` 行、插入一个提供方——但插入的现在是 desktop 提供方模块，构建到运行时入口旁的 `dist/directory-picker.js`，以 file URL 加载（对同目录路径做 `pathToFileURL`，POSIX 与 Windows 上都正确）。Loader 导入的是模块说明符，这就是文件路径以 URL 而非裸路径穿越的原因。

**main 侧。** `createNativeCapabilities`（`apps/desktop/src/main/native-capabilities.ts`）是封闭的 OS 注册表——`dialog.showOpenDialog({ properties: ['openDirectory'] })` 与 `shell.openPath(path)`——经由可注入端口，使行为在无 Electron 运行时下可测；它把失败映射到封闭码，并以协议自身的 `NATIVE_MAX_DIAGNOSTIC_CHARS` 给每条诊断设界。`createNativeChannel`（`apps/desktop/src/main/native-channel.ts`）经共享解析器校验每个请求（畸形请求是拒绝、绝不是 OS 调用；id 可读的得到 `unknown-method` 或 `malformed-request`，id 不可读的作为不可关联而丢弃）、dispatch、并以恰好一个终结态结算每个请求：成功、封闭码失败，或——在 `teardown(reason)` 时——对每个仍在途的请求发一条 `native.cancel`，此后迟到的结果与新请求一律丢弃。一条 `native.abort` 立即把其请求标记为逻辑终结：id 离开在途集合、不回复任何东西、畸形 abort 以失败关闭方式丢弃，OS 操作的迟到完成——可见对话框无法被可移植地关闭——在 `finish` 里被丢弃，而不是作为过期响应发出。通道按代际划分：`index.ts` 在每次 supervisor 关闭时重建它（拆除旧通道、创建并重新武装新通道；supervisor 在 close 处理器运行前清掉消息处理器，所以重新注册得以存活），并在 `before-quit` 拆除最后一个——单个长命通道会在第一代结束时死去，让此后每一代的请求都没有应答者。

**上游扩展（一处，有守卫）：M4。** `ApiProxyService`（`packages/host/apiproxy/src/index.ts`）读取一个可选的已提供服务 `nativeOpeners`（`{ openPath?, openTextFile? }`，类型在 `src/api/native-openers.ts` 并附 `Context` 合并），把其中存在的成员作为其 `ApiProxyDefaults` 打开器转发。缺席时包自带的原生打开器与 `canOpenNativePath()` 探测原样成立，故 web app 不变。desktop 提供 `openPath`（桥接到 `shell.openPath`）；于是 `canOpenPaths()` 报告 desktop 能够打开。`openTextFile` 刻意不桥接：固定的 Electron `shell.openPath` 不接受选项、没有文本编辑器意图，所以 `settings.openDocument` 保留 DSH 原生文本打开器（macOS 上 `open -t`），那里才真正需要文本编辑器。

**取消语义。** DSH 契约不变，业务码留在 DSH 侧：`host.pickDirectory` 把调用方 abort 映射为 `cancelled`、其他失败映射为 `internal`（`api-proxy.ts:2842-2869`）；`openTarget` 对打开做同样的映射。取消以两个相互独立的概念双向穿越：调用方 abort 在子进程内把 DSH 调用结算为 `cancelled`，并向 main 传一条 `native.abort`，后者把请求标记为逻辑终结并丢弃迟到的 OS 完成；main 发出的 `native.cancel`（代际拆除）是通道故障而非操作者取消——它把 DSH 调用结算为携带原因的 `internal`。区分是逻辑与物理之别：Electron 没有关闭已显示对话框的 API，所以 abort 情形下对话框可能仍留在屏幕上并在后台完成；其结果在 main 侧被丢弃，对话框自身的取消是操作者唯一的关闭方式。

**架构锚点。** 边界测试（`apps/desktop/tests/boundary.spec.ts`）新增：main 只能导入两个封闭协议子路径（transport + native）；四个原生能力源文件像传输文件一样被扫描 DSH 业务 RPC 字面量；renderer 与 preload 不得包含任何原生协议标签（`native.request`、`native.response`、`native.cancel`、`native.abort`、`directory.pick`、`path.open`）；组合不再挂载临时的 `-native` 提供方，同时保持单提供方 overlay。真实验收是 `apps/desktop-runtime/tests/native-boot.spec.ts`：fork 构建好的运行时、在子进程 IPC 上扮演 main 侧，锚定 `host.describe.canOpenPath`、选择成功/取消、打开成功/失败、取消映射、对在选择与打开两种在途操作上的客户端 abort 终结（各自穿过一条真实的 `native.abort`，其迟到结果被丢弃）、abort 后通道健康复用、以及 shutdown 退出。`apps/desktop/tests/native-integration.spec.ts` 用真实的 main 侧通道加可受控的 OS 端口应答同一个 fork 出的运行时，在 main 边缘端到端锚定 abort：在途集合立即清空、迟到的对话框完成不发出任何东西、下一个请求正常结算。

## Consequences

- stage 2 的宿主原生选择器不再被 desktop 挂载；固定的 `-native` 包仍为浏览器/宿主表面保留。每个组合仍只有一个 `ctx.directoryPicker` 提供方。
- desktop 运行时的构建增加两个入口（`native.js`、`directory-picker.js`），应用的构建顺序不变（runtime 先行）。
- 固定源码恰好分叉于一处（`dsh-host-apiproxy` 的 M4 接缝），以服务缺席为守卫；web app 的行为与先前逐位一致。
- fork IPC 现在承载第二个消息族；stage 3 传输协议未动，stage 4 的流取消修正得到保留（真实引导套件仍全绿）。
- 连同固定源码理由一并推迟：文件选择器、OS 通知、外部 URL 打开——在固定源码中均不存在（§6.3），封闭方法集合保持恰好两个现有消费者。

## Alternatives considered

- 保留 stage 2 的子进程选择器——否决：被 fork 的子进程拥有 OS 对话框与默认应用拉起，正是要移除的边界，而且对话框的父窗口根本不在显示它的那个进程里。
- renderer 侧原生桥（`window.desktop.pickDirectory`）——否决：它会让 renderer 成为 DSH 自有操作的发起者并绕过 DSH 服务座位，倒置固定源码确立的所有权。
- 在 stage 3 传输协议上扩展原生帧——否决：传输是 renderer 的通用载体，有自己的分帧、信用与按代通道；能力通道只属于 main↔child，骑 fork IPC 并沿用 supervisor 的代际身份。
- 从 desktop fork 出的网关把打开器经 `ApiProxyDefaults` 注入——否决：那会复制网关；一行有守卫的 `nativeOpeners` 服务让 DSH API 与错误/取消映射留在拥有它们的包里。
- 无论如何都经 `shell.openPath` 桥接 `openTextFile`——否决：固定 API 没有文本编辑器意图，那样会用默认（往往不是编辑器的）应用打开文档，徒改 `settings.openDocument` 的行为。
