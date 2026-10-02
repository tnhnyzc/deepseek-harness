# Agent Note: dsh 发布家族排除私有清单

Status: implemented

[English](2026-10-02-release-family-excludes-private-apps.md) | 中文

## 问题

dsh 发布家族按目录模式（`packages/!(experimental)/*/package.json` 与 `apps/*/package.json`）选取成员，不关心清单是否可发布。上游该不变式成立：这些模式选中的每个清单都是可发布的 npm 成员。而本 fork 的桌面应用（`apps/desktop`、`apps/desktop-runtime`）是 `private: true`——它们以打包的 Electron 应用分发，不上 npm——却仍被模式选中。

re-pin 到 `dsh-v0.1.3-alpha.1` 后，这一后果在 PR 预演中浮现。`release:pack` 会打包每一个被选中的成员，并把每个 tarball 对照发布载荷策略（不允许 `src/`、`.js.map`、`.d.ts.map`）校验；没有 `files` 字段的私有应用会打包整棵目录树，从而校验失败。发布时的失败点会转移：`release:verify` 的 `verifyPublishable` 会拒绝携带 `private` 成员的家族，因此即便预演已经转绿，fork 的第一次真正发布仍会从它自己的 tag 上失败。

版本一侧形态相同。bump 脚本的私有跟踪（`privateDshVersions`）只覆盖 `packages/*/*`，因此离开发布集的私有 `apps/*` 应用没有机制与家族版本保持同步。静态 `constraints` 门禁（[工作区版本一致性](2026-09-03-workspace-version-coherence-gate.zh.md)）对每个 dsh 命名的清单强制执行共享版本，漂移终究会被抓住——但只在其落地之后。

## 决策

`ReleaseFamily.members()` 跳过 `private: true` 清单：发布集恰好包含 npm 能接受的对象，dsh 与 vendor 两个家族都从共享方法继承该排除。私有成员并未被逐出发布序列：`bump.ts` 的 `privateDshVersions` 现在同时 glob `apps/*/package.json`，因此 `packages/` 下每个私有 dsh 包与 `apps/` 下每个私有应用都随家族版本升版、不携带 tag，与 `packages/*/*` 下的私有包此前的待遇完全一致。

边界现在与静态门禁一致：根、可发布成员、以及每个私有的 dsh 命名清单，无论位于 `packages/` 还是 `apps/`。

## 曾考虑的替代方案

**给私有应用一个可发布的 `files` 载荷。** `files` 字段能让预演 tarball 通过，但私有清单仍留在发布集中：每次预演都打包它们，而第一次真正发布仍会在 `verifyPublishable` 处停下，迫使决策从 tag 而非 PR 做出。它掩盖了边界，而不是画出边界。

**在家族模式中特例化 fork 的应用目录。** 保持模式与上游同形、再按目录列表（或按桌面应用名）过滤也能工作，但该过滤器会重述已经指明意图的 `private` 字段；一旦某清单不再私有，它会在载荷就绪的那一刻悄悄重新加入发布集，而没有任何门禁会注意到。

## 后果

dsh 家族现在在 `0.1.3-alpha.1` 上报 248 个成员（排除前为 250 个），`release:verify` 无需私有应用即可解析发布顺序。`release:pack` 不再为它们构建或校验 tarball。未来某个应用若变为可发布，移除 `private: true` 即可加入发布序列——无需改动模式、脚本或门禁；它的第一次打包预演会校验其载荷，第一次 `verifyVersions` 运行会校验其版本。`members()` 的改动是对上游脚本的 fork 级编辑；若 re-pin 到未来某个新增了私有应用成员的上游，需要重新套用该排除，且 `families.spec.ts` 中点明两个桌面应用名的断言会在任一应用被改名或变为可发布时立即失败。
