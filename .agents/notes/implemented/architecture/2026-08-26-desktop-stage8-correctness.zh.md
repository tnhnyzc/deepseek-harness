# Agent Note：桌面端 stage 8 —— 会话与事件正确性：关闭延迟、inspect 武装、正确性套件

Status: implemented

[English](2026-08-26-desktop-stage8-correctness.md) | 中文

## Problem

Stage 8（SPEC §22）必须证明桌面端精确保持固定版 DSH 事件日志语义 —— 不丢失、不重复、不乱序、不虚构事件 —— 覆盖突发流、取消与渲染器重载。Stage 6 的对等流程暴露了三个必须先在其正确接缝处解决、否则该证明毫无意义的发现：

1. **重命名后冷列表显示旧标题。** 用户重命名是一条持久的 `session/title` 事件，但为冷列表标题提示供数的投影缓存可能丢失承载它的写入：对等流程重启后看到的是旧检查点标题。
2. **冷启动 inspect 同步瞬态。** 冷启动时一条 `[cordis-client-runner] syncing inspect providers failed: … no active Connection` 控制台错误，对等门槛不得不为它开特例。
3. **传输通道替换。** 代理在重开时替换通道；Stage 6 无法排除被替换通道误投递陈旧在途响应的可能。

载体规则是严格的：共享 DSH 缺陷必须在 DSH 接缝修复（与 `dsh web` 共享），绝不做桌面端绕行，固定版树保持零改动（M1–M3 仍是本地修改的完整集合）。

## Decision

**发现 1 —— 四个根因，一个有界的关闭延迟契约。** 端到端追踪对等失败（一次文件门控的插桩运行显示：切分已经正确之后，drain 的最终写入仍失败于 `unit 'session_projcache' is closed`）确定了四个独立根因：A —— 存储设施的 `closeAll` 与属主自身的 `close()` drain 并行关闭域，drain 的最终 put 与单元关闭赛跑（`packages/storage/storage-domain/src/index.ts`）；B —— `session-projection-cache` 每次 `write()` 都新开一条存储链，同一会话的两个在途存储交错读-改-写，旧写入可能覆盖新写入；C —— 重命名切分注册过晚，切分前已准入的写入仍可在切分后落盘、使旧标题复活；D —— 存储插件的 disposer 调用 `backend.close()`，它在仍在 drain 的域下关闭了所有打开的单元（`packages/storage/storage-json/src/index.ts`），包级复现漏掉 D，因为内存一致性后端从不关闭其单元。

修复是一个作用域有界的 DSH 全域契约：`Domain.deferClose(settled)`（`packages/storage/storage-domain/src/domain.ts`）允许属主登记一个结算，**基础设施发起的**关闭必须等待它 —— 设施 `closeAll`，以及经 `DomainImpl` 的 `onDeferral` 钩子、被路由后端的 `close()`。属主自身的 `close()` 永不被延迟，因此延迟不可能使处置死锁；结算以进程关闭宽限期为上界。`StorageBackend.deferClose?(settled)`（`packages/storage/storage/src/backend.ts`）对关闭从不触碰打开单元的后端是可选的，但一致性套件要求 kv 后端必须实现（`packages/storage/storage/tests/contract.ts`）；json 与 sqlite 在关闭单元前等待延迟，json 的关闭是一次性的（run-once），并发第二次 `close()` 不可能在第一次仍在等待时关闭单元。投影缓存与消息反馈各自登记 drain 结算并在 `finally` 中结算；缓存的写入跑在每会话链（`queueWrite`）上，注册边界切分急切取出，由此关闭 B 与 C。验证：`cache.spec.ts` 中确定性的设施卸载复现（回退 A 则其失败）、storage-domain 延迟契约测试、以及对等套件新增的 E2E 重命名 → 干净关闭 → 重启 → 冷列表标题断言。

**发现 2 —— inspect 清单在连接就绪前只暂存不发布。** 首次 inspect 清单同步可能在网关每次同步前解析的 `connection` 就绪之前执行；尝试良性失败，首个 `connection/reset` 反正会重新发布。注册表（`packages/extensions/cordis-client-runner/src/client/inspect-registry.ts`）现在未武装时只暂存：注册在 `arm()` 前把 provider 留在本地，runner 在首个 `connection/reset` 时武装 —— 即就绪接缝，因为客户端运行时仅在 `connection` 解析后激活，且为每个（重）建立的一代发出 reset。晚于该 reset 应用的 runner（迟到入口、HMR）探测的是网关检查的同一个严格 `ctx.get('connection')`，故探测不可能在同步仍会失败时通过。瞬态消失，对等套件的冷重启控制台门槛恢复完全严格。

**发现 3 —— 通道替换是安全的；无需修复。** 渲染器传输以 `crypto.randomUUID()` 寻址操作，新客户端静默丢弃未知 id 的帧，被替换通道的陈旧在途响应不可能被错误归因（`apps/desktop/src/renderer/transport.ts`）；`RuntimeTransport.onMessage`/`onClose` 是单槽替换，监听器不会累积；产品流程从不在有存活旧客户端时替换通道（窗口在任何重开前先拆掉自己的端口，且仅当无存活应用时才启动应用）；端口关闭时代理的 `closeChannel()` 到达子进程，其 transport-runtime disposer 中止所有在途操作。记录于 `apps/desktop/docs/upstream-contract.md`，而非打补丁。

**正确性套件。** `apps/desktop/tests/dsh-event-correctness.spec.ts`（5）驱动构建产物 —— 真实 Electron、真实 desktop-runtime、真实固定版组合 —— 配合 `DEEPSEEK_BASE_URL` 接缝上的脚本化确定性 SSE provider（步数 = 提示标记之后的工具结果计数；交错时单条响应携带文本 delta 加一个尾部工具调用；`max_tokens: 64` 的自动标题调用得到中性标题）。缺构建产物时自我跳过，任何渲染器 `console.error` 或页面错误即失败。五个属性：(1) **突发折叠** —— 一个轮次内文本步与工具步交错：渲染行保持精确顺序与多重性，日志保留每个 `tool/call`（无合并），持久序列顺序（文本 delta、工具调用、工具结果、`turn/end`）与渲染顺序一致；(2) **已取消的运行** —— 首个 chunk 后停止：转录与持久日志逐 token 一致，切分之后的尾部既不渲染也不持久，且存在终结 `turn/end { reason: { kind: 'aborted' } }`；(3) **流中渲染器重载** —— 重载脱离客户端但不取消运行：轮次在运行时中完成，每个 chunk 恰好持久一次，重连客户端折叠完整文本（而非脱离时刻的快照），持久间隙中不出现该场景无法解释的事件类型；(4) **跨重载的待批审批** —— Read-Only 下的 workspace-write 升级在重载后仍可作答，作答完成轮次，且 `tool/call` → `approval/asked`（经 `callId`）→ `approval/decided`（经 `id`）链按序持久；(5) **跨重载的待答问题** —— `ask_user_question` 在重载后仍可作答，作答完成轮次。

## Facts the stage settled

- **持久的 `assistant/chunk` 记录就是流式协议本身** —— `block-start` / `text-delta` / `block-end` / `usage` / `finish`。`block-end` 重复整块全文，因此逐 chunk 正确性必须按 `text-delta` 记录度量，而非日志子串（子串计数会双重计数）。
- **每个提示都被持久 splice**：一条 `agent/inbox/spliced` 把用户消息插入下一轮收件箱，另一条在轮次开始时 splice 出去。
- **渲染器重载只脱离不取消**：轮次在运行时中继续执行并完成；待批审批与待答问题是运行时状态，重载后仍存活且可作答。
- `approval/asked` 携带 `{ id, toolName, callId, reason }`；被升级工具的参数在 `tool/call` 记录里。用户停止以 `{ reason: { kind: 'aborted', reason: { kind: 'user' } } }` 结束轮次；完成的轮次以 `{ reason: { kind: 'completed' } }` 结束。
- `session.list` 行携带投影基线（`projections: { asOfSeq, values }`），即冷列表的标题来源。
- **Cordis 拆卸是并行的**（`Fiber._unload` = 对全部 disposer 的 `Promise.all`）：任何 drain 可能晚于自身 `close()` 的属主，必须在所有可能抢先于它的关闭点登记延迟 —— 设施与后端，而不只是属主自身。
- 自动标题调用是 `max_tokens: 64` 的 chat completion；脚本化 provider 必须特判它，否则轮次正文会拿到一个标题。
- `expect.poll` 需要测试上下文 —— 亦在 `beforeAll` 中运行的 helper 必须用普通轮询。

## Consequences

- Stage 8 退出标准达成：三个 Stage 6 发现在 DSH 接缝解决，无载体变更、无固定版树修改（M1–M3 仍是完整集合），正确性套件端到端证明事件保持属性。
- 完整桌面端套件：152（147 基线 + 5 事件正确性）。
- 延迟契约现在是承重 DSH API：未来任何处置时 drain 的属主都必须登记其结算，任何关闭会触碰打开单元的 kv 后端都必须实现 `deferClose`（一致性套件强制两者）。
- storage-json 的 run-once 关闭消除了一个潜在的并发关闭不对称（第二次 `close()` 可在第一次仍等待延迟时关闭单元），它影响的是所有消费者，不只是桌面端。
- 对等门槛的控制台检查恢复完全严格 —— 不再有特例。

## Alternatives considered

- 发现 1 的桌面端绕行（例如在渲染器关闭前强制一次投影写入）—— 否决：载体规则，且该竞态属于 DSH；`dsh web` 的标签关闭有同样的暴露面。
- 在 `StorageError: unit … is closed` 之后重试缓存的最终 put —— 否决：单元是永久关闭的；重试掩盖缺失的关闭顺序契约，而失败形态（丢失标题）是数据丢失，不是瞬态。
- 无条件延迟后端关闭（总是等待在途域 drain）—— 否决：后端看不见域属主；延迟必须由 drain 在途的属主登记，且不得作用于属主自身的 `close()`。
- 在 `connection`-resolved 事件而非首个 `connection/reset` 上武装 inspect 注册表 —— 否决：不存在这样的事件；reset 是运行时为每个（重）建立连接发出的一代，且本就是 runner 已在观察的事件。
- 传输关闭时中止在途操作（让渲染器重载取消运行）—— 否决：重载是客户端侧事件；固定版语义让运行在运行时中存活，且从日志折叠的属性（测试 3）才是正确的保证。
