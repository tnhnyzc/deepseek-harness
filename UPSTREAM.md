# Upstream Pin

This repository is the desktop fork of
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(fork: [tnhnyzc/deepseek-harness](https://github.com/tnhnyzc/deepseek-harness)).
The desktop delta is the diff between the pinned SHA below and the desktop
release commit. See `ARCHITECTURE.md` and `SPEC.md`.

## Pinned revision

- Upstream repository: `https://github.com/deepseek-ai/deepseek-harness`
- Upstream SHA: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Release tag: `dsh-v0.1.1-rc.2`
- Pinned: 2026-08-22
- The SHA was the live `master` HEAD at pin time (verified with
  `git ls-remote`).

## Toolchain at pin

| Item | Value |
| --- | --- |
| Root package | `@deepseek-ai/dsh-root@0.1.1-rc.2` |
| Node engine requirement | `^22.19.0 \|\| >=24.0.0` |
| Node used for pin verification | `v22.23.2` |
| pnpm pin (`packageManager`) | `pnpm@11.7.0` |
| pnpm used for pin verification | `11.7.0` |

## Baseline status at pin

- `pnpm install --frozen-lockfile`: pass (lockfile unchanged). Two benign
  WARNs link unbuilt demo bins (`dsh-jsonrpc-agent`, `dsh-acp-demo`);
  `pnpm run build` resolves them.
- `pnpm run build`: pass at the pinned SHA.
- Upstream tests: not yet run at the pin. Stage 0 task 0.2 records them via
  `pnpm run test`, `pnpm run test:gui`, and `pnpm run check:ci`.

## Desktop patches

None. No upstream source file is modified by desktop commits yet. Any
later upstream modification is recorded here and in the commit message.

## Known incompatibilities

None known.
