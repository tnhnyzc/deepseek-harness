# Agent Note：桌面原生 opener 作为可选主机能力

Status: implemented

[English](2026-09-15-desktop-native-opener-host-capability.md) | 中文

## 问题

打包后的桌面把 DSH runtime 作为受监督的子进程运行，并把每一个 OS 能力调用——选择目录、打开路径、打开文本文档——经由封闭的原生通道路由到 Electron main，因为子进程不得直接打开 OS 文件。在 `dsh-v0.1.3-alpha.1` re-pin 之前，桌面通过一个读取 `nativeOpeners` 主机服务的 apiproxy 把自己的默认应用 opener 注入网关。

re-pin 把打开调用移到了 `SessionController` 与 `SettingsController` 的远程方法上（`session/openWorkspacePath`、`settings/openSettingsDocument`、`settings/openAgentPresetDirectory`）。这些控制器只从单测 `internals` 解析其打开操作，从不读取主机服务。桌面继续*提供* `nativeOpeners`（委托给原生通道），而控制器*从不读取它*：生产 opener 接线成了孤儿，打包桌面从解析出的 DSH 路径到原生 opener 没有任何通路。

文本文档 opener 加剧了这个分裂。旧桌面设计把它留在 DSH 子进程 opener 上，因为 Electron `shell` API 没有单独命名文本编辑器意图，而目录选择器与默认应用路径打开早已跨通道。两种打开意图因此活在两条不同的 OS 路径上。

## 决策

opener 成为通用的可选主机能力 `NativeOpeners`，由 `@deepseek-ai/dsh-native-command` 拥有（两个控制器本就已依赖它）。它只命名主机可以拥有的打开操作，不带任何 Session、Settings、Electron、renderer 或 Desktop 词汇：

```ts
interface NativeOpeners {
  canOpenPath(): boolean
  openPath(path: string, signal: AbortSignal): Promise<void>
  openTextFile(path: string, signal: AbortSignal): Promise<void>
}
```

拥有 OS opener 的主机把它注册在 `nativeOpeners` 服务下，该服务由同包内对 `Context.nativeOpeners` 的声明扩展声明。控制器在调用时全新解析打开操作——绝不在构造时捕获——按固定优先级：直接的单测 `internals`，然后主机的 `nativeOpeners` 能力，然后本包的子进程 opener 回退。可用性探测 `canOpen` 遵循同样的优先级：单测探测，然后显式的 `nativeOpen` 配置策略，然后能力的 `canOpenPath()` 或可达 opener 的存在。

桌面 runtime 通过把三个操作全部委托给原生通道来提供该能力，通道新增 `path.openText` 方法，使文本文档像其他打开一样跨到 Electron main。Main 把 `path.open` 与 `path.openText` 分派到其能力注册表；Electron `shell` API 没有单独的文本编辑器打开，所以两种意图都用 OS 默认应用。因此文本编辑器意图在 DSH 层与协议层得以保留，并在非桌面部署中由子进程回退遵守，而桌面两种意图都用默认应用。

真实启动验收（`apps/desktop-runtime/tests/native-boot.spec.ts`）与 main 侧集成（`apps/desktop/tests/native-integration.spec.ts`）驱动 alpha.1 端点——`directoryPicker/pick`、`session/openWorkspacePath`、`session/canOpenWorkspacePath` 与 `settings/openSettingsDocument`——并断言各自发起的 `path.open` 与 `path.openText` 原生请求，包括调用方 abort 与 main 发起的取消终态。

## 曾考虑的备选方案

**恢复 rc.2 的 apiproxy 注入。** rc.2 的传输在一个 alpha.1 中已不存在的 apiproxy 里消费 `nativeOpeners`。重新添加控制器专属的注入路径会重新引入 re-pin 移除的流程专属接线，并让文本文档 opener 继续分裂在两个机制之间。

**在构造时捕获 opener。** 在构造函数里一次性读取 `nativeOpeners` 会把控制器的能力与 Loader 顺序耦合——provider 可能在控制器构造之后才安装——并且 provider 后来被移除时会留下过期可调用。操作时解析读取当前能力，能力缺席时干净地降级到回退。

**桌面文本文档 opener 留在子进程。** 这避免了一个新通道方法，但桌面 opener 行为仍然分裂：路径打开跨通道，而文本文档打开从 runtime 子进程 spawn 子进程。这是一个无法解释的不对称，也是桌面要白白承担的第二条 OS 路径。

## 后果

两个控制器在打包桌面中遵守主机提供的 opener，在普通的上游/Web 部署中回退到子进程 opener——那里 `nativeOpeners` 服务缺席。给主机添加该能力无需控制器变更；移除 provider 的主机不留下过期引用即降级到子进程 opener。

原生通道的封闭方法集新增 `path.openText`；每个按方法集分派的解析器、demux 守卫与 main 侧分派都已更新，并由协议与通道 spec 覆盖。

桌面的文本文档打开使用 OS 默认应用，而非强制文本编辑器打开（Electron `shell` 没有编辑器意图）。这是与非桌面部署中子进程 `open -t` 行为之间一个有意的、有文档记载的差异。
