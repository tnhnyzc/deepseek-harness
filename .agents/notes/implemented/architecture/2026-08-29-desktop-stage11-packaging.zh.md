# Agent Note:desktop 第 11 阶段——可复现的自包含打包与进程遏制

Status: implemented

[English](2026-08-29-desktop-stage11-packaging.md) | 中文

## 问题

第 1–10 阶段产出了一个可工作、已加固的 Electron 应用,它从仓库内运行:`pnpm --filter @deepseek-ai/dsh-desktop start` 针对工作区的 `node_modules` 和 `packages/` 中的 DSH 固定版本启动应用。这是开发面,不是产品。分发的构建必须在一台没有仓库、没有 `pnpm`、没有全局 `node`、首次启动无网络的机器上启动,而且必须可复现:相同的锁定输入必须产生相同的发布单元。它还必须扛住开发面所掩盖的两个平台特定风险——原生模块必须匹配*运行时* ABI 而非 Electron 的 ABI,以及 Windows 进程树生命周期:一个派生出的 DSH 命令树否则会活过应用。第 11 阶段(SPEC §25–28)是打包路径:一个可复现、自包含、按平台的发布单元,加上 Windows 遏制保证。

## 决策

**发布单元是原子性的、带身份的。** 桌面外壳、Electron、打包的 Node、固定的 DSH、客户端资产、原生 prebuild 作为一个单元发布。`apps/desktop/scripts/packaging/build-manifest.ts` 把 `build-manifest.json`(schema v1,九个字段)写入构件:桌面版本、DSH 的 commit 与版本、打包 Node 的版本与其 SHA-256、Electron 版本、桌面运行时协议版本、平台/架构,以及 `closureFingerprint`——对已暂存闭包的 `name@version` 集合的稳定哈希。读取器(`readBuildManifest`)在加载时复查 schema 版本与每个字段,因此一个与写入它的代码发生漂移的清单会在边界处失败,而非在运行时失败。指纹是可复现性句柄:相同的锁定输入产生相同的闭包集合,从而产生相同的指纹。

**DSH 运行在打包的独立 Node 之下,绝不在 Electron 之下。** 这是承载性的 ABI 规则。运行时子进程以构件自身的 `resources/node/<target>/node` 作为 `execPath` 派生(`apps/desktop/src/main/runtime.ts`),因此运行时加载的每个原生模块——`koffi`、`sharp` 及其 prebuild——必须匹配主机目标的*独立 Node* ABI,而非 Electron 的。刻意不对独立运行时模块运行 `electron-rebuild`;运行它会把它们重定位到 Electron ABI,破坏两个 ABI 拆分所要提供的隔离本身。打包的 Node 是主机目标在 `node-versions.json` 中固定的条目,由 `apps/desktop/scripts/bundle-node.ts`(`installNodeTarget`)下载并做 SHA-256 校验,因此构件中的 Node 二进制在每次构建中都是相同的字节。

**依赖闭包是从 pnpm store 复制的锁定固定拷贝,而非 `node_modules` 快照。** `apps/desktop/scripts/packaging/closure.ts` 遍历运行时入口的导入图,把每个解析到的包从 pnpm store 原样复制进一个扁平的暂存树。store 路径是易碎的部分:一个包的真实模块位于 `.pnpm/<id>/node_modules/<name>`,但一个带作用域的包位于 `.pnpm/<id>/node_modules/@scope/<name>`,而某些 store 包带有自身仅含 `.bin` 的 `node_modules`,它会遮蔽容器。`depContainer` 通过找到 `.pnpm` 路径段(`lastIndexOf`)并取其后的三段来定位容器,这对带作用域与不带作用域的包、以及对被遮蔽的情形都正确。弄错这一点不会让构建失败;它会静默地暂存一个不完整的树,打包的运行时在启动时无法解析某个模块——一旦找到带作用域 store 的依赖,闭包就从 339 增长到 750 个包。

**构件布局是 ASAR 加解包资源,由扫描校验。** `@electron/packager` 把 Electron 应用打进 `app.asar`,启用 asar 完整性;大的、路径敏感的、或原生的资源被暂存到它之外的 `Resources/` 下(渲染器 bundle、打包的 `node/`、`runtime/` 树、`build-manifest.json`、`licenses/`)。`apps/desktop/scripts/packaging/verify-layout.ts` 对构建出的构件运行 33 项检查:清单存在且格式良好,打包的 Node 存在且与清单的 SHA-256 匹配,每个闭包锚点(`koffi-<target>`、`sharp-<target>`、`sharp-libvips-<target>`、`dsh-base`)存在,asar 包含预期条目且没有多余的 `node_modules`,九个 fuse 读回其发布值。任一检查失败都会让流水线失败;它不是警告。

**九个 Electron fuse 全部显式设置,在任何签名之前。** `apps/desktop/scripts/packaging/fuses.ts` 用 `strictlyRequireAllFuses: true` 为 Electron 43 固定完整的 fuse 集——没有 fuse 留给 Electron 默认值。禁用 `RunAsNode` 与文件权限 fuse;启用 `EnableEmbeddedAsarIntegrityValidation` 与 `OnlyLoadAppFromAsar`。翻转发生在签名之前,因为 fuse 翻转改写二进制并使任何已有签名失效;在 Apple Silicon 上之后必须做 ad-hoc 重签。两个机械陷阱被构造性地固定:`@electron/fuses` 的 `FuseV1Options` 是一个*数值*枚举,所以 `Object.values` 会返回两个方向,代码改为遍历显式的 `DESKTOP_FUSE_INDICES`(数值键 `0..8`);且 `flipFuses` 返回它改写的二进制*切片*数(哨兵),而非改变的 fuse 数,因此报告说"set 9 fuses across 1 binary slice(s)"。

**签名由凭据门控,并报告为已配置对已执行。** 没有单一的签名模式。在 macOS 上,`apps/desktop/scripts/packaging/package.ts` 在存在 `CSC_NAME` 钥匙串身份时用 `@electron/osx-sign` 签名(加固运行时,内置的、已授予 `com.apple.security.cs.allow-jit` 的权限集),在 `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` 设置时用 `@electron/notarize` 公证;没有凭据时回退到 ad-hoc `codesign --force --deep --sign -`,它在构建主机上于 fuse 翻转之后可启动,但不是可分发的签名。在 Windows 上,在 `CSC_CERTIFICATE_FILE`/`CSC_KEY_PASSWORD` 设置时用 `@electron/windows-sign` 签名,否则以未签名发布。在 Linux 上没有签名。`package-report.json` 记录每一步签名与公证是否*已配置*(凭据存在)与*已执行*,因此一个无法公证的构建绝不会被误报为一个已公证的构建。

**D4 是真实的 Windows 进程树保证,只在其可被证明之处执行。** 当运行时根进程死亡时,DSH 树中的每个进程——包括 DSH 自身的分离命令树——都必须随之死亡。在 Windows 上这在运行时子进程(`apps/desktop-runtime/src/windows-job.ts`)中用 Win32 Job Object 实现,以 `KILL_ON_JOB_CLOSE` 创建,并通过 `AssignProcessToJobObject` 把进程分配给它,用 `koffi` 调用 kernel32 API,在每次调用前做结构体大小守卫。验收脚本(`apps/desktop/scripts/d4-acceptance.ts`)派生一个子进程,它再生一个孙进程,用 `taskkill /F /PID`(刻意不用 `/T`,所以是 Job Object 而非 taskkill 的树标志)杀掉子进程的根,并断言孙进程在期限之内消失,而验收进程自身存活。这**只**在 `desktop-windows` CI 作业中、在真实的 Windows 内核上运行;绝不在 macOS 上宣称本地已执行。

**干净副本启动冒烟测试是分发证明。** `apps/desktop/scripts/packaging/smoke-runtime.ts` 用*构件自身的*打包 Node 派生打包的 `runtime/dist/index.js`,在一个临时目录里放一个全新的 `DSH_HOME`,用最小的 `PATH`(`/usr/bin:/bin:/usr/sbin:/sbin`),并断言子进程到达 `runtime.ready` 且 `dshVersion` 等于清单的 DSH 版本,然后在有界 kill 期限下优雅关闭。如果闭包、Node 二进制或某个原生 prebuild 有误,这就会失败——它是流水线最接近"用户双击应用"的地方。除非 `--skip-smoke`,它作为 `package` 的最终门运行。

**每个 CI runner 打包它自己的平台。** 跨主机打包被设计性地拒绝:闭包的原生 prebuild 是主机特定的,所以一台 macOS runner 无法为其他平台暂存正确的闭包。`ci.yml` 增加三个必需作业——`desktop-macos`(macos-latest)、`desktop-windows`(windows-latest,它还运行 D4 验收)、`desktop-linux`(ubuntu-latest)——每个都运行 `pnpm --filter @deepseek-ai/dsh-desktop run package`。它们位于 `all-checks-passed.needs` 中,因此任一平台的损坏包、或一个 D4 回归,都会阻塞合并。

## 本阶段固定的事实

- 打包器的 `filenamify` **不**替换空格(它们不是保留字符),所以输出目录、`.app`、可执行文件在每个平台上都逐字保留产品名的空格——`DeepSeek Harness Desktop-<platform>-<arch>` 与 `DeepSeek Harness Desktop.app`。构件路径助手保留空格;它们不做连字符化。
- 一个带作用域 store 包的真实路径是 `.pnpm/<id>/node_modules/@scope/<name>`;容器是 `.pnpm` 段之后的三个路径段,用 `lastIndexOf` 找到。一个 store 包自身仅含 `.bin` 的 `node_modules` 会遮蔽容器,必须在它之前检查。
- `@electron/fuses` 的 `FuseV1Options` 是数值枚举:`Object.values` 会返回名称与值两个方向,所以 fuse 遍历必须用显式的数值索引列表。
- `@electron/osx-sign` 2.x 的 `sign({app, identity})` 默认开启 `hardenedRuntime` 并使用内置权限(含 `allow-jit`);2.7.0 中没有顶层 `hardenedRuntime`/`entitlements` 选项。`notarize` 取 `appPath` 而非 `app`。`@electron/windows-sign` 的 `hashes` 是一个跨包 `const enum`,字符串字面量无法满足,必须转型。
- 独立 Node ABI 规则意味着运行时的原生模块被重定位到打包的 Node,且 `electron-rebuild` 绝不可触及它们;两个 ABI 世界(外壳用 Electron,运行时用独立 Node)正是拆分的全部意义。

## 后果

- 第 11 阶段退出准则达成,无固定源码变更、无新的 Electron 面:发布单元可复现(清单 + 闭包指纹)、自包含(在构件自身 Node 下、最小 PATH 的启动冒烟)、按平台(三个必需 CI 作业)、在 Windows 上进程遏制(D4,在 CI 的真实内核上执行)。
- 新脚本:`apps/desktop/scripts/packaging/{package,staging,closure,build-manifest,fuses,verify-layout,smoke-runtime}.ts`;新 devDependencies `@electron/asar`、`@electron/osx-sign`、`@electron/windows-sign`(与既有的 `@electron/packager`、`@electron/fuses`、`@electron/notarize` 并列);`apps/desktop-runtime` 中的 `koffi ^3.1.0`。
- 新覆盖:`apps/desktop/tests/packaging.spec.ts`(fuse 固定、按平台二进制路径、闭包指纹确定性、清单读取器,以及对已构建构件的可选完整布局校验)以及扩展的 `ci-workflow.spec.ts`(三个必需的按平台作业与仅 Windows 的 D4 通道)。
- D4 的 Windows 执行与 Windows/Linux 打包由 CI 证明,而非本地证明:本地主机是 macOS,所以 `desktop-windows` 与 `desktop-linux` 通道是那些平台的常设证据,而 Developer ID / 公证 / Windows 证书签名路径在凭据缺失处是已配置未执行。
- 更新器(SPEC §28)被记录为发布边界但未构建;第 11 阶段产出更新器日后会移动的那个构件。

## 曾考虑的替代方案

- 让 DSH 运行在 Electron 的 Node 之下而非打包的独立 Node——拒绝:它会塌缩两个 ABI 拆分,强制对运行时的原生模块运行 `electron-rebuild`,并把 DSH 运行时绑定到 Electron 的 V8/ABI 发布节奏;拆分正是让运行时跟随一个固定、带校验和的 Node 的原因。
- 整体复制 `node_modules` 而非 store 派生的闭包——拒绝:`node_modules` 快照携带开发者的完整树(devDependencies、提升的重复、平台外来的 prebuild),不是一个锁定固定、可复现的单元;闭包是最小的、可哈希的集合。
- 跨主机打包(一台 runner 构建所有平台)——拒绝:原生 prebuild 是主机特定的,所以单台主机无法为其他平台暂存正确的闭包;每个 runner 打包它自己的平台。
- 把 fuse 留给 Electron 默认值、只翻转安全关键的那些——拒绝:默认值是一个随 Electron 版本变化的隐式契约;`strictlyRequireAllFuses` 加显式的九 fuse 集使构件的能力面成为一个被审阅、被固定的事实。
- 把打包作业设为非阻塞(观察性)如同 `windows-native`——对 v1 拒绝:一个损坏的包或一个 D4 遏制回归是发布缺陷,而这一阶段的全部意义在于分发单元确实能启动;三个作业是必需的。
- 在 CI 通道上 ad-hoc 签名并称之为完成——拒绝:ad-hoc 是一个构建主机可启动的签名,不是可分发的签名;流水线改为区分已配置(凭据存在)与已执行并报告它,因此一个发布可以要求真实的凭据路径,而 CI 通道无需密钥。
