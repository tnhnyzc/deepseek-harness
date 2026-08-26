# Agent Note：桌面端 stage 9 —— 运行时崩溃恢复：确定性失败、重启与重连

Status: implemented

[English](2026-08-26-desktop-stage9-crash-recovery.md) | 中文

## Problem

Stage 9（SPEC §23）必须证明：当独立的 DSH 运行时进程意外死亡 —— 生成中途、工具中途、或交互中途 —— 桌面端确定性恢复：渲染器存活，旧传输上的每个操作确定性终止，UI 进入携带死亡原因与诊断信息的失败状态，用户请求的重启启动新的一代运行时，DSH 客户端重连并从持久化状态重建会话。被打断的轮次绝不得被报告为已完成，桌面层不得虚构会话事件。

stage 2–7 构建的监管器生命周期已实现了其中大部分，但从未在真实崩溃注入下得到证明：此前所有测试用的都是优雅关闭或就绪前失败。

## Decision

**原位重启设计证明足够；无需改动渲染器或监管器。** 本阶段以关键路径的完整检视开场（渲染器 `transport.ts`、模块门面、载体、监管器）。stage 4 的原位重启在端口关闭下结构上就是确定性的：每次 `AppWebEntry.run()` 新建 Context 与模块系统，`window.__ModuleLoader__` 门面是纯赋值（可安全重复求值），preload 包是惰性 CJS（求值只登记工厂），载体按代重装 `__DSH_TRANSPORT__`，而端口关闭时的 `teardownAll` 拒绝所有在途 fetch/stream 操作、取消 credit 窗口、唤醒停泊的生产者。E2E 套件端到端确认了这一点；无需加固。

**打断轮次的崩溃恢复是固定版 DSH 持久化，不是桌面代码。** 当新一代冷加载一个日志止于轮次中途的会话时，持久化协调器在 `prepareCore` 中应用 `interruptedTurnClosers`（`packages/core/session/src/repair.ts:27`，`packages/session/session-persistence/src/coordinator.ts:903`）：为每个没有结果的 assistant 工具请求合成一条 `tool/result` 错误（未记录 `tool/call` 时为 `TOOL_NOT_STARTED`，已记录时为 `TOOL_OUTCOME_UNKNOWN`），随后 `step/end`，随后 `turn/end { reason: { kind: 'interrupted' } }`。合成是确定性的 —— 序列接续日志，时间戳复用最后一条真实事件。该机制与 `dsh web` 和 CLI 共享，且恰好就是本阶段的两条不变量：被打断的轮次以 `interrupted` 结束、绝不为 `completed`，桌面层不虚构任何会话事件 —— 闭合事件来自固定版持久化层，在加载时产生。

**单元层：监管器 fixture 的两个崩溃模式。** `apps/desktop/tests/fixtures/runtime-fixture.mjs` 增加 `crash-once`（首次启动在就绪后以代码 3 退出，重试成功）与 `kill`（就绪后 SIGKILL 自身）。`apps/desktop/tests/runtime.spec.ts`（现 10 条）钉住：意外死亡后用户请求的重启再次达到就绪；信号死亡被报告，且该代的诊断信息跨重启保留。

**E2E 崩溃恢复套件。** `apps/desktop/tests/dsh-crash-recovery.spec.ts`（8 条）驱动构建产物 —— 真实 Electron、真实 desktop-runtime、真实固定版组合 —— 配合脚本化确定性 SSE provider。崩溃注入是对运行时 pid 的进程组 SIGKILL：被 fork 的子进程自领一个组，故组杀到达其后代 —— shell 工具、subagent worker —— 与监管器的强制杀完全一致。发现该进程要求它既是运行时入口、又是本套件 Electron 主进程的直系子进程：其他套件在并行中从同一入口启动各自的运行时，首次并行运行证明杀错进程会破坏另一套件的测试、并让杀错者自己的用例超时。

八个属性：(1) **空闲** —— 失败屏显示死亡原因，渲染器存活，在途传输操作被拒绝，用户请求的重启启动并重连；(2) **生成中途** —— 轮次尾部被持久闭合为 `interrupted`、绝不为 `completed`，同一会话上的后续提示正常完成；(3) **shell 工具期间** —— 已记录的 `tool/call` 以固定版 `TOOL_OUTCOME_UNKNOWN` 恢复文本闭合，由固定版 UI 渲染（`Failed` + 工具名），且组杀把子进程一并带走；(4) **审批等待** —— 待批审批是活的 Mux 状态：随运行时而死，恢复后无残留面板，会话可续；(5) **问题等待** —— 对待答 `ask_user_question` 同理；(6) **subagent** —— 父轮次由固定版闭合事件关闭，而独立持久化的子会话永不完成；(7) **第二代** —— 一次应用生命周期内两次崩溃代后，所有持久化事实完好，包括打断轮次的恢复渲染；(8) **失败时退出** —— 干净退出、不挂起。

## Facts the stage settled

- **真实运行时在正常运行时是安静的** —— stdout/stderr 无任何输出，故干净崩溃后监管器诊断环合理地为空；失败屏仅在诊断环非空时渲染其诊断 `<pre>`（fixture 的 `kill` 模式证明保留路径）。
- `approval/requested` 与 `question/requested` 是**活的 Mux 帧**，不是日志事件：待答交互是运行时状态，崩溃将其彻底销毁，失败屏不得假装它存活。
- 固定版 UI 将打断的工具轮次渲染为 `Failed` + 工具名 + 固定版恢复文本（"The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown."）；工具描述与命令不在折叠行中，故 DOM 探针必须使用恢复文本。
- 委托的 subagent 在侧栏显示 `1 subagent` 徽章，而非子任务的描述；子会话是同家目录下独立的 `session.jsonl`，被排除在父会话的平衡检查之外。
- 运行时约一秒完成启动；完整八属性套件（七个崩溃/重启周期）约 14 秒跑完。
- 跨套件的 E2E 崩溃探针必须按父 pid 而非仅入口路径来区分运行时。

## Consequences

- Stage 9 退出标准达成，无载体变更、无新增上游修改：M1–M3 仍是完整的桌面端启用集，U1–U3 仍是完整的共享 fork 差异集，崩溃恢复语义是被套件端到端钉住的固定版持久化行为。
- 桌面端套件（`apps/desktop`）现为 162（152 基线 + 2 监管器单元 + 8 崩溃 E2E）；含 desktop-runtime 包共 276，全绿。
- 监管器的失败/重启路径如今在每个崩溃窗口下经真实 kill -9 证明；诊断保留路径由 fixture 证明，因为真实运行时在正常运行时不向诊断环写入任何内容。
- 崩溃恢复套件是常设回归守卫：任何让崩溃不再确定性的未来改动 —— 轮次被报告为完成、残留的待答面板、挂起的退出 —— 都会使其失败。

## Alternatives considered

- 桌面层合成闭合事件（渲染器或运行时在崩溃后自写 `turn/end`）—— 否决：固定版持久化层在加载时已确定性完成此事，且与 `dsh web` 和 CLI 共享；桌面侧副本会成为可能与固定版修复分叉的第二事实源。
- 崩溃时自动重启而非失败屏加用户请求重启 —— 按 SPEC §23 否决：崩溃是用户可见的失败；失败屏展示原因，由用户决定是否重试。
- 仅按 pid（而非进程组）杀运行时 —— 否决：shell 工具的子进程与 subagent worker 会存活，恢复转录将与生产监管器的强制组杀分叉。
- 仅按入口路径发现运行时的崩溃探针 —— 依证据否决：一次并行套件运行中它 SIGKILL 了 desktop-ux 套件的运行时，破坏其八条测试，同时让自身空闲用例超时；按父 pid 匹配使探针套件局部化。
