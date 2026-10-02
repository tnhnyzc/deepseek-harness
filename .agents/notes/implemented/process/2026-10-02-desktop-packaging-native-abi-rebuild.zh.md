# Agent Note：桌面 staging 将闭包中 ABI 易碎的本地包对捆绑 Node 重新编译

Status: implemented

[English](2026-10-02-desktop-packaging-native-abi-rebuild.md) | 中文

## 问题

闭包 staging 逐字节复制工作区的 `node_modules`，而其中 gyp 编译的本地包携带的是运行 `pnpm install` 的那个 Node 的 ABI——在 CI runner 上是 Node 24。打包后的运行时跑在固定的捆绑 Node 上（`node-versions.json`：v22.23.2，`NODE_MODULE_VERSION 127`）。Node 24 的插件（`NODE_MODULE_VERSION 137`）在 `require` 时抛错，桌面 boot 冒烟死在第一个这样的导入上：

```
dsh-desktop-runtime: plugin tree failed to load: ... failed to import loader entry
session-persistence-jsonl (@deepseek-ai/dsh-session-persistence-jsonl): The module
.../runtime/node_modules/fs-ext/build/Release/fs_ext.node was compiled against a
different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js
requires NODE_MODULE_VERSION 127.
```

re-pin 才让这个问题变得可触发。re-pin 之前闭包里没有任何东西导入 `fs-ext`（已在 fork master `4327dc3368` 核实：`packages/session/` 下无引用）；alpha.1 候选的 `session-persistence-jsonl` 的 `lease.ts` 从 `fs-ext` 导入 `flock`，因此候选的闭包携带它。本地复现把问题掩盖了：这台主机的 Node 是 22.x，工作区的 `fs-ext` 恰好与捆绑 Node 的 ABI 一致，于是本地预演通过了 boot 冒烟，而每个 CI 平台都失败在 boot 冒烟。

`node-pty` 是闭包里另一个 ABI 易碎成员：它随包发布 N-API prebuild（ABI 稳定），但其安装会回退到源码构建（`node scripts/prebuild.js || node-gyp rebuild`），在该路径下 staged 二进制携带 runner 的 ABI。`sharp` 不受影响：`prebuild-install` 提供它的 N-API 二进制，且它的 `binding.gyp` 不在包根。

## 决策

`stageRelease` 现在在打包前将闭包中 gyp 可编译的 ABI 易碎本地包对固定的捆绑 Node 重新编译。它扫描每一个 staged `node_modules` 根（含冲突影子目录）；带根级 `binding.gyp` 的 staged 包必须出现在 `GYP_AT_INSTALL_PACKAGES`（当前为 `fs-ext` 与 `node-pty`）中，否则 staging 失败——这样新的 ABI 易碎依赖会在 staging 阶段被归类，而不是被 boot 冒烟发现。每个列出的包用 node-gyp（`apps/desktop` 的新 devDependency，固定为 `12.4.0`，即 pnpm 11.7.0 运行生命周期构建所用的版本）以 `--target` 取 `node-versions.json` 的版本重新编译——与安装捆绑二进制相同的单一事实来源。

## 曾考虑的备选方案

**把 CI 桌面任务的安装 Node 固定到捆绑版本的主版本。** 一个 workflow 环境变量（`npm_config_target`，或把安装步骤从 Node 24 改成 22）在 runner 上可行，但它把 workflow 与 pin 耦合，且本地预演仍可悄悄分叉（这台主机今天是 Node 22；一台 Node 24 的主机会无声地复现 CI 的失败）。打包管线拥有捆绑 Node 契约，所以重建应放在管线里，从 `node-versions.json` 读 pin，不依赖 workflow 知识。

**在 staging 之前重建工作区包。** 那会改动检出目录的 `node_modules`——开发者工具自己的二进制——只为一个打包产物。staging 是打包面；重建只作用在 staged 副本上。

## 后果

现在每个打包产物都携带按其自身捆绑 Node 编译的 `fs-ext`（及 `node-pty`），在任何平台上、本地与 CI 皆然。staging 为每个列出的包增加一次编译（几十秒）以及 node-gyp 对固定版本头文件的校验和下载——与安装步骤相同的网络要求。该守卫把未来静默的 ABI 破裂变成 staging 阶段指名道姓的响亮失败。

验证史，记录在案：桌面车道在 fork 仓库中 `ci.yml` 被手动禁用后一直没有运行过——re-pin 分支缺失的 CI 运行最初被误诊为 GitHub Actions 事件丢失事故（同日别处的报告症状吻合，close/reopen 与新 head 推送都未产生运行），但 Actions UI 显示该 workflow 只是被禁用了。`gh workflow enable ci.yml` 加一次 close/reopen 产生了此后的第一个运行；四个桌面任务随后全部以本条所述的 ABI 错误失败在 boot 冒烟，验证本修复的正是这条重新启用的车道。
