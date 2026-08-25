# Agent Note：桌面端 stage 7 —— 桌面 UX：窗口尺寸、原生菜单、封闭命令桥

Status: implemented

[English](2026-08-25-desktop-stage7-ux.md) | 中文

## Problem

Stage 7（SPEC §16）要在 stage 6 的功能对等之上加入桌面端专属价值：按桌面尺寸调整的 native 窗口、带平台惯例键盘快捷键的 native 应用菜单，以及驱动 Harness 的菜单动作。约束是严格的：DSH 保持对全部 agent 语义的唯一所有权（桌面端仅为载体），SPEC 要求影响 Harness 状态的动作"应派发到既有 DSH 客户端服务，而非另一个 main 进程 API"，固定版客户端树不得改动，且测试环境没有 API key。

## Decision

**窗口尺寸。** `apps/desktop/src/main/window.ts` 以 `useContentSize` 创建窗口，内容矩形 1280×800，最小内容 1024×600：平台外观（标准边框、macOS 红绿灯）留给 Electron，DSH 内容边缘到边缘填满内容矩形。shell CSS 曾在固定版客户端框架四周留下非通铺空隙，已在 `apps/desktop/src/renderer/styles.css` 修复。

**原生菜单。** `apps/desktop/src/main/menu.ts` 把 SPEC §16 的菜单构建为纯模板函数 `buildApplicationMenuTemplate(ApplicationMenuOptions)` —— shell 提供应用名、平台标志、devTools 可用性、命令出口与 about 动作，因此模板可用记录器单测而不需要 Electron 应用 —— 并以 `installApplicationMenu` 安装（同时设置 about 面板身份：`DeepSeek Harness Desktop` 与应用版本）。表面：macOS 应用菜单（About、Settings… `CmdOrCtrl+,`、Services、Hide/Hide Others/Show All、Quit）；File（New Session `CmdOrCtrl+N`、Open Workspace… `CmdOrCtrl+O`、Close Window）；标准 `editMenu` 角色；View（Toggle Sidebar `CmdOrCtrl+\`、Zoom In / Zoom Out / Reset Zoom 角色、仅在应用未打包运行时提供 Developer Tools）；Session（New Session、Cancel Current Run、Rename Session）；macOS Window 角色；Help（文档与运行日志两项禁用并带 tooltip —— 本 fork 尚无已发布文档，运行日志在诊断阶段前留在内存；非 macOS 的 About → `app.showAboutPanel()`）。没有 Cmd/Ctrl+K（固定版客户端没有命令面板）、没有 OS 全局快捷键、没有 Escape 绑定（Escape 保持固定版 UI 自身语义）。

**封闭命令桥。** 菜单恰好表达六个意图 —— `new-session`、`open-workspace`、`cancel-run`、`rename-session`、`open-settings`、`toggle-sidebar` —— 封闭词表位于 `apps/desktop/src/shared/desktop-command.ts`（通道 `dsh-desktop:command`，守卫 `isDesktopCommand`）。命名故意采用 kebab-case UX 意图名：SPEC §31 边界扫描要求桌面传输层不含点分业务 RPC 字面量，取一个 RPC 方法样名的命令即是该腐化本身。菜单点击由 main 向应用窗口的主框架发送一个词表成员，绝不广播。preload（`src/preload/index.cjs`）暴露 `window.dshDesktop.onDesktopCommand`，在载荷到达页面前重新应用守卫：强制点是页面边界，而非 main 的意图。渲染器适配器（`src/renderer/desktop-commands.ts`，由 `src/renderer/main.ts` 安装）把每个意图翻译成既有的固定版 DSH 客户端动作 —— 与用户会点击的同一组 DOM 手势 —— 别无其他：

- `new-session` → "New session" 按钮；`open-workspace` → "Add workspace" 按钮（add-only 选择器消费打开并直接拉起组合的目录流，随后驱动 `host.pickDirectory` 进入原生对话框）；`cancel-run` → 输入器的 "Stop generating"；`rename-session` → 选中行的操作菜单、第一项（固定版源码的固定项序：rename、fork、archive）；`open-settings` → 侧边栏的设置触发器（侧边栏列中唯一 `aria-haspopup="dialog"` 的按钮）；`toggle-sidebar` → 侧边栏折叠按钮。
- 产品文案按活动语言涂绘（zh 或 en），因此每个手势匹配两个已发布语言的封闭标签集合，而非单一语言的字符串。
- 当 shell 屏幕在位（无活动客户端树）以及树无法动作的状态（无选中行、无生成中、无可渲染的可供性）下，命令是确定性空操作：菜单在任何状态都保持安全，而非由页面猜。

没有新增 wire 方法，main 从不变更 Harness 状态，固定版树保持零改动 —— M1–M3 仍是本地修改的完整集合。

**本阶段修复的载体缺陷。**（1）桌面端组合覆盖层（`apps/desktop-runtime/src/composition.ts`）原先只插入原生目录选择器的*宿主*行；组合后的 boot 图还需要 `@deepseek-ai/dsh-client-ui-directory-picker-native` 的*客户端*行，缺了它 "Add workspace" 可供性永远不会拉起原生流（探针证明缺失：`addWorkspace:false`）。覆盖层现在插入两行，`apps/desktop-runtime` 把该 surface 包声明为 workspace 依赖。（2）构建顺序：`apps/desktop-runtime/tsdown.config.ts` 打包的是 `lib/types/*.js` 条目 —— 是 **tsc 产物，不是源码** —— 因此单独跑 tsdown 会静默打包陈旧产物。运行时按 `tsc -b`（产出 `lib/types`）然后 tsdown 的顺序构建；根目录 `pnpm run typecheck` 完成该产物步骤。

**测试。** `apps/desktop/tests/menu.spec.ts`（11）：双平台模板结构、加速器注册加无-Esc 绑定、devTools 门控、File/Session 项序、Help 禁位占位加非-mac About 点击、每个命令的精确命令派发序列、词表封闭性、`isDesktopCommand` 接受/拒绝、preload 词表镜像锁步（对 `index.cjs` 中镜像集合的正则）、以及 `src/main` + `src/shared` 的 IPC 通道盘点扫描（对照已知封闭通道集，断言非空）。`apps/desktop/tests/desktop-ux.spec.ts`（10）：构建产物 E2E（缺产物时自我跳过、`DEEPSEEK_BASE_URL` 接缝上的脚本化确定性 SSE provider、控制台门槛）：1280×800 内容尺寸加最小钳制；活动原生菜单表面加已注册加速器；词表外与对象型桥载荷被拒绝（无状态变化、无控制台错误）；经桥翻转侧边栏；File > New Session 创建真实 DSH 会话；File > Open Workspace… 驱动组合目录流进入 OS 对话框（main 中打补丁的 `dialog.showOpenDialog`：恰好一次调用且带 `openDirectory`、取消、未新增工作区）；Session > Cancel Current Run 取消流中轮次；Session > Rename Session 经重命名对话框持久重命名；平台新建会话加速器注册在活动菜单上；经应用菜单打开设置（macOS）/ 经 `showAboutPanel` 打开 About（其他平台）。

## Facts the stage settled

- **空白会话复用**（与 `dsh web` 共享的 DSH 语义）：`connectWorkspace`（`packages/client/runtime/src/client/workspaces/service.ts:89-111`）复用目标工作区既有的非归档空白会话（工作区成员关系加相同 cwd），`startSession`（`:177-192`）在无目标可解析时静默空转。因此从*空白*当前会话执行 "New session" 不会创建第二个会话 —— 它复用那个空白会话。菜单/E2E 消费者必须先以一轮把当前会话变为非空白，才能断言计数增加（stage 6 的对等测试能递增仅因其当前会话非空白）。
- **Electron 活动菜单**：`MenuItem.role` 以小写报告（`zoomin`、`zoomout`、`resetzoom`、`toggledevtools`），macOS 的 `resetZoom` 项标签为 "Actual Size" —— 断言角色，不要断言标签。`accelerator` 原样返回已注册的模板字符串。CDP 合成键盘输入（自动驱动仅有的输入）永远到不了 OS 层的加速器注册，因此按键本身留在手工冒烟，自动化证明的是注册与绑定命令经菜单项点击派发。
- **重命名对话框**：其输入框为 `aria-label="Session name"` / `会话名称`，确认按钮为 `Rename` / `重命名`；行操作菜单传送到 `document.body`，经文档级 Escape keydown 关闭。

## Consequences

- Stage 7 退出标准达成：桌面端专属价值（native 外观、带平台加速器的 native 菜单、菜单驱动的 UX 动作）就位，全部 Harness 语义留在固定版 DSH 客户端，固定版树零改动（M1–M3 仍是完整集合）。
- 完整桌面端套件：146（125 基线 + 11 菜单 + 10 桌面 UX）。
- 封闭命令词表是后续阶段的常设接缝：后续阶段新增的菜单可供性是一个词表成员加一个适配器手势加其测试，绝不是一条新 wire 路径。
- 桌面 UX 表面经 DOM 手势驱动固定版客户端：未来固定版客户端改标签或重排布局会打断适配器的标签集合，桌面 UX E2E 即其绊线。

## Alternatives considered

- main 进程 Harness 变更（菜单点击从 main 派发 Harness RPC）—— 否决：SPEC §16 要求派发到既有 DSH 客户端服务而非另一个 main 进程 API，且第二条写路径会绕过客户端的 UI 状态机。
- 为菜单动作新增 wire 方法 —— 否决：仅载体规则；每个所需语义已作为固定版客户端可供性存在，新方法会重复客户端的所有权。
- 渲染器 keydown 监听器实现快捷键 —— 否决：SPEC 要平台惯例行为，native 菜单的加速器正是如此；渲染器监听会双重绑定并与 UI 的 Escape 语义冲突。
- UX E2E 用真实 API provider —— 同 stage 6 否决：不确定且需要 key；`DEEPSEEK_BASE_URL` 脚本化接缝保留了 provider 的真实线路路径。
- 以 OS 级按键合成（AppleScript / robotjs）做加速器冒烟 —— 否决：在可移植套件中平台特定且易碎；加速器的命令派发已经由菜单项点击证明。
