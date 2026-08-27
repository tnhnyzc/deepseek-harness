# Agent Note：桌面端 stage 10 —— 安全加固：有界线缆、钉住的面、有出处的 CSP

Status: implemented

[English](2026-08-27-desktop-stage10-security.md) | 中文

## Problem

Stage 10（SPEC §24）是横跨 Electron 渲染器/preload/主进程/运行时各边界的一次专门安全加固。stage 1–9 的构建目标是"能用"，而且确实能用：沙箱化渲染器、私有 `dsh-app://` 协议、通用 fetch/stream 传输、封闭原生通道、受信 IPC 发送方校验。各阶段没有做的是威胁模型检视：信任边界有哪些、被攻陷的对端（遭 XSS 的渲染器标签页、客户端渲染的恶意文档、敌意运行时子进程）能在哪里迫使无界开销、以及每一个 Electron 面是靠显式选择钉住的还是靠 Electron 默认值撑着的。

## Decision

**全部加固都在桌面载体一侧；固定版源码差异原样未动。** M1–M3 与 U1–U3 仍是完整的修改集合。DSH 对沙箱、审批、工具、模型、凭据与会话保持权威；桌面层不添加第二套策略系统。

**威胁模型：六条边界。** A —— 不可信内容进入渲染器（CSP + 沙箱 + webSecurity 限定其影响面；固定版 React 树的渲染正确性属于固定版源码范畴）；B —— 渲染器 → preload → 主进程（封闭六方法桥；每条渲染器→主通道都有 `isTrustedIpcSender`；本阶段发现的主要缺口：preload 会装进**每一个** frame）；C —— 渲染器 → MessagePort → 哑代理 → 运行时（两端都过线门、64 KiB 帧界、credit 窗口；本阶段的缺口：元数据无界、并发操作数无界）；D —— 运行时 → 原生通道 → 主进程（封闭方法集、路径/诊断有界；缺口：请求 id 无界、响应路径无界）；E —— 主进程 → 操作系统（`shell.openExternal` 仅接受 http(s) 校验过的 URL；`path.open` 接收结构校验过的路径串，`shell.openPath` 绝不把它当 URL 解释）；F —— 运行时/DSH → 工作区/工具/子进程（DSH 自己的沙箱与审批；桌面端环境变量策划 —— 是白名单而非透传 —— 核验未变）。

**审计发现的每个缺口都是线缆信任界，不是新策略。**

- **传输元数据界**（`apps/desktop-runtime/src/transport.ts`）：`parseTransportMessage` —— 三个边共用的线缆边界 —— 现在对每个元数据字段强制字符界：id ≤512、url ≤8192、method ≤16、header 数 ≤256（名 ≤256 / 值 ≤8192）、status 0..999、status-text ≤256、错误码 ≤64、消息 ≤1024、原因 ≤256。这些值取自 Web/HTTP 规范（请求行与 header 缓冲区尺寸），远高于固定版客户端的真实流量（UUID id、短 API url），被攻陷的渲染器不再能用一帧廉价消息跨 IPC 迫使任意分配；越界字段是协议拒绝。
- **并发操作上限**（`apps/desktop-runtime/src/transport-runtime.ts`）：适配器的在途映射（fetches + streams）封顶于 `TRANSPORT_MAX_CONCURRENT_OPERATIONS = 128`。该上限是内存界而非吞吐界：一次 `stream.open` 在整个流存活期内都是一个活的进程内 carrier fetch，一个永不结束请求体的半开 `fetch.open` 也留在映射里 —— 无界映射会让对端无限持有 carrier 操作。超限的 open 按操作拒绝，使用新增的 `too-many-requests` 传输码（stream open 以无自身状态的 `stream.open.ack` 拒绝应答）；对端的在途操作照常运行到各自的终点。128 远高于客户端的常规并发（个位数 RPC 加两条事件流）。
- **原生通道界**（`apps/desktop-runtime/src/native.ts`）：四个解析器的请求 id 取 512 字符界；成功响应的选择器路径与请求路径走同一结构检查（非空、无 NUL、≤32768）。操作员取消形态（`path: null`）仍按原样解析 —— 该修复的第一稿丢掉了这个字段、破坏了 settle-into-null，被桥的往返测试抓住。
- **Electron 面钉住而非依赖默认值**（`apps/desktop/src/main/window.ts`、`security.ts`、`src/preload/index.cjs`）：BrowserWindow 现在显式携带 `webviewTag: false`（未来 Electron 默认值变化不能悄悄重新启用嵌入）与 `devTools: !app.isPackaged`（打包构建拒绝 DevTools API 本身，任何菜单项、快捷键或页面脚本都打不开）。会话**同时**安装权限请求处理器与权限检查处理器、一律拒绝 —— 请求处理器应答提示框，检查处理器覆盖 Electron 不提示直接咨询的路径。preload 只在主 frame 安装封闭桥（顶层 `window.top !== window.self` 守卫，先于 `electron` 的 require）；主进程的发送方校验仍独立拒绝子 frame IPC，两半都不是单线防御。
- **私有协议补上解码缺口**（`apps/desktop/src/main/protocol.ts`）：`decodePathname` 现在拒绝**解码后**形态里的 NUL 字节，而不仅是编码形态 —— `%00` 会解码成旧预检看不到的 NUL。穿越、host 与符号链接检查本已完整，现由测试重新钉住。
- **启动图发布在线缆处做界检**（`apps/desktop/src/main/runtime.ts`）：`parseBootGraphMessage`（现导出以便直接测试该边界）把越界的子进程发布整体丢弃 —— 脚本 ≤1 MiB、列表 ≤256 项、id/url ≤8192、修订号 ≤128 —— 该代只是报告没有启动构件。

**CSP 裁定：`unsafe-eval` 为固定版源码所需，保留，并点名确切出处。** 渲染器把 `@deepseek-ai/cordis` 作为平台模块播种（`packages/client/web/src/platform.ts:11`）；固定版 loader 的配置表达式求值器是 `vendor/loader/src/config/utils.ts:4`（vendor 钉 `b150a551`）里一个**模块作用域**的 `new Function('ctx', 'expr', …)`，它存在于构建出的渲染器包内 —— 它在模块被**导入**时执行，而不是在某个 `!!js` 表达式被求值时执行，因此该要求是加载期的，任何桌面代码不改固定版源码就无法避开。运行时冒烟的树挂载等待（`apps/desktop/tests/shell.spec.ts`）是常设的启动证明：没有 `unsafe-eval`，模块求值抛出，`__DSH_BOOT__` 与树永不出现，测试超时。`script-src` 里的 `blob:` 是载体的经典脚本启动路径（`evaluateClassicScript` 把固定版 `bootInjections` 门面与 preload 包执行成同源 blob URL），`style-src 'unsafe-inline'` 为固定版树的行内 style 属性所需（命令桥 frame 探测所指向的 AppFrame `grid-template-columns`）。冒烟断言实际服务的策略整串；单元测试钉住源码；改任何一边都必须重新论证。

**零 TCP 监听器是结构性事实，现由扫描钉住。** 桌面组合禁用了 `webserver`/`web-runtime` 行 —— web 配置里仅有的 HTTP 监听器 —— 并经由进程内 carrier 服务；边界扫描现在拒绝桌面生产源码中的任何套接字创建（`createServer(`、`new net|http|https.Server`、`.listen(`），把 stage 1 的"无 HTTP 监听器"检查强化为"无网络监听器"。

## Facts the stage settled

- 迫使 `unsafe-eval` 的 `new Function` 在**模块导入**时运行，因此对固定版树而言 CSP 要求是加载期的；它是 vendor 钉的属性，不是桌面代码的属性。
- `shell.openPath` 只把参数当文件路径 —— 没有任何 URL 方案能通过 `path.open` 抵达 OS 层；结构检查（非空、无 NUL、≤32768）是线缆的一半，DSH 的授权是策略的一半。
- 半开的传输操作（body 永不结束的 open）才是并发操作上限真正约束的对象：它是在途 carrier 操作的内存界，仅靠 credit 窗口覆盖不到。
- 会话的权限检查处理器与请求处理器是不同的缝：只拒绝请求处理器会把检查路径留给 Electron 自己。
- 渲染器的 `connect-src 'self'` 有承重作用：provider/API 流量从运行时子进程发出，绝不从渲染器页面发出。

## Consequences

- Stage 10 出口标准在零固定版源码改动下达成：M1–M3 与 U1–U3 未变，无新增 `M*`/`U*` 条目。
- 桌面端安全面现由源码与测试双重钉住：BrowserWindow 标志集、确切的 CSP 整串、仅主 frame 的封闭六方法桥、一律拒绝的权限处理器、元数据界、操作上限、无监听器的组合。
- 新增套件/覆盖：`apps/desktop/tests/desktop-security-hardening.spec.ts`（7 条：经 CJS 求值验证的 preload 主 frame 守卫 + 封闭面、启动图界、CSP 钉、BrowserWindow 标志钉），外加扩展后的 `transport.spec.ts`（26 条）、`native-protocol.spec.ts`、`protocol.spec.ts`、`security.spec.ts`、`boundary.spec.ts`、`shell.spec.ts`（沙箱可观测量、封闭桥面、`HTMLWebViewElement` 缺失、确切服务的 CSP、树挂载启动证明）。
- D4（带 KILL_ON_JOB_CLOSE 的 Windows 作业对象）仍是 stage 11 打包工作的常设条目，打包层面的其余一切（签名、公证、更新器、Electron Fuse）同理。

## Alternatives considered

- 移除 `unsafe-eval` 并修补固定版 loader 改为惰性求值 —— 拒绝：那是为满足桌面策略需求而改固定版源码，且该求值器与 `dsh web` 的配置加载共享；本阶段的规矩是桌面需求永不改钉。
- 用 CSP `script-src` 的 hash 或 nonce 覆盖经典脚本启动构件、取代 `blob:` —— 拒绝：门面与 preload 包的字节是运行时发布的（启动图经子进程 IPC 到达），任何静态 hash 都覆盖不到；同源 `blob:` URL 是保持固定版经典脚本语义的最小授权。
- 用整消息大小上限而非逐字段界来约束传输元数据 —— 拒绝：边缘处没有廉价方式度量结构化克隆信封的大小，逐字段界在共享解析器一处即可覆盖三个边，且取值有 Web 规范依据。
- 按流或按 fetch 分别设上限，而非合并的在途操作上限 —— 拒绝：威胁是活 carrier 操作的总和，单一合并上限就是最小的充分界（128 对两种原语都宽宽地覆盖真实客户端并发）。
- 打包构建的 E2E 断言 `devTools` 拒绝 —— 缓行：打包二进制是 stage 11 的产物；标志由单元测试在源码层面钉住，开发模式路径由冒烟演练。
- 越界*条目*时整体丢弃启动图消息但仍提供截断图 —— 拒绝：部分受信启动图比没有图更糟的契约；整体丢弃让"无构件"成为唯一失败形态。
