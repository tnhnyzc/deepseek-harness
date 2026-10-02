# Agent Note：fork 上无法解释的手动 workflow 禁用（CI、Landlock Run）

Status: unresolved — treated as a GitHub Actions control-plane issue

[English](2026-10-02-fork-ci-workflow-disable-investigation.md) | 中文

## 事件

2026-10-02 当天，`tnhnyzc/deepseek-harness` 上发生三次 `disabled_manually` 状态迁移，均非操作者本人、也非任何已审计自动化所为：

1. `Landlock Run` —— `updated_at 2026-10-02T13:31:31Z`。有运行记录佐证边界：13:21:28Z 推送（head `6beeff49`）时它触发了，13:36:19Z 推送（head `e0b8cbd7`）时它消失了。
2. `CI`（第一次禁用）—— 无精确时间戳（已被覆盖）。运行记录佐证边界：13:50:28Z 推送（head `653504ce`）创建了 CI 运行；15:01:51Z 推送（head `82bf2e10`）未创建 CI 运行，而其余六个兄弟 workflow 全部触发。窗口：(13:50:28, 15:01:51]Z。
3. `CI`（第二次禁用）—— `updated_at 2026-10-02T18:51:30Z`，发生在操作者于约 18:28Z 重新启用该 workflow 之后 23 分钟；该次启用在 18:30:33Z 产生了运行 `37047907732`（保留为"workflow 启用时本身工作正常"的证据）。

## GitHub 侧结论（无施动者信息）

个人账号与个人仓库不存在审计日志 API（两个端点均 404）。未配置任何仓库 webhook。唯一的协作者是所有者（`tnhnyzc`）。上游 `deepseek-ai/deepseek-harness` 的 `CI` 处于 active 且根本没有 `Landlock Run`，因此不存在从父仓库继承或对账的状态。`actions_allowed` / `allowed_actions` 均为 null（默认值）。13:13:29Z 的 `Build PR preview` workflow ID 变化是 `build-preview-cloudflare.yml` 从 PR merge ref 首次注册的正常行为（该文件不在 fork 默认分支上）。

## 已排除的自动化（完整审计）

**Mac（全部 agent 工具）：** 逐 part 审计了 2026-10-02 当天活跃的全部 opencode 会话（完整清单：3 个），并对全部 61,907 条存储 part 做模式检索，未发现任何 `gh workflow disable`、`PATCH/POST .../actions/workflows/<id>/disable` 或 GraphQL workflow 变更。第二次 CI 禁用所在的 18:40–19:05Z 窗口内没有任何 opencode 会话活跃；第一次窗口内活跃的会话在做 release 通道调试（只读 `gh` 命令）与 homelab 维护。Codex CLI 最后一次会话开始于 05:40 UTC（早于所有窗口）。Claude Code 最后活动为 09:48 UTC，无 GitHub workflow 命令。gemini/goose/factory/cursor 当天无活动。`zsh_history` 无任何 workflow 命令。没有 crontab、launchd agent、tmux/screen 会话或运行中的进程触碰 GitHub。仓库内没有任何调用 workflow 状态端点的脚本，fork 也没有 webhook。Mac 上的 `gh` 只有一个账号（`tnhnyzc`，keyring 中的 `gho_` token，带 `repo` + `workflow` 作用域）。

**Homelab：** `services` 上的 `hermes` caretaker agent 是唯一带有 GitHub 技能的 agent，但它没有 `GITHUB_TOKEN`（已查 `.env`、git credential store、config），其四个 cron 任务（05:15/19:30 UTC 计划加 DST 一次性任务）与两个窗口均不相交，当天两个会话审计干净（platform brief：无 GitHub 内容；LLM digest：仅 web 搜索）。`services`、`llmvm`、`control`、`proxmox`、`vm102t`、`pihole` 均无 GitHub token 与相关 crontab。

## 残余盲区

账号下的 GitHub App 安装（用户 token 无法列出；可在 Web UI 的 Applications 中查看）、细粒度 PAT（API 无法列出）、以及使用同一账号的其他设备（homelab 的 Tailscale 上有一台第二台 Mac）。没有证据指向其中任何一项，但从这台机器无法将其排除。

## 处置

按操作者决定：固化证据，将这些迁移视为 GitHub Actions 控制面问题，只重新启用 `ci.yml` 一次，并运行桌面任务。下一次桌面运行验证的是 fs-ext ABI 重建（同目录笔记 `2026-10-02-desktop-packaging-native-abi-rebuild`）。若再发生无法解释的禁用，下一步是在 Web UI 中盘点账号的 GitHub App/PAT；若仍干净，则持上述时间戳联系 GitHub 支持。
