# Agent Note：桌面端 stage 6 —— 桌面传输链路上的 DSH web 对等性

Status: implemented

[English](2026-08-25-desktop-stage6-parity.md) | 中文

## Problem

Stage 6（SPEC §15）要求在加入任何桌面端 UX 之前，先证明桌面端对正常用户工作流与 `dsh web` 语义对等：会话列表、新建会话、重命名、工作区选择、对话渲染、流式响应、轨迹/工具渲染、审批、用户提问、取消、模型/供应商设置，以及重启后会话恢复。DSH 保持对全部 agent 语义的唯一所有权（桌面端仅为载体），证明必须在真实应用中运行真实的固定版客户端树，而测试环境既没有 API key，也没有可驱动的原生 OS 目录对话框。

## Decision

**对等性测试基座。** `apps/desktop/tests/dsh-parity.spec.ts` —— 单配置档、十一个顺序测试，跑在构建产物上：真实 Electron（对 `dist/main` 的 `_electron.launch`）、真实 desktop-runtime 子进程、真实固定版 DSH 组合、真实客户端树。唯一非真实元素是一个跑在 loopback HTTP 上的脚本化确定性 SSE provider，经由固定版 DeepSeek provider 的 `DEEPSEEK_BASE_URL` 接缝到达 —— 与 web 线真实宿主 e2e 使用的同一无 key 接缝。该 provider 按提示词文本中的标记回答逐轮脚本：带节奏的文本块（流式证明：部分文本在轮次结束前即可见）、工具调用（`bash`、`ask_user_question`），以及携带 `sandbox_permissions: 'workspace-write'` 的升级重请求（审批证明）。套件在缺少构建产物时自我跳过，并守住控制台门槛：零渲染器 `console.error`/页面错误。

**表面覆盖。**（1）种子工作区连同其空白会话与已解锁的输入器出现在列表中；（2）增量流式；（3）bash 工具卡片加轨迹渲染；（4）审批 `Allow once` 执行该升级操作；（5）`Reject` 不执行；（6）`ask_user_question` 通过提问输入器作答；（7）流中取消；（8）经会话行菜单重命名，且持久化到日志；（9）经 `New session` 创建第二个会话；（10）模型/供应商设置对话框；（11）干净重启恢复（两个会话、均不运行、无欢迎通知、历史重开、重命名持久）。

**工作区选择。** OS 目录对话框无法以程序方式驱动。选择路径经种子注册表加启动自动选择证明：基座在首次启动前写入版本 2 的工作区注册表（`<DSH_HOME>/storages/workspace.json`，`unit: { name: 'workspace', version: 2 }`），客户端的 `startInitialSelection` 选中唯一工作区并复用其空白会话。原生对话框本身属于手工冒烟步骤。

**基座编码的无 key 客户端机制。** 关于固定版客户端树、任何对等性消费者必须了解的事实 —— 全部为观察并断言所得，未做任何修补：

- 首次运行"内测声明"（`packages/client/ui-settings-models/src/client/WelcomeNotice.tsx`）仅在其 `ui-onboarding` 设置域加载完成后才挂载 —— 即 **在** `#root[data-state=ready]` **之后** —— 且其 `OnboardingSurface`（`packages/client/ui-primitives/src/OnboardingSurface.tsx`）向 body 传送一个遮罩，在确认前将 `#root` 置为 inert。在 ready 时点做一次性可见性检查会漏掉该通知，之后的点击则被遮罩拦截。基座在 `beforeAll` 中确认：等待可见 → 点击 `Continue` → 等待脱离 DOM，容忍其缺席（已确认过）。确认持久化于 `ui-onboarding` 设置命名空间（`welcomeNoticeVersion`，与 `2026-08-13.1` 精确相等），因此重新启动不再显示通知 —— 重启测试中已断言。
- 侧边栏默认收起；每个会话行的操作单元格（`.rowActions`，`Rows.module.css`）在行悬停前为 `display: none`，菜单按钮携带 `aria-label="Session actions for {title}"` —— 重命名路径为悬停 → 点击 → `Rename session` → `input[aria-label="Session name"]`。
- 输入器以 `[data-composer-card] textarea` 上的 `readonly` 锁定（绝非 `disabled`），且其占位符在第一轮之后变化；稳定选择器是该卡片的 textarea，而非占位符。
- 折叠态工具卡片显示工具名加描述；命令文本只在展开的席位中渲染。Chat/Trajectory 切换器是 `role="tab"`，不是按钮。
- 位于 `<DSH_HOME>/sessions/<projectKey(cwd)>/<id>/session.jsonl.zstd` 的会话日志是**拼接的 Zstandard 帧容器**（每个持久写批次一帧；经 `scanZstdFrames` 结构化解码，`packages/session/session-persistence-jsonl/src/zstd.ts`）。Node 的 `zstdDecompressSync` 对此类文件只解码第一帧，因此基座移植后端的帧扫描来检查持久状态（标题事件、重命名持久性）。

**重启语义（证据）。** 优雅关闭链按接线正确（before-quit → supervisor 停止 → runtime `runtime.shutdown` → fiber 处置 → 写后通道静默，5 秒有界自强制）：持久日志按 seq 顺序包含全部标题事件（回退标题、provider 标题、用户重命名）。暴露出两个 DSH 所有的冷启动行为，二者均与 `dsh web` 共享，均非载体缺陷：

- 重启后的**列表**行标题可能短暂显示投影缓存的检查点标题：缓存（`packages/session/session-projection-cache`；web-app 行配置 `writeEveryEvents: 200`、`writeIntervalMs: 5000`）在最后一次 `turn/end` 或会话处置时打检查点，晚于最后一次 `turn/end` 落地的重命名不在冷启动行中。打开会话会重放日志尾部，行随即改标为用户重命名；无数据丢失。
- 重启后的客户端可能在 inspect 同步输掉连接建立竞态时记录一条瞬态 `[cordis-client-runner] syncing inspect providers failed: … no active Connection`。

二者均属 Stage 8 所有的竞态窗口/缓存陈旧问题（已延期：竞态窗口、事件丢失、重连病理、跨渲染器重载的悬置交互、对抗性断连），不在 stage 6 范围内。重启测试断言真实的对等结果 —— 会话恢复、无运行中会话、历史重开、行在打开时改标为用户重命名、重命名在日志中持久、欢迎通知不再出现 —— 并对任何其他渲染器错误失败，仅按消息前缀放行那一条瞬态。

**修复的载体缺陷（组合）。** `apps/desktop-runtime/package.json` 原先只声明两个 bundle 包（`dsh-base`、`dsh-web-app`）；组合后的 web-app 配置在启动时还会经 profile `node_modules` 解析 preset/工具行（agent-tool-presentation、persona、terminal、terminal-bash、tool-ask-user、tool-bash-persistent、tool-cordis、tool-pwsh-persistent），因此会话创建失败。八个包全部作为 workspace 依赖补上；knip 的 `apps/desktop-runtime` `ignoreDependencies` 从两个具名 bundle 泛化为 `@deepseek-ai/.+`，因为运行时图由 cordis 组合解析，而非静态导入。

## Consequences

- Stage 6 退出标准达成：SPEC 列出的全部表面均在与 DSH 语义零改动的前提下、于桌面传输链路上的固定版 UI 中证明完毕；唯一未经自动化证明的表面是原生目录对话框的点击（手工冒烟）。
- 固定版客户端树在 stage 6 **零**改动；stage 4 集合（M1–M3）仍是唯一分歧。
- 对等性套件兼作构建产物冒烟（它跑的就是 `dist/` 输出加运行时与打包 node），并为整条旅程守住控制台门槛。
- 完整桌面端套件：125/125（114 基线 + 11 对等）。
- 两条待上报上游的 DSH 发现：投影缓存冷启动标题陈旧（打开会话后自愈）与冷启动 inspect 同步竞态。
- `DEEPSEEK_BASE_URL` 脚本化 provider 接缝成为桌面端面向 provider 行为的常设无 key 证明载体；真实 API 验证仍归 web 线 e2e。

## Alternatives considered

- 对等性运行用真实 API provider —— 否决：不确定、依赖网络、需要 key；web 线自己的无 key e2e 已使用 `DEEPSEEK_BASE_URL` 接缝，且保留了固定版 DeepSeek provider 的真实线路路径。
- 以原生自动化驱动 OS 对话框（AppleScript/robotjs）—— 否决：在可移植套件中平台特定且易碎；该对话框是薄 Electron `showOpenDialog` 封装，唯一未证明的步骤只是用户最后的点击。
- 桌面端修复陈旧列表标题（重取或客户端补丁）—— 否决：DSH 所有会话列表与投影缓存；仅载体规则禁止桌面端替代实现，修复的正确归属是 DSH。
- 在重启测试关闭前强制一次投影缓存检查点（例如重命名后多跑一轮）—— 否决：会掩盖真实的 DSH 冷启动行为，并改变被测的用户旅程。
- 每个表面一个独立配置档（隔离测试）—— 否决：单配置档按顺序走完整旅程是对正常用户工作流更贴近的近似，且重启测试需要前面测试建立的状态。
