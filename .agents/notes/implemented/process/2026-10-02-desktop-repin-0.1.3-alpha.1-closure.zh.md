# Agent Note：固定到 dsh-v0.1.3-alpha.1 —— 收尾报告

Status: implemented

[English](2026-10-02-desktop-repin-0.1.3-alpha.1-closure.md) | 中文

## 问题

桌面 fork 此前固定在 `dsh-v0.1.1-rc.2`（`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，2026-08-22），而上游发布线已前进到 `dsh-v0.1.3-alpha.1`：会话格式迁到 v2，客户端树迁到 Lexical 编辑器与回合进程渲染，连接/模块注册表迁到凭据接线、可选 webserver 的形态。fork 的固定源增量、持久化期望套件与打包假设都必须随新 SHA 一并移动，而这次 re-pin 需要一份收尾记录，把固定版本、增量核算、证据与已知限制捆在一起，之后分支才能并入 master。

## 决定

fork 重新固定到 `d347e703908d0406b7a7ef80e3a0e594d86b2215`（发布标签 `dsh-v0.1.3-alpha.1`；标签的 commit 即固定 SHA，已用 `git ls-remote` 核实）。上游契约程序在 `UPSTREAM.md` 变更前完整走完：上游变更检视、针对冻结候选的契约再验证、针对新 SHA 的完整权威套件（含真实 A→B 跨制品迁移门），以及流程测试。收尾额外跑了仓库完整测试通道、CI 形态的 E2E 通道、干净安装的打包流水线、四平台 CI 桌面矩阵，以及从新固定点出发的第 12 阶段上游观察，并敲定了最终 M/U 账目。re-pin 分支 `upstream-repin-0.1.3-alpha.1` 保留历史地并入 master。

## 固定版本与工具链

| 项目 | 前一固定 | 新固定 |
| --- | --- | --- |
| 上游 SHA | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | `d347e703908d0406b7a7ef80e3a0e594d86b2215` |
| 发布标签 | `dsh-v0.1.1-rc.2`（2026-08-22） | `dsh-v0.1.3-alpha.1`（2026-10-03 固定） |
| 根包 | `@deepseek-ai/dsh-root@0.1.1-rc.2` | `@deepseek-ai/dsh-root@0.1.3-alpha.1` |
| Node 引擎 | `^22.19.0 \|\| >=24.0.0` | 不变 |
| 验证用 Node / pnpm | `v22.23.2` / `pnpm@11.7.0` | 不变 |

## 增量核算（M/U）

针对冻结候选，整个 rc.2 补丁集逐文件复审；完整账目在上游契约的桌面扩展面一节。保留并原样重放：U1（投影缓存写入顺序）、U2（存储关闭延迟）、U3（inspect 清单就绪）。替换：rc.2 M2（候选的连接行已接线 `credentials`，补丁文本随之改变，BrowserAuth 行改为条件注册）。重新归类：rc.2 M1 变为 U4（无 Web 服务面加上 boot-graph 载体消费的公开 `fetchBundle(request)`；上游 master 此后已吸收同一面）。原样保留：M3（无 webserver 时的空操作通道 disposer）。新增：U5（原生打开器能力缝）、M4–M5（fork CI 桌面作业及其 spec 验证）、U6（后上游回移，带移除条件）。没有任何 rc.2 补丁被丢弃。

## 候选版本架构变更

- 会话格式为 v2：v0/v1 通过相邻迁移保持可读，v2 日志没有 `assistant/chunk` 记录（每块模型可见文本结算为一条 `assistant/message`），优雅取消以 `interrupted: true` 结算部分块，SIGKILL 则什么都不结算。
- 客户端树采用 Lexical 编辑器与回合进程渲染：视口外行带 `hidden="until-found"`，不计入 `innerText`，但保留在行的 `textContent` 中——重写的持久化期望探针按 `[data-chat-flow-key]` 行选择。
- 连接行接线 `credentials`；BrowserAuth 行、`/api` 路由与 WebSocket 下行只在各自服务存在时注册，而进程内 RPC 分发保持无条件。
- ClientModuleRegistry 无 Web 服务面（条件载体注册加公开 `fetchBundle`）已在上游落地，这正是 rc.2 M1 能重归类为上游通用 U4 的原因。
- 候选的插件解析图为 78 条边，打包流水线的解析冒烟在自带 Node 下全部解析成功。

## 原生、bundle 与会话适配

- 原生：六个依赖原生的包清单中 `koffi` 由 `^3.1.0` 固定到 `3.1.1`（3.1.1 预编译是对自带 Node 目标经 ABI 验证的版本），闭包暂存针对自带 Node v22.23.2 重建 ABI 脆弱原生包；原生模块冒烟与 78/78 边解析冒烟都在制品自己的 Node 下运行。
- bundle：fork 的 cordis agent 预设内容迁移到 alpha.1 工具词汇表，并移除两个 rescope 前散文记号，使 `rescope-vendor:check` 在新固定点通过；生成的 Cordis 目录工件针对冻结候选重新生成（re-pin 当时把它们留成了陈旧状态），这还要求在 `scripts/gen-cordis-catalog.ts` 中归类 `fetchBundle` 签名的 `Request`/`Response`；boot-graph 载体提供完全相同的 `fetchBundle` 字节。
- 会话：持久化格式为 v2，带 v0/v1 相邻迁移，下文的 A→B 门在两个真实构建的发布之间验证这些迁移。

## 真实 A→B 跨制品迁移

`session-migration.spec.ts`（3/3 绿）驱动两个真实发布制品：发布 A（`dsh-v0.1.1-rc.2`，构建于 `4327dc33`）创建真实的 v0 配置，发布 B（本树）在重新打开时迁移 v0→v1→v2，恢复会话 `cwd`，并通过渲染出的"在文件夹中显示"入口驱动生产原生打开器缝（`shell.openPath`）。该门是已发布 v0 会话数据在本次 re-pin 中存活下去的常设证明。

## 证据

| 门 | 证据 |
| --- | --- |
| 完整测试通道（本地） | 1,113 文件 / 18,675 测试：18,557 通过、118 跳过，exit 0（宿主 Node v22.23.2，无 shim 的 PATH） |
| 桌面 Layer C/D | 25 文件 / 229 测试绿，含按 v2 持久语义重写的正确性（5）与崩溃恢复（9）套件 |
| E2E，CI 形态 | `DSH_EXAMPLE_MODE=lib DSH_E2E_MAX_WORKERS=4`：137 通过、73 无密钥跳过，exit 0 |
| A→B 迁移 | 3/3 绿（见上一节） |
| 打包流水线，干净安装 | exit 0：构建、带 ABI 重建的闭包暂存、打包、fuses、ad-hoc 签名、启动冒烟（`dshVersion 0.1.3-alpha.1`）、解析 78/78、原生模块冒烟、打包应用冒烟 |
| 四平台 CI 桌面矩阵 | 运行 `37057856641`（head `91489b15`）：四个桌面作业全部成功，含 `desktop / windows package + D4 containment`；darwin-arm64 zip SHA256 `ad3758dc778a9932e3085a33c913fe2de2fb0ff76186094868aa583b12424cc7` |
| 类型检查 / 文档 / vendor | `pnpm run typecheck`、`pnpm run test:docs`、`pnpm run rescope-vendor:check` 均通过 |

## 已知抖动与已归类失败

- `user-patches.spec.ts` 的"通过事务性 HMR 观察添加、失败、恢复与移除"——负载相关（完整通道 fork 负载下首个 chokidar 事件有 10 s `eventually` 时限）；rc.2 时代测试，其机制未被 re-pin 改变；隔离与部分负载下 8/8 绿。
- spill-local 启动清理边界抖动——浮点秒 `utimes` 伪影，已由 U6 回移（上游 `228f3aef83`）修复。
- python 运行时环境泄漏断言——宿主机 pyenv shim 会向 python 子进程重新注入 `PATH`/`PYENV_*`；属宿主环境归类，无 shim 的 PATH 下绿（250 通过、2 跳过）。
- `web-agent-presets.e2e.ts` 向真实 `~/.dsh/sessions/_no-cwd` 写固定名会话（设计上未固定，rc.2 时代）；本地运行需要清理残留，CI runner 是全新环境。
- 运行 `37057856641` 中的 `python runtime / release-shaped matrix / node24-win-x64`——digest 不匹配，前一运行 `37047907732` 中绿；收尾时唯一允许的 rerun 仍被七个排队的企业池作业阻塞，记为基础设施限制而非产品失败。
- `Issue lifecycle` 与 `Issue policy` CI 作业保持红，因为 fork 未设置 `DSH_ISSUE_APP_CLIENT_ID`——既有的 fork 基础设施缺口，不是固定点缺陷。

## 环境与基础设施限制

- 开发机导出 `CC=/opt/homebrew/bin/gcc-13` / `CXX=/opt/homebrew/bin/g++-13`，其二进制缺失并破坏 node-gyp 风味探测；re-pin 中每次原生构建都用 `CC=/usr/bin/cc CXX=/usr/bin/c++` 运行。
- 宿主机的 pyenv shim 会向 python 子进程重新注入环境，因此 python 运行时测试在无 shim 的 `PATH` 下运行。
- 开发机未接受 Xcode 许可（`sudo xcodebuild -license`），而 `fs-ext` 原生构建需要它——第 11 阶段干净安装记录中记载的宿主前提，在 CI runner 上已满足。
- 企业 runner 池在收尾前把运行 `37057856641` 的七个作业排在队列里，阻塞了唯一允许的 node24-win-x64 rerun。
- 2026-10-02 的 GitHub 控制面禁用事件有独立记录，它让桌面矩阵在一次性重新启用前损失了一个运行。

## D4 义务

D4（自带独立 Node 的 ABI 兼容加 Windows 进程包含）在四条按平台通道上均经 CI 验证：闭包暂存宿主特定的原生预编译，各平台启动冒烟在制品自己的 Node 下以打包形态启动 DSH，Windows 通道运行 Win32 ABI 探针并对交付内核执行一次真实四参 `SetInformationJobObject`。产品 Job 的 `KILL_ON_JOB_CLOSE` 端到端杀进程演练仍是明确的 final-v1 验证义务：实现已完成，但因外部阻塞无法行为验证——每个可达的 Windows 启动上下文（GitHub runner 与本地 Windows 11 虚拟机的自动化进程树都一样）都已是外部持有 Job Object 的成员；外部包含回退及其响亮的 `SKIP (externally contained)` 标记是常设证据，证明被 Job 包含的宿主启动健康、且绝不会被误报为已验证。

## 签名与公证

签名按凭据门控，`package-report.json` 逐步报告"已配置 vs 已执行"：CI 通道在 macOS 上 ad-hoc 签名（构建机上可启动，不可分发）、Windows 不带签名发布、Linux 不签名；缺凭据时 Developer ID / 公证 / Windows 证书路径为已配置未执行。真实签名只发生在发布工作流的凭据路径；re-pin 通道刻意停留在 ad-hoc/无签名形态，报告明确区分这一点。

## src 模式 E2E 持久化丢失

非 CI 的 src 模式 E2E 驱动（tsx 加载器加已设置的 `TSX_TSCONFIG_PATH`，即默认 `src` 示例模式）以 0 退出，却不生成 `.sessions`。该丢失在同样构建状态的未动冻结候选上同样复现：同一 time-context 驱动与夹具在该形态下不创建会话文件，而同一启动去掉 `TSX_TSCONFIG_PATH`——CI 权威形态 `DSH_EXAMPLE_MODE=lib`——写出 `session.v2.jsonl`。归因是冻结候选自身的行为（混合源/lib 模块图，JSONL 持久化插件从未被构造），既非 fork 增量也非环境条件；按收尾决定，fork 不修候选独有且非权威的 src 模式行为，该事实记录在上游契约的收尾记录中。

## 当前上游观察

第 12 阶段观察于 2026-10-03 从新固定点运行：上游 master 为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，领先固定点 5,526 个 commit，固定点之后无更新发布标签，固定 SHA 在 master 上可达。桌面增量无法干净应用到当前 master（上游改动了增量触及的文件），故记录状态为 `upstream-needs-adaptation`——在此漂移量下属预期。按收尾决定，观察只记录 SHA、漂移与结论；未对当前上游做任何适配。

## 已考虑的替代方案

- **停留在 `dsh-v0.1.1-rc.2`。** 落选原因：alpha.1 是当前发布线，携带 v2 会话格式与 fork 持久化期望必须跟踪的客户端组合；停留会把 fork 钉在已被取代的会话格式上，且漂移越大同样的工作越难做。
- **固定到上游 master 而非带标签的发布。** 落选原因：契约程序优先选发布标签，而 master 在固定与收尾之间前进了 5,526 个 commit——这正是 master 固定会在两次观察之间静默吸收的漂移。
- **在 fork 中修 src 模式持久化丢失。** 落选原因：该丢失在未动候选上复现，且只出现在非权威 src 形态，而 CI 权威 lib 形态是绿的；把候选行为分叉出去只会增加没有产品信号的增量。

## 后果

代价：多日验证通道（完整测试通道、CI 形态 E2E、干净安装打包流水线、四平台 CI 矩阵），两次 CI 基础设施事件（2026-10-02 控制面禁用，以及仍未决的 node24-win-x64 rerun），以及针对 `CC`/`CXX`、pyenv shim 与未接受的 Xcode 许可的显式宿主前提覆盖。收益：带完整证据矩阵的前移固定点，带明确移除条件的 M/U 账目（U4 在固定点带上游无 Web 服务面后移除；U6 在固定点带上 `228f3aef83` 后移除），来自两个真实发布制品的跨发布迁移证明，四平台上经 ABI 验证的原生闭包，以及从新固定点运行的观察轨道。

## 相关

- [fork 上无法解释的手动 workflow 禁用（CI、Landlock Run）](2026-10-02-fork-ci-workflow-disable-investigation.zh.md)
- [打包收尾重建 ABI 脆弱原生包](2026-10-02-desktop-packaging-native-abi-rebuild.zh.md)
- [打包冒烟契约](2026-10-02-desktop-packaging-smoke-contracts.zh.md)
- [发布族排除私有桌面应用](2026-10-02-release-family-excludes-private-apps.zh.md)
- [第 11 阶段打包：可复现自足发布单元](../architecture/2026-08-29-desktop-stage11-packaging.zh.md)
- [第 11 阶段干净安装前提](../architecture/2026-09-22-desktop-stage11-packaging-clean-install-prerequisite.zh.md)
- [UPSTREAM.md](../../../../UPSTREAM.md) 与[上游契约](../../../../apps/desktop/docs/upstream-contract.md)
