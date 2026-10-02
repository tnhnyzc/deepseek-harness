# Agent Note：桌面 Stage 11 打包要求干净的主机安装，而非历史 store 内容

Status: implemented

[English](2026-09-22-desktop-stage11-packaging-clean-install-prerequisite.md) | 中文

## 问题

在 `dsh-v0.1.3-alpha.1` re-pin 期间，桌面闭包审计与 `package` 脚本在本机以 `dependency @koromix/koffi-darwin-x64 is not installed` 失败，阻断了 arm64 `.app` 构建。直接诱因是一次误操作的 `pnpm store prune`，把缓存的跨平台构件（非 darwin-arm64 的 `@koromix/koffi-*` prebuild）从全局 pnpm store 中删除。在 darwin-arm64 主机上，普通的 `pnpm install` 不会重新生成跨平台的可选原生 prebuild，因此被剪掉的 prebuild 留下了损坏的符号链接，审计在其上绊倒。

## 决策

调查确认了既定设计就是目标平台特定的（每个 runner 打包自己的平台），因此无需任何源码或打包变更：

- `closure.ts` 写明契约："每个 CI runner 打包自己的平台，其 workspace 安装持有该平台的 prebuild。"
- 实证上，一次干净的 darwin-arm64 安装只在 koffi 容器内生成 `koffi-darwin-arm64`（不生成其他平台的 prebuild）。闭包审计审计的是主机安装实际持有的内容；它没有越界成跨平台矩阵。

因此，干净安装是受支持、可复现的打包起点。历史 pnpm-store 内容不是必需的构建输入，损坏或跨平台填充的本地 store 不是受支持的本地状态。

## 本地验证与 Xcode 许可缺口

在恢复干净安装（全新临时 pnpm store + frozen-lockfile 安装）之后，闭包审计通过（8/8），`package` 管线跑完了构建、闭包 staging、Electron 打包、fuses、ad-hoc 签名与布局校验（33 项检查）。它只停在 boot 冒烟的 `Cannot find module './build/Release/fs_ext.node'`：`fs-ext` 原生构建需要 Xcode 许可（`sudo xcodebuild -license`），本机尚未接受，加上本地网络不稳定拖慢了安装。这是主机前提/本地环境限制，不是 re-pin 的产品或打包回归。

权威完成证明（冻结安装、原生构建、闭包审计、包创建、boot 冒烟、原生模块冒烟、packaged-app、packaged-user-journey）委派给既有的干净 macOS CI 打包 runner（`ci.yml` → `desktop-macos`，arm64），它有 Xcode 许可与稳定网络。没有为编码这次本地事件而改动任何生产或打包源码。

## 曾考虑的备选方案

**对闭包审计或 `package` 脚本做源码/打包修复。** 落选：调查确认设计本就是有意目标平台特定的——每个 CI runner 打包自己的平台，其 workspace 安装持有该平台的 prebuild——所以审计正确地限定在主机安装范围内，失败是本地 store 状态，不是产品或打包回归。

**在本机接受 Xcode 许可（`sudo xcodebuild -license`）以完成本地 boot 冒烟。** 落选：它是一项所有者机器前提（sudo + 许可接受），与 re-pin 无关，而且干净的 macOS CI runner 本就是权威打包权威——本地完成不在关键路径上。

## 后果

代价：本机 arm64 `.app` 构建仍被 Xcode 许可阻断，且损坏或跨平台填充的 pnpm store 被记录为不受支持的本地状态——闭包审计会在其上绊倒，而不是静默吸收。

收益：一个可复现的干净安装流程（全新临时 pnpm store + frozen-lockfile 安装）成为受支持的打包起点；事件被定性为主机前提，零源码变更；失败模式被点名，被剪掉或跨平台的 store 不会再被误读为 re-pin 回归。
