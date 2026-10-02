# Agent Note: Unexplained manual workflow disables on the fork (CI, Landlock Run)

Status: implemented

English | [中文](2026-10-02-fork-ci-workflow-disable-investigation.zh.md)

## Problem

Three `disabled_manually` transitions on `tnhnyzc/deepseek-harness` on 2026-10-02 — none performed by the operator or by any audited automation — disabled the two workflows that gate the desktop re-pin lane:

1. `Landlock Run` — `updated_at 2026-10-02T13:31:31Z`. Bound by run evidence: it fired on the 13:21:28Z push (head `6beeff49`) and was absent from the 13:36:19Z push (head `e0b8cbd7`).
2. `CI` (first disable) — no exact timestamp (overwritten). Bound by run evidence: a CI run was created on the 13:50:28Z push (head `653504ce`); no CI run was created on the 15:01:51Z push (head `82bf2e10`) while all six sibling workflows fired. Window: (13:50:28, 15:01:51]Z.
3. `CI` (second disable) — `updated_at 2026-10-02T18:51:30Z`, 23 minutes after the operator re-enabled the workflow at ~18:28Z, which had produced run `37047907732` at 18:30:33Z (preserved as evidence that the workflow itself works when enabled).

While disabled, pushes created no CI run at all, so the desktop platform matrix — the re-pin's acceptance evidence — had no run until `ci.yml` was re-enabled.

## Investigation

### GitHub-side findings (no actor exposed)

No audit-log API exists for personal accounts or personal repos (both endpoints 404). No repository webhooks are configured. The only collaborator is the owner (`tnhnyzc`). Upstream `deepseek-ai/deepseek-harness` has `CI` active and no `Landlock Run` at all, so there is no parent state being inherited or reconciled. `actions_allowed` / `allowed_actions` are null (defaults). The `Build PR preview` workflow ID change at 13:13:29Z was the normal first registration of `build-preview-cloudflare.yml` from the PR merge ref (the file is not on the fork's default branch).

### Exonerated automation (complete audit)

**Mac (all agent tools):** every opencode session active on 2026-10-02 (exhaustive list: three) was audited part-by-part, and a pattern search over all 61,907 stored parts found no `gh workflow disable`, no `PATCH/POST .../actions/workflows/<id>/disable`, and no GraphQL workflow mutation anywhere. No opencode session was active at all during the 18:40–19:05Z window of the second CI disable; during the first window the active sessions were doing release-lane debugging (read-only `gh` commands) and homelab maintenance. Codex CLI's last session started 05:40 UTC (before every window). Claude Code's last activity was 09:48 UTC with no GitHub workflow commands. gemini/goose/factory/cursor show no activity today. `zsh_history` contains no workflow commands. No crontab, launchd agent, tmux/screen session, or running process touches GitHub. The repository contains no script invoking workflow-state endpoints, and the fork has no webhooks. `gh` on the Mac holds a single account (`tnhnyzc`, keyring `gho_` token with `repo` + `workflow` scopes).

**Homelab:** the `hermes` caretaker agent on `services` is the only agent with GitHub skills, but it holds no `GITHUB_TOKEN` (checked `.env`, git credential store, config), its four cron jobs (05:15/19:30 UTC schedules plus DST one-shots) do not intersect either window, and its two sessions of the day were audited clean (platform brief: no GitHub content; LLM digest: web search only). `services`, `llmvm`, `control`, `proxmox`, `vm102t`, and `pihole` show no GitHub tokens and no relevant crontabs.

### Residual blind spots

GitHub App installations on the account (not listable with a user token; checkable in the Web UI under Applications), fine-grained PATs (not listable via API), and other devices using the account (a second Mac is on Tailscale in the homelab). No evidence implicates any of them, but they cannot be cleared from this machine.

## Decision

The transitions are treated as a GitHub Actions control-plane issue: the full audit exonerates every local agent, automation, and script; no actor is exposed by the GitHub API surface available to a personal repo; and no evidence implicates a credential. `ci.yml` was re-enabled exactly once (~20:00Z), producing run `37057856641` (head `91489b15`), whose four desktop jobs passed. If a further unexplained disable occurs, the next step is the account's GitHub App/PAT inventory in the Web UI and, if still clean, contacting GitHub support with the timestamps above.

## Alternatives considered

- **Attribute the disables to a Mac agent session or local automation.** Lost: the part-level audit of all three opencode sessions of the day (61,907 parts) plus the Codex/Claude/gemini/goose/factory/cursor/zsh/cron/launchd/tmux surface are all clean, and no session was even active during the second-disable window.
- **Attribute them to homelab automation.** Lost: the only GitHub-capable homelab agent (`hermes`) holds no GitHub token and its cron schedule does not intersect either window; the six checked homelab hosts hold no GitHub tokens.
- **Attribute them to upstream reconciliation or a webhook.** Lost: upstream has no `Landlock Run` at all and an active `CI` (nothing to reconcile from), and the fork configures no webhooks.
- **Treat it as a credential compromise and rotate.** Lost on evidence — no audited automation or session used the credential for a workflow mutation; it stays the escalation path if another unexplained disable occurs (Web-UI app/PAT inventory, then GitHub support).

## Consequences

What it cost: the desktop platform-matrix evidence was delayed within the re-pin day (the release lane was dark from the first disable until the ~20:00Z re-enable), and a residual blind spot (GitHub App installations, fine-grained PATs, other devices) that cannot be cleared from this machine remains open. What it bought: a complete evidence record — run-fire/no-run boundaries, exact `updated_at` timestamps, the preserved evidence run `37047907732` — sufficient for a GitHub support case, plus the exonerated-automation baseline a future disable can be diffed against.
