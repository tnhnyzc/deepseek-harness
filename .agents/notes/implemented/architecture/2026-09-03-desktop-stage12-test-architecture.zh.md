# Agent Note:桌面第 12 阶段 —— 四层测试架构、规范化与打包 E2E、迁移与上游观察安全网

状态:已实现

[English](2026-09-03-desktop-stage12-test-architecture.md) | 中文

## 问题

第 1–11 阶段交付了一个可运行、已加固、自包含、按平台打包的 Electron 应用。但它的测试资产是围绕*开发面与逐阶段证明*组织的,而不是面向发布的一条**常设回归安全网**。在下一次发布之前——以及在专门的上游重新钉扎(re-pin)之前——桌面端缺少五项尚未作为一等、可维护基础设施存在的要素:一个**能把失败定位到其所属层级的分层**(单元测试 / 真实 DSH 运行时 / 桌面集成 / 端到端);一个**规范化的全新配置文件用户旅程**,作为"真实用户流程是否可用"的单一判据测试;**证明打包/可分发单元确实能跑通工作流**(而非只有开发构建);跨发布升级时对用户持久化数据的**迁移安全**;以及一种**安全、非阻塞地观察上游漂移**的方式,既不改钉扎也不破坏发布。必需的 CI 车道还必须**大声失败**,而不是把自己本应运行却缺前置条件的测试自我跳过。第 12 阶段(SPEC §29–30;§31 的边界测试已存在)就是这条测试架构线。

## 决策

**四个层级,各自把失败定位到其所属层;每个层级在缺环境前置条件时自我跳过,在必需车道上大声失败。****A —— 单元测试**是既有的无密钥包/单元测试套件(未改动)。**B —— 无 Electron 的真实 DSH 运行时**是新增:`apps/desktop-runtime/tests/runtime-journey.spec.ts` 在钉扎的 DSH 下(带 `DSH_DESKTOP=1` 宿主面、无 web-server 回退)启动已构建的 `dist/index.js`,并通过*桌面 broker 所用的同一套 fork-IPC 传输*端到端驱动一次正常用户回合——在 fresh cwd 上 `session.create` → `session.prompt` → 流浮现到活动事件 mux(从 `stream.frame` 重新拼装出的 SSE 字节)→ 回合中途 `session.cancel`(末块绝不得到达;回合以 `running:false` 收尾)→ `session.history` 重放 → 干净的 `runtime.shutdown`(exit 0)。若 agent 循环、事件日志、流载体或持久化损坏,B 会在没有窗口的情况下失败,从而把失败定位到运行时层。**C —— 桌面集成**是既有的"真实渲染进程走载体"套件(`dsh-parity`、`dsh-event-correctness`、`dsh-crash-recovery`、`desktop-ux`、`desktop-clipboard-security`),保持不动。**D —— 端到端**是规范化的全新配置旅程加上打包旅程(见下)。

**共享支持模块终结了各套件的 provider 重复。** 在第 12 阶段之前,确定性模型与 UI 基元在每个桌面套件里被重复内联。`apps/desktop/tests/support/deterministic-provider.ts` 现在是唯一的脚本化回环模型(一个回合是 `text`/`tool`/`text-tool`/`fail` 步骤列表,按 prompt 文本里的标记加工具结果计数路由,临时 `127.0.0.1` 端口,并以一个中性标题应答 `max_tokens === 64` 的自动标题调用,使其不占用任何回合)。`apps/desktop/tests/support/electron-world.ts` 是唯一的 UI + 持久化基元集合,各套件用它驱动*真实*渲染进程:传输 `rpc`(走产品自带的 `__DSH_TRANSPORT__` fetch 载体,从不用后门)、composer/sidebar/menu/首次运行/访问模式这些控件、version-2 的 `seedWorkspaceRegistry`、多帧 zstd 会话日志解码器、以及持久标题轮询。B 跨包引入 provider 与跳过助手(与其既有的跨包 provider 引入一致);C 与 D 引入 world。没有任何可运行的套件因美观被重写;共享模块只是删除了重复。

**规范化用户旅程(D)是全新配置且由选择器驱动的。** `apps/desktop/tests/dsh-user-journey.spec.ts` 从一个**空**的 `DSH_HOME` 开始(无种子注册表),通过**真实原生选择器路径**添加第一个工作区(`File ▸ Open Workspace…` 菜单项,其中 `dialog.showOpenDialog` 接缝只替代 OS 点击这一动作——DSH 选择器座位、原生通道、主进程能力全部保持真实),随后对钉扎的 DSH 跑完整旅程:增量流(部分文本必须在最终文本*之前*绘制)、bash 工具在会话*与*轨迹里渲染并在磁盘上核对其世界状态、一次审批(切到 Read Only → Allow once → 升级后的命令执行)、一个 ask-user 问题(单选 + Submit)、运行中回合的 `Stop generating`、一个持久化 `user` 来源标题的重命名、设置/模型界面,以及一次**干净退出 + 重启后恢复会话**——冷列表上的投影标题与重放后的工具/审批/问题回合。它是单一的"真实用户流程是否可用"判据测试;逐阶段的 C 套件保留其聚焦覆盖。

**打包旅程(D)通过 CDP 驱动发布二进制,因为融合后的二进制没有 Node 检查器。** `apps/desktop/tests/packaged-user-journey.spec.ts` 把发布归档**解压到仓库之外**的临时位置,用 `--remote-debugging-port=0`(端口从二进制自身 stderr 读出)和受限 `PATH` 启动解压出的二进制,并用 Playwright `chromium.connectOverCDP` 附加——**不是** `_electron.launch`,后者会在 `EnableNodeCliInspectArguments` 融合关闭的二进制上于握手处挂起(正是逼出 smoke 的 CDP 接缝的同一事实)。它证明了开发旅程无法覆盖的发布单元关切:`app.isPackaged === true`;运行时在**捆绑** Node 下 `ready`,版本为工件的**钉扎** DSH 版本;一个基本流 + 工具工作流及其世界状态;一次**走应用自身退出路径的干净退出 + 重启后会话恢复**(smoke 只做过 SIGKILL);以及归档对其 sidecar 的 `sha256` 有效且可重复解压。`isPackaged` 与运行时事实来自带环境变量门控、只读的 `DSH_DESKTOP_SMOKE` 报告通道——与按平台 CI smoke 所用的同一接缝,无该标志时无效——而工作流本身是纯 UI(composer、传输、持久日志)。

**按平台的打包 smoke 增加了一个显式的"无 node"证明。** `apps/desktop/scripts/smoke-packaged-app.ts` 现在在启动前断言:它运行应用所用的那个受限 `PATH` **不解析** `node`/`npm`/`pnpm`/`dsh` 中的任何一个(每个都在该 `PATH` 下派生的子进程里探测),于是"打包运行时跑的是捆绑 Node"成了一个被执行的既成事实,而不是从"应用启动了"推出的推断。

**必需车道大声失败;本地与无头跳过保持干净。** 共享的 `e2eRequired`/`skipUnless`(在 `electron-world.ts`;跨包的 B 规范里内联,而 B 本就引入共享支持)实现了该语义:当 CI 车道设置 `DSH_DESKTOP_E2E_REQUIRED=1` 时,一个缺失的前置条件(无 GUI、无已构建运行时、无已构建归档)是 `beforeAll` 里的硬**失败**,从不是跳过;无该标志时套件自我跳过。这补上了那个"空转通过"的洞——一个配置错误的必需车道(例如没有 `DISPLAY` 的 Linux 车道)会静默跳过它本应运行的测试并报绿。

**迁移安全是一个可复用 harness,配一个诚实的预发布替代。** `apps/desktop/tests/support/migration.ts` + `migration.spec.ts`:`createMigrationFixture` 通过当前应用生成一个真实的配置文件(一个种子工作区、一个流回合、一个写文件的工具回合、以及一个用户设置的持久标题),`verifyMigratedData` 在该配置上启动一个**全新**实例,并断言工作区被列出、会话存活、其持久标题在冷列表上、首次运行确认已持久、以及重开会放已记录的内容。因为**尚不存在任何已发布的先前行版本工件**,阶段 A 是对一个真实先前行版本数据的同格式替代;harness 的 `verifyMigratedData(userData, …)` 正是真正的跨工件 A→B 检查在先前行版本发布后将要运行的东西——把它指向那个行版本的用户数据目录即可。现在证明的不变量,正是未来 A→B 必须保持的那条:当前行版本的持久化数据,在其自身的一个全新实例下保持完好。

**上游观察轨道是一个安全、非权威的漂移探针,外加一份就绪报告。** `scripts/upstream-observation.ts` + `.github/workflows/upstream-observation.yml`(仅按计划每周 + 手动触发——从不在 `pull_request` 或 `push` 上;`contents: read`)把上游 `master` 拉取到 `FETCH_HEAD`,报告漂移(领先钉扎的提交数、钉扎可达性、更新的发布标签、变更的顶层路径),并把桌面 delta(钉扎 → fork 头)在**一个用完即删的临时 worktree** 里跑过 `git apply --check`。它报告 `upstream-compatible` / `upstream-needs-adaptation` / `upstream-unchanged`,并且**永远 exit 0**(发现是报告,不是构建失败);它从不合并、从不写标签、从不改 `UPSTREAM.md` 里的钉扎 SHA。报告附带 SPEC §30 的六步重钉清单。当前观察结果是 **`upstream-needs-adaptation`**:上游自钉扎起已推进 1834 个提交,且改动了桌面 delta 触碰的文件,故 delta 无法干净应用——这正是"盲目重钉尚未就绪"这一信号。

## 本阶段确定的事实

- 融合后的发布二进制没有 Node 检查器,但接受 `--remote-debugging-port=0`;Playwright `chromium.connectOverCDP` 对着该端点是可用的驱动接缝,而 `_electron.launch`(它会加 `--inspect`)会在握手处挂起。应用窗口是 CDP 列表里的 `dsh-app://` page 目标。
- 渲染进程在**开发与打包下都**从 `dsh-app://` 服务,故页面来源无法区分二者;`app.isPackaged` 与运行时事实只能通过带环境变量门控的 `DSH_DESKTOP_SMOKE` 报告通道读取(CI smoke 的接缝,无该标志时无效)。
- 一个全新的 DSH_HOME 没有工作区,在添加一个之前 composer 不可编辑;故规范化旅程*必须*驱动选择器(种子注册表路径是 parity/smoke 的替代,而非规范路径)。
- 默认会话访问模式不审批即运行 `bash`;审批路径由切到 Read Only 触发(规范化审批测试正是这么做)。
- 运行时子进程以 `DSH_DESKTOP=1`、`DSH_HOME` 以及无密钥的 `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`(回环 provider)fork;事件 mux 打开在同一套 fork-IPC 传输上,`stream.frame`/`stream.end`/`stream.error` 被路由到一个 sink,以免与 FIFO 上的 fetch 控制消息竞争。
- `git worktree add` 会向 stderr 打印逐文件检出进度;对它的 `execFileSync` 需要一个宽裕的 `maxBuffer`,否则会在探针运行前死于 `ENOBUFS`。
- `git apply --check` 把每个失败文件报告为 `error: patch failed: <path>:<line>`;报告逐字捕获这些行,而不是解析成一个脆弱的列表。
- 可分发归档是 `DeepSeek Harness Desktop-<version>-<platform>-<arch>.zip|.tar.gz`,带一个 `sha256sum` 格式(`<hex>  <name>`)的 `.sha256` sidecar;打包旅程同时校验摘要与第二次独立解压。
- 桌面 delta 是 45 个提交(钉扎 → fork 头),触碰 `apps/desktop`、`apps/desktop-runtime`、`.agents/notes` 以及若干 delta 也改动的上游 `packages/`——正因如此,在一个已推进 1834 个提交的 master 上它无法干净应用。

## 后果

- 第 12 阶段退出标准达成,**且钉扎源零改动**:钉扎的 DSH 仍为 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`(`dsh-v0.1.1-rc.2`)。新增:`apps/desktop-runtime/tests/runtime-journey.spec.ts`、`apps/desktop/tests/dsh-user-journey.spec.ts`、`apps/desktop/tests/packaged-user-journey.spec.ts`、`apps/desktop/tests/migration.spec.ts`、`apps/desktop/tests/support/{deterministic-provider,electron-world,migration}.ts`、`scripts/upstream-observation.ts`、`.github/workflows/upstream-observation.yml`;扩展:`apps/desktop/scripts/smoke-packaged-app.ts`(无 node 证明)。
- 四个层级是常设的回归安全网:A(无密钥单元)→ B(真实运行时,无 Electron)→ C(真实渲染进程走载体)→ D(规范化全新配置 + 打包发布二进制旅程)。必需车道以 `DSH_DESKTOP_E2E_REQUIRED=1` 运行它们;那里的前置条件损坏是一次大声失败。
- 打包旅程与扩展后的 smoke 合起来证明了*发布单元*(解压归档、`app.isPackaged`、捆绑 Node、工作流、干净退出 + 重开、校验和),与拥有快速启动/安全/载体/崩溃证明的按平台 CI smoke 互补。
- 原样向前携带:产品自有的 D4 `KILL_ON_JOB_CLOSE` 端到端 kill 演练**实现完成但未行为验证**(所有可用 Windows 启动上下文都已被外部作业容器化)——一项显式的 final-v1 验证义务;四个上游自托管 CI 检查在 fork 上仍不可用(基础设施,而非产品);在无凭据处签名/notarization 仍为"已配置未执行"。
- 观察轨道是常设的、非阻塞的上游漂移监视器;其当前裁决为 `upstream-needs-adaptation`。**第 12 阶段未执行任何重钉**——专门的重钉(选定 SHA、适配、重跑权威套件、手动测试、然后改 `UPSTREAM.md`)是下一个任务,且必须跑它自己的完整验证。

## 曾考虑的替代

- 用 Playwright `_electron.launch` 驱动打包旅程——否决:它需要融合故意移除的 Node 检查器;对着浏览器 DevTools 端点的 `connectOverCDP` 才是外部观察者实际拥有的接缝。
- 在观察轨道里做完整的跨合并 rebase 探针——否决(面向常设车道):把一个 45 提交 delta rebase 到一个已移动 1834 提交的 master 又重又脆,而且一个坏掉的观察绝不能读成一个坏掉的发布;有界的 `git apply --check` 给出一个安全、真实的兼容性信号,就绪报告则携带了重钉流程,供它被有意执行时使用。
- 种子规范化旅程的工作区注册表,而非驱动选择器——否决:全新配置 + 真实选择器路径正是真实的"首次运行"用户流程,也是规范化测试的全部意义;种子是 parity/smoke 的替代。
- 对着真实先前行版本做真正的跨工件 A→B 迁移测试——预发布下不可能(无先行工件);诚实的替代 + 可复用 harness 是正确的预发布状态,harness 已就绪,待先前行版本发布后即可指向其真实配置文件。
- 把观察工作流做成必需的 PR 检查——否决(SPEC §30):观察按设计非权威;权威发布轨道是对钉扎 SHA 的 `ci.yml`。
