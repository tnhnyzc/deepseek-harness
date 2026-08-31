# Agent Note:desktop 第 11 阶段——可复现的自包含打包与进程遏制

Status: implemented

[English](2026-08-29-desktop-stage11-packaging.md) | 中文

## 问题

第 1–10 阶段产出了一个可工作、已加固的 Electron 应用,它从仓库内运行:`pnpm --filter @deepseek-ai/dsh-desktop start` 针对工作区的 `node_modules` 和 `packages/` 中的 DSH 固定版本启动应用。这是开发面,不是产品。分发的构建必须在一台没有仓库、没有 `pnpm`、没有全局 `node`、首次启动无网络的机器上启动,而且必须可复现:相同的锁定输入必须产生相同的发布单元。它还必须扛住开发面所掩盖的两个平台特定风险——原生模块必须匹配*运行时* ABI 而非 Electron 的 ABI,以及 Windows 进程树生命周期:一个派生出的 DSH 命令树否则会活过应用。第 11 阶段(SPEC §25–28)是打包路径:一个可复现、自包含、按平台的发布单元,加上 Windows 遏制保证。

## 决策

**发布单元是原子性的、带身份的。** 桌面外壳、Electron、打包的 Node、固定的 DSH、客户端资产、原生 prebuild 作为一个单元发布。`apps/desktop/scripts/packaging/build-manifest.ts` 把 `build-manifest.json`(schema v2,十一个字段)写入构件:桌面版本、DSH 的 commit 与版本、打包 Node 的版本与其 SHA-256、Electron 版本、桌面运行时协议版本、平台/架构,以及 `closureFingerprint`——对已暂存闭包排序后的 `consumer@version -> dep@version` 解析*边*的稳定哈希,而不只是名称/版本集合:仅在一个消费者解析到哪个版本上不同的两个闭包,现在产生不同的指纹。读取器(`readBuildManifest`)在加载时复查 schema 版本与每个字段,因此一个与写入它的代码发生漂移的清单会在边界处失败,而非在运行时失败。指纹是可复现性句柄:相同的锁定输入产生相同的闭包图,从而产生相同的指纹。

**DSH 运行在打包的独立 Node 之下,绝不在 Electron 之下。** 这是承载性的 ABI 规则。运行时子进程以构件自身的 `resources/node/<target>/node` 作为 `execPath` 派生(`apps/desktop/src/main/runtime.ts`、`runtime-paths.ts`),因此运行时加载的每个原生模块——`koffi`、`sharp` 及其 prebuild——必须匹配主机目标的*独立 Node* ABI,而非 Electron 的。刻意不对独立运行时模块运行 `electron-rebuild`;运行它会把它们重定位到 Electron ABI,破坏两个 ABI 拆分所要提供的隔离本身。打包的 Node 是主机目标在 `node-versions.json` 中固定的条目,由 `apps/desktop/scripts/bundle-node.ts`(`installNodeTarget`)下载并做 SHA-256 校验,因此构件中的 Node 二进制在每次构建中都是相同的字节。

**依赖闭包先审计、再按"扁平根 + 按消费者冲突影子"暂存。** `apps/desktop/scripts/packaging/closure-audit.ts` 遍历运行时入口的*生产*导入图,记录每条消费者→依赖解析边、每个同名不同版本的冲突、以及图指纹。真实图包含依赖循环(`@deepseek-ai/cordis` ↔ `cordis-plugin-include`,以及经过插件 loader 与 API 代理链的更长循环),因此任何把*每个*依赖嵌套在*每个*消费者位置下的暂存方案都会在循环上无法终止、在菱形密集的子图上爆炸;按消费者位置计算的方案曾死循环到 4 GB。采用的布局(`apps/desktop/scripts/packaging/closure.ts`):无冲突的包实例**只复制一份**到 `<root>/node_modules/<name>`——Node 的向上查找从任何消费者位置都能到达它,根包之间的循环就是普通的 `require` 循环——而冲突的实例复制到每个冲突消费者的暂存位置之下,仅对冲突边做不动点计算。在真实图上这是 496 份复制(436 根 + 60 影子),对应 452 个实例与 1968 条边,约 15 秒完成。暂存的审计写入构件的 extraResources,布局验证器把图与清单指纹重新对照。

**构件布局是 ASAR 加解包资源,以扫描验证。** `@electron/packager` 把 Electron 应用打进带 asar 完整性校验的 `app.asar`;体积大、路径敏感或原生的资源在 asar 之外暂存于 `Resources/` 之下(renderer 包、打包的 `node/`、`runtime/` 树、`build-manifest.json`、`licenses/`)。asar 镜像开发检出布局——`dist/main/index.js`、`src/preload/index.cjs`,以及保留 `type: module` 的清单——因为外壳通过 `app.getAppPath() + '/src/preload/index.cjs'` 解析签入的 preload,同一个表达式必须在两个世界都成立;一个被压平的 asar 会让打包 preload 静默 ENOENT(没有桥、renderer 在首次 IPC 上崩溃)。`apps/desktop/scripts/packaging/verify-layout.ts` 对已构建构件运行 33 项检查:清单存在且良构、打包 Node 存在且匹配清单 SHA-256、每个闭包锚点(`koffi-<target>`、`sharp-<target>`、`sharp-libvips-<target>`、`dsh-base`)只暂存一份且可从其消费者解析、asar 含预期条目且无散落的 `node_modules`、九个 fuse 读回其发布值。检查失败即流水线失败,不是警告。

**九个 Electron fuse 全部显式设置,在任何签名之前。** `apps/desktop/scripts/packaging/fuses.ts` 以 `strictlyRequireAllFuses: true` 固定 Electron 43 的完整 fuse 集——没有 fuse 留给 Electron 默认值。`RunAsNode` 与文件权限 fuse 被禁用;`EnableEmbeddedAsarIntegrityValidation` 与 `OnlyLoadAppFromAsar` 被启用。`EnableNodeCliInspectArguments` 被刻意 fuse **关闭**:发布二进制不暴露 Node 级 inspector,因此主进程没有活代码路径(正因如此,打包 app 冒烟必须经浏览器 DevTools 端点驱动应用——见下)。翻转发生在签名之前,因为 fuse 翻转重写二进制并使任何既有签名失效;在 Apple Silicon 上之后必须 ad-hoc 重签。两个机械陷阱被构造性固定:`@electron/fuses` 的 `FuseV1Options` 是*数值*枚举,`Object.values` 同时产生两个方向,因此代码迭代显式的 `DESKTOP_FUSE_INDICES`(数值键 `0..8`);而 `flipFuses` 返回它重写的二进制*切片*数(哨兵),不是改变的 fuse 数,所以报告说"set 9 fuses across 1 binary slice(s)"。

**签名由凭据门控,并按"已配置对已执行"报告。** 没有单一签名模式。在 macOS 上,`apps/desktop/scripts/packaging/package.ts` 在存在 `CSC_NAME` 钥匙串身份时经 `@electron/osx-sign` 签名(hardened runtime、内置的 entitlement 集已授予 `com.apple.security.cs.allow-jit`),并在 `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` 设置时经 `@electron/notarize` 公证;没有凭据时回退到 ad-hoc `codesign --force --deep --sign -`,它在 fuse 翻转之后于构建主机上可启动,但不是可分发签名。在 Windows 上,存在 `CSC_CERTIFICATE_FILE`/`CSC_KEY_PASSWORD` 时经 `@electron/windows-sign` 签名,否则无签名发布。Linux 没有签名。`package-report.json` 按步骤记录签名与公证是*已配置*(凭据存在)还是*已执行*,因此一个未能公证的构建永远不会被误报为已公证。

**D4 是真实的 Windows 进程树保证,固定到 SDK ABI,只在其可被证明之处执行。** 当运行时根死亡时,DSH 树中的每个进程——包括 DSH 自己的 detached 命令树——必须随之死亡。在 Windows 上这实现在运行时子进程中(`apps/desktop-runtime/src/windows-job.ts`),用一个以 `KILL_ON_JOB_CLOSE` 创建的 Win32 Job Object,进程经 `AssignProcessToJobObject` 分配到它,用 `koffi` 对 kernel32 调用,结构布局精确镜像自 Windows SDK 头文件(`JOBOBJECT_BASIC_LIMIT_INFORMATION` 64 字节、`LimitFlags` 在偏移 16、IO 计数器 48 字节、扩展限制信息 144 字节、信息类 9、基础限制用 `PROCESS_SET_QUOTA`),并带安装期 sizeof 门。`apps/desktop-runtime/scripts/check-windows-job-abi.ts` 用工具链的 `cl.exe` 编译一个 C 探针,把编译器的尺寸、偏移与常量同 koffi 声明和固定值对照,因此结构漂移在任何运行时遏制主张之前就让构建失败。验收脚本(`apps/desktop/scripts/d4-acceptance.ts`)以两种模式运行——dev 运行时与 `--packaged <构件>`——每种模式派生一个子进程、子进程再生一个孙进程,用 `taskkill /F /PID`(刻意不用 `/T`,所以杀死孙进程的是 Job Object 而非 taskkill 树标志)杀死子进程的根,并断言孙进程在期限内消失、而验收进程自身存活。两种模式**只**在 `desktop-windows` CI 作业、真实 Windows 内核上运行;它们绝不在 macOS 上被声称为本地执行。

**执行冒烟是分发证明——共四个,全部在构件自身字节之下。** (1) 干净副本启动冒烟(`scripts/packaging/smoke-runtime.ts`)用*构件自身的*打包 Node 派生打包的 `runtime/dist/index.js`,配临时目录中的全新 `DSH_HOME` 与最小 `PATH`(`/usr/bin:/bin:/usr/sbin:/sbin`),断言子进程以等于清单 DSH 版本的 `dshVersion` 到达 `runtime.ready`。(2) 解析冒烟(`scripts/packaging/smoke-resolution.ts`)在打包 Node 下验证已暂存闭包的解析边,用显式的 Node 风格 `node_modules` 查找(最近者优先、以运行时根为界)而非 `require.resolve`——`require.resolve` 太严格:仅类型包(`undici-types`、`csstype`)、只有 exports 而无 `main` 的包(`@img/sharp-*`、`dsh-web-frontend`)、仅二进制的包在真实工作区里同样失败它,因此布局契约是最近者优先的放置,对照 `package.json` 名称+版本检查。(3) 原生模块执行冒烟(`scripts/packaging/smoke-native-modules.ts`)在打包 Node 下执行 `sharp`(libvips)与 `koffi`(FFI)。(4) 打包 app 冒烟(`scripts/smoke-packaged-app.ts`)启动**真实的打包 Electron 可执行文件**,配全新临时 user-data 目录、受约束的 `PATH`、播种的单工作区注册表,证明发布的构件到达真实 DSH UI(客户端树已启动、composer 可编辑)、携带安全基线(sandbox、contextIsolation、无 nodeIntegration、webSecurity、无 webview、DevTools 被拒、默认拒绝的权限策略及其唯一的剪贴板例外)、运行打包的运行时(在打包 Node 下就绪、带固定 DSH 版本)、完成一次有界的真实载体往返(针对脚本化 127.0.0.1 provider 的 composer 回合)、保持零产品 TCP 监听器(运行时进程;shell 唯一的监听器是冒烟自身的 DevTools 端点)、并扛住第 9 阶段的崩溃/重启演练(异常根死亡、窗口存活、UI 的重启入口带来一个以新运行时 pid 就绪的新一代)。外壳经浏览器级 DevTools 端点(`--remote-debugging-port=0`,一个不受发布 fuse 影响的 Chromium 开关,从二进制自身 stderr 读取)以最小 CDP 会话驱动,因为 Playwright 的 Electron 支持需要 `EnableNodeCliInspectArguments` 关闭所移除的 Node inspector 接缝——在 fuse 后的二进制上 Playwright 的启动永远挂起。UI 输入是 CDP `Runtime.evaluate` 之下的合成 DOM(React 受控 composer 走原生 value setter + `input` 事件,Enter 为 `keydown`)。冒烟在没有已构建构件或 GUI 会话时自跳过;CI 泳道按平台运行它(Linux 在 Xvfb 下)。

**每个 CI runner 打包自己的平台,覆盖全部四个目标。** 跨主机打包被设计性拒绝:闭包的原生 prebuild 是主机特定的,macOS runner 无法为 Windows 暂存正确闭包。`ci.yml` 定义四个必需作业——`desktop-macos`(macos-latest,darwin-arm64)、`desktop-macos-x64`(macos-14,darwin-x64)、`desktop-windows`(windows-latest,win32-x64——同时运行 Win32 ABI 探针与 dev、`--packaged` 两种模式的 D4 验收)、`desktop-linux`(ubuntu-latest,linux-x64——带 Electron 系统依赖与 Xvfb 显示,使打包 app 冒烟真正运行)——每个运行 `pnpm --filter @deepseek-ai/dsh-desktop run package` 并上传其发行归档加 `package-report.json` 作为运行证据。它们在 `all-checks-passed.needs` 中,因此任何平台上的破损包、或 D4 回归,都会阻塞合并。流水线自身在开始时对仓库根 `package.json` 与 `pnpm-lock.yaml` 做快照,并在写报告前复核,使打包绝不会悄悄改写仓库文件。

## 本阶段定下的事实

- packager 的 `filenamify` **不**替换空格(它们不是保留字符),所以输出目录、`.app` 与可执行文件在每个平台上都逐字保留产品名的空格——`DeepSeek Harness Desktop-<platform>-<arch>` 与 `DeepSeek Harness Desktop.app`。构件路径助手保留空格;它们不做连字符化。
- 作用域 store 包的真实路径是 `.pnpm/<id>/node_modules/@scope/<name>`;容器是 `.pnpm` 段之后的三个路径段,用 `lastIndexOf` 找到。store 包自己的仅 `.bin` 的 `node_modules` 会遮蔽容器,必须先检查它。
- 生产闭包含依赖循环,而把每个依赖嵌套在每个消费者位置之下的暂存方案在循环上无法终止(实测:死循环、4 GB OOM)。扁平根 + 按消费者冲突影子可终止:根包经 Node 向上查找为每个消费者解析,只有 8 个冲突实例(16 实例、43 条边)需要按消费者影子。
- 对裸说明符的 `require.resolve` 不是暂存布局的正确探针:仅类型、只有 exports 而无 `main`、仅二进制的包在真实工作区里也失败它。布局契约是最近者优先的 `node_modules` 放置,用显式有界查找对照 `package.json` 名称+版本验证。
- fuse 后的发布二进制没有 Node inspector(`EnableNodeCliInspectArguments` 关闭),但它遵守 `--remote-debugging-port=0`;浏览器 DevTools 端点是外部观察者实际拥有的接缝,它驱动整个打包 app 冒烟。Playwright `_electron.launch` 在 fuse 后的二进制上挂在 inspector 握手处。
- asar 必须镜像开发检出布局(`dist/main` + `src/preload`,清单带 `type: module`):外壳在两个世界都通过 `getAppPath() + '/src/preload/index.cjs'` 解析 preload。被压平的 asar 表现为静默 preload ENOENT 与 renderer 在首次 IPC 上的崩溃。
- 打包运行时可执行文件位于 `resources/node/<target>/node`——外壳的路径表达式与暂存布局必须一致,否则首次启动以 spawn ENOENT 失败。
- session 工作区附着校验 `realpath(session.cwd) === workspace.path`;在 macOS 与许多 Linux 主机上临时根是符号链接(`/var` → `/private/var`),所以播种的冒烟工作区必须在写注册表前 realpath。
- 运行时子进程收到的是策划过的环境,不是 shell 的:测试专用的 `DSH_DESKTOP_SMOKE=1` 门必须经监督者的 `extraEnv` 转发,运行时才会发布冒烟事实、桥才会暴露冒烟方法。
- 发行归档是 `DeepSeek Harness Desktop-<version>-<platform>-<arch>.zip`(macOS 用 `ditto`、Windows 用 PowerShell `Compress-Archive`)或 `.tar.gz`(Linux 用 `tar`),各带 `.sha256` 侧车——在 fuse 与签名之后创建,所以归档携带的是定稿字节。
- `@electron/fuses` 的 `FuseV1Options` 是数值枚举:`Object.values` 返回名称与值两个方向,所以 fuse 迭代必须用显式数值索引列表。
- `@electron/osx-sign` 2.x 的 `sign({app, identity})` 默认开启 `hardenedRuntime` 并使用内置 entitlements(含 `allow-jit`);2.7.0 中没有顶层 `hardenedRuntime`/`entitlements` 选项。`notarize` 取 `appPath` 而非 `app`。`@electron/windows-sign` 的 `hashes` 是跨包 `const enum`,字符串字面量无法满足,必须强制转换。
- 独立 Node ABI 规则意味着运行时的原生模块被重定位到打包 Node,`electron-rebuild` 绝不能触碰它们;两个 ABI 世界(Electron 管外壳、独立 Node 管运行时)正是拆分的全部意义。

## 后果

- 第 11 阶段退出标准达成,无固定源码改动、无新的 Electron 面:发布单元可复现(清单 + 闭包图指纹)、自包含(在构件自身 Node 下的启动冒烟、最小 PATH)、按平台(四个必需 CI 泳道、每目标一个)、执行已证明(在构件自身字节下的四个冒烟,最后一个在真实二进制与真实 UI 上)、并在 Windows 上进程遏制(D4、ABI 已固定、在 CI 真实内核上以 dev 与打包两种模式执行)。
- 新脚本:`apps/desktop/scripts/packaging/{package,staging,closure-audit,closure,build-manifest,fuses,verify-layout,smoke-runtime,smoke-resolution,smoke-native-modules,release-format}.ts`、`apps/desktop/scripts/smoke-packaged-app.ts`、`apps/desktop-runtime/scripts/{check-windows-job-abi.ts,windows-job-abi-probe.c}`;新 devDependencies `@electron/asar`、`@electron/osx-sign`、`@electron/windows-sign`(与既有的 `@electron/packager`、`@electron/fuses`、`@electron/notarize` 并列);`apps/desktop-runtime` 的 `koffi ^3.1.0`。
- 新覆盖:`apps/desktop/tests/packaging.spec.ts`(fuse 固定、按平台二进制路径、归档格式固定、清单读取器、以及对已构建构件的可选完整布局验证)、`apps/desktop/tests/closure-audit.spec.ts`(一个合成的 pnpm 形状夹具——store 容器、符号链接、workspace 包、以及一个无冲突循环作为回归护栏——加上对真实仓库图的只读断言)、`apps/desktop/tests/packaged-app.spec.ts`(对真实二进制冒烟的自跳过包装)、以及扩展的 `ci-workflow.spec.ts`(四个必需按平台泳道、仅 Windows 的 ABI 探针 + dev/打包 D4 验收、Linux Xvfb 显示、按泳道归档上传)。
- D4 的 Windows 执行与 Windows/Linux/darwin-x64 打包是 CI 已证明、非本地已证明:本地主机是 macOS arm64,四个 CI 泳道是完整目标矩阵的常设证据,Developer ID / 公证 / Windows 证书签名路径在凭据缺席处是已配置未执行。
- 更新器(SPEC §28)被记录为发布边界但未构建;第 11 阶段产出更新器日后要搬运的构件。

## 已考虑的替代方案

- 让 DSH 运行在 Electron 的 Node 下而非打包的独立 Node——拒绝:它会抹掉两个 ABI 拆分、被迫在运行时原生模块上运行 `electron-rebuild`、并把 DSH 运行时绑到 Electron 的 V8/ABI 发布节奏;拆分正是让运行时跟踪一个固定、带校验和的 Node 的原因。
- 整体复制 `node_modules` 而非 store 派生的闭包——拒绝:`node_modules` 快照携带开发者的完整树(devDependencies、提升的重复、异平台 prebuild),不是锁定固定、可复现的单元;闭包是最小的、可哈希的集合。
- 把每个依赖嵌套在每个消费者位置之下(对所有边按消费者暂存)——在直接观察后拒绝:真实图的依赖循环使方案无法终止(死循环)、其菱形密集子图使方案指数化(4 GB OOM);扁平根 + 按消费者冲突影子是保留精确按消费者解析的终止布局。
- 经 Playwright 的 Electron 支持驱动打包 app 冒烟——拒绝:它需要 Node inspector(`--inspect`),而 `EnableNodeCliInspectArguments` fuse 刻意从发布二进制移除它;浏览器 DevTools 端点是外部观察者实际拥有的接缝,把 fuse 翻回会重新打开主进程的活代码路径。
- 跨主机打包(一个 runner 构建所有平台)——拒绝:原生 prebuild 是主机特定的,单台主机无法为其他平台暂存正确闭包;每个 runner 打包自己的平台。
- 把 fuse 留给 Electron 默认值、只翻转安全关键者——拒绝:默认值是随 Electron 版本变化的隐式契约;`strictlyRequireAllFuses` 加显式九 fuse 集使构件的能力面成为被审阅的、固定的事实。
- 把打包作业做成非阻塞(观测性)像 `windows-native`——对 v1 拒绝:破损包或 D4 遏制回归是发布缺陷,而本阶段的全部意义在于分发单元确实能启动;四个作业都是必需的。
- 在 CI 泳道 ad-hoc 签名然后了事——拒绝:ad-hoc 是构建主机可启动签名,不是可分发签名;流水线转而区分已配置(凭据存在)与已执行并报告它,使发布可以要求真实凭据路径而不需要 CI 泳道持有秘密。
