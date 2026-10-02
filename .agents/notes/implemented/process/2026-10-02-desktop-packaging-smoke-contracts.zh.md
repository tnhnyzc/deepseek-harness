# Agent Note：桌面打包冒烟测试对齐迁移后的契约

Status: implemented

[English](2026-10-02-desktop-packaging-smoke-contracts.md) | 中文

## 问题

re-pin 到 `dsh-v0.1.3-alpha.1` 之后，桌面打包冒烟测试运行在另一份 lockfile 图和另一个 composer 上，两个测试装置自身的假设被产品打破——两种情况里产品本身都是正确的。

**resolution 冒烟按名称锚定冲突消费者。** `buildProbes` 用 `findStagedPackageDirs(runtimeDir, consumer.name)` 定位每个探针的消费者，并取第一个副本，前提是"一个消费者只有一个实例"。alpha.1 的图把 `debug` 变成了同名不同版本冲突（`2.6.9` 与 `4.4.3`），而 staging 正确地按消费者位置各放一份——`compression` 携带 `debug@2.6.9` 及其 `ms@2.0.0` 影子，`express` 携带 `debug@4.4.3` 及其 `ms@2.1.3` 影子。针对 `debug@2.6.9 -> ms@2.0.0` 边的探针锚定在遍历先找到的那个 `debug` 副本上；当它是 `4.4.3` 副本时，遍历解析出 `ms@2.1.3`，与边要求的 `2.0.0` 不符，于是工件在一项其自身 staging 已然满足的检查上失败。

**packaged-app 冒烟用 DOM 变更往 Lexical 里打字。** 载体回合用 `document.execCommand('insertText', ...)` 插入文本，再用合成的 `KeyboardEvent` 提交。面对 release-B 的 Lexical composer，`execCommand` 报告成功，但浏览器的非受控 DOM 变更会被编辑器状态调和掉——composer 保持为空，Enter 什么都没提交，脚本化 provider 收不到请求，canary 超时。插桩证据：`execCommand` 返回 `true`，而 `textContent` 在之前、之后以及 120 秒截止点均为空。

## 决策

**让每个探针锚定在清单版本与该边消费者版本相符的 staged 副本上。** `buildProbes` 现在读取每个 staged `package.json` 并过滤候选目录，保留 `version` 等于消费者版本的副本；探针去重键与按消费者缓存均以 `name@version` 为键，因此冲突消费者的两条边各自从自己的实例出发探针。同版本副本依然可互换（一个实例，一份清单），这是仍然成立的前提。

**经由浏览器输入管线驱动 composer。** 冒烟在页面内聚焦 composer，用 CDP `Input.insertText` 插入回合（浏览器投递受信任的 `beforeinput`，这正是 Lexical 消费的路径），再用 `Input.dispatchKeyEvent` 的 Enter keydown/keyUp 提交（受信任的 keydown，经由 Lexical 的 `KEY_ENTER_COMMAND` 键位图）。回合经打包运行时到达脚本化 provider，canary 渲染出来。

## 曾考虑的备选方案

**把两个失败都当产品回归、去改应用。** staged 树与 composer 都按各自契约行事；失败的是冒烟对自己操作数的假设（哪份副本是"那个"消费者；编辑器消费哪种输入事件）。为迁就过时的测试装置而改产品，会破坏该装置本要守护的契约。

**让 resolution 探针改读 audit 报告里的消费者位置。** audit 报告记录的是图，不是 staged 布局；从它出发探针等于用报告校验报告。冒烟的用途是证明 staged 树的解析方式与 lockfile 图所述一致，所以锚点必须来自 staged 树——并过滤到正确的实例。

**从页面派发合成的 `beforeinput` 而不走 CDP 输入。** 页面派发的 `beforeinput` 不受信任，部分编辑器路径（以及浏览器的默认插入行为）对它的处理与管线事件不同；CDP 输入与浏览器处理真实击键和 IME 上屏的机制相同，因此冒烟走的是用户击键所走的输入路径。

## 后果

两个冒烟均为纯装置改动：不动产品代码、staging 代码或 audit 代码。resolution 冒烟在 re-pin 后的图上、由打包 Node 验证了全部 78 条 staged 边；packaged-app 冒烟在打包工件上完成完整契约——UI 启动、安全基线、原生通道、有界载体回合、零产品监听器、崩溃/重启到新一代——本地 `package` 管线（构建、staging、fuses、布局、归档、四项冒烟）端到端转绿。若未来的图引入探针集未预期的冲突消费者，同一条版本锚定规则即可处理；若未来的 composer 不再消费浏览器输入管线，`Input.insertText` 落不了字会在同一 canary 截止点暴露出来。
