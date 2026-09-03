/**
 * Upstream observation (SPEC §30, the non-authoritative track): report how far
 * upstream `deepseek-ai/deepseek-harness` has drifted from the pinned DSH
 * revision and whether the desktop delta still applies, and write a re-pin
 * readiness report.
 *
 * Safety contract — this is a READ-ONLY, NON-AUTHORITATIVE probe:
 * - it fetches upstream into `FETCH_HEAD` only, straight from the canonical
 *   upstream URL recorded in `UPSTREAM.md` (never a developer-local remote, so
 *   it works in a fresh checkout; never a branch, never a tag, never a merge,
 *   never the pinned SHA in `UPSTREAM.md`);
 * - the apply probe runs in a throwaway `git worktree` that is removed before
 *   exit, so the release checkout and branch are never touched;
 * - it ALWAYS exits 0. A fetch failure or an inapplicable delta is reported
 *   (`upstream-needs-adaptation` / `upstream-unknown`), never a build failure.
 *   The release track (authoritative) is `ci.yml` against the pinned SHA; this
 *   track only informs the eventual re-pin (SPEC §30's six-step procedure,
 *   which it never performs).
 *
 * Usage (repository root): `node --import tsx/esm scripts/upstream-observation.ts [report.md]`
 * @module scripts/upstream-observation
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')

type Status = 'upstream-unchanged' | 'upstream-compatible' | 'upstream-needs-adaptation' | 'upstream-unknown'

interface Report {
  generatedAt: string
  pinnedSha: string
  pinnedTag: string
  upstreamSha: string
  status: Status
  note?: string
  commitsAhead: number | null
  pinReachable: boolean | null
  newTags: string[]
  changedPaths: [string, number][]
  deltaCommits: number | null
  deltaApplies: boolean | null
  applyError: string
}

/** A roomy buffer: `git worktree add` prints per-file checkout progress to stderr. */
const GIT_MAX_BUFFER = 128 * 1024 * 1024

/** Run git in the repo root; returns trimmed stdout. Throws on non-zero. */
function git(args: string[], opts: { input?: string; allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, input: opts.input, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER })
  } catch (error) {
    if (opts.allowFail === true) return ''
    throw error
  }
}

/** The pinned revision and the canonical upstream URL are the single source of truth in `UPSTREAM.md`. */
function readPin(): { sha: string; tag: string; repo: string } {
  const text = readFileSync(join(repoRoot, 'UPSTREAM.md'), 'utf8')
  const sha = /Upstream SHA:\s*`([0-9a-f]{40})`/.exec(text)?.[1]
  const tag = /Release tag:\s*`([^`]+)`/.exec(text)?.[1]
  const repo = /Upstream repository:\s*`([^`]+)`/.exec(text)?.[1]
  if (sha === undefined || tag === undefined || repo === undefined) {
    throw new Error('UPSTREAM.md did not expose the pinned SHA/tag/repo')
  }
  return { sha, tag, repo }
}

/** Top-level `<group>/<pkg>` histogram of the files a range changed. */
function changedPaths(from: string, to: string): [string, number][] {
  const names = git(['diff', '--name-only', from, to], { allowFail: true }).split('\n').filter(Boolean)
  const counts = new Map<string, number>()
  for (const name of names) {
    const parts = name.split('/')
    const key = parts.length > 1 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? '')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

/**
 * Does the desktop delta (pin → fork head) still apply on a throwaway checkout
 * of upstream master? Runs in an isolated worktree that is removed before
 * return; the release branch and working tree are never touched.
 */
function probeDeltaApplies(upstreamSha: string, pinnedSha: string): { applies: boolean; error: string } {
  const worktree = mkdtempSync(join(tmpdir(), 'dsh-upstream-obs-'))
  try {
    git(['worktree', 'add', '--detach', worktree, upstreamSha])
    const delta = git(['diff', pinnedSha, 'HEAD'])
    try {
      execFileSync('git', ['apply', '--check'], { cwd: worktree, input: delta, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER })
      return { applies: true, error: '' }
    } catch (error) {
      const out = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`
      const lines = out.split('\n').filter(line => line.trim() !== '').slice(0, 15)
      return { applies: false, error: lines.length > 0 ? lines.join('\n') : 'git apply --check failed with no diagnostic' }
    }
  } finally {
    git(['worktree', 'remove', '--force', worktree], { allowFail: true })
    rmSync(worktree, { recursive: true, force: true })
  }
}

function observe(): Report {
  const pin = readPin()
  const base: Report = {
    generatedAt: new Date().toISOString(),
    pinnedSha: pin.sha,
    pinnedTag: pin.tag,
    upstreamSha: '',
    status: 'upstream-unknown',
    commitsAhead: null,
    pinReachable: null,
    newTags: [],
    changedPaths: [],
    deltaCommits: null,
    deltaApplies: null,
    applyError: '',
  }
  // Read-only fetch into FETCH_HEAD only, straight from the canonical upstream
  // URL (no developer-local remote, so a fresh checkout works the same).
  try {
    git(['fetch', pin.repo, 'master', '--no-tags'])
  } catch (error) {
    base.note = `upstream fetch failed (read-only observation, non-blocking): ${error instanceof Error ? error.message : String(error)}`
    return base
  }
  const upstreamSha = git(['rev-parse', 'FETCH_HEAD']).trim()
  base.upstreamSha = upstreamSha
  base.commitsAhead = Number(git(['rev-list', '--count', `${pin.sha}..${upstreamSha}`]).trim())
  let reachable = false
  try {
    git(['merge-base', '--is-ancestor', pin.sha, upstreamSha])
    reachable = true
  } catch {
    reachable = false
  }
  base.pinReachable = reachable
  // Tags whose commit is a descendant of the pin (candidate newer releases).
  const tags = git(['tag', '--merged', upstreamSha], { allowFail: true }).split('\n').filter(tag => tag !== '')
  base.newTags = tags.filter((tag) => {
    if (tag === pin.tag) return false
    try {
      git(['merge-base', '--is-ancestor', pin.sha, `${tag}^{commit}`])
      return true
    } catch {
      return false
    }
  })
  base.changedPaths = changedPaths(pin.sha, upstreamSha)
  base.deltaCommits = Number(git(['rev-list', '--count', `${pin.sha}..HEAD`]).trim())

  if (base.commitsAhead === 0) {
    base.status = 'upstream-unchanged'
    base.note = 'upstream master is still the pinned revision; nothing to observe'
    return base
  }
  const probe = probeDeltaApplies(upstreamSha, pin.sha)
  base.deltaApplies = probe.applies
  base.applyError = probe.error
  base.status = probe.applies ? 'upstream-compatible' : 'upstream-needs-adaptation'
  base.note = probe.applies
    ? 'the desktop delta applies cleanly on upstream master (run the full re-pin procedure before changing the pin)'
    : 'the desktop delta does not apply cleanly on upstream master (upstream changed files the delta touches); adaptation required before a re-pin'
  return base
}

function render(report: Report): string {
  const lines: string[] = []
  lines.push('# Upstream Observation Report', '')
  lines.push(`- Generated: ${report.generatedAt}`)
  lines.push(`- Pinned: \`${report.pinnedSha}\` (tag \`${report.pinnedTag}\`)`)
  lines.push(`- Upstream master: \`${report.upstreamSha || '(fetch failed)'}\``)
  lines.push(`- **Status: \`${report.status}\`**`)
  if (report.note !== undefined) lines.push('', `> ${report.note}`, '')
  if (report.status !== 'upstream-unknown') {
    lines.push('## Drift', '')
    lines.push(`- Commits upstream advanced since the pin: ${String(report.commitsAhead)}`)
    lines.push(`- Pinned SHA reachable on upstream master: ${String(report.pinReachable)}`)
    lines.push(`- Newer release tags since the pin: ${report.newTags.length > 0 ? report.newTags.map(t => `\`${t}\``).join(', ') : '(none)'}`)
    lines.push(`- Desktop delta: ${String(report.deltaCommits)} commits (pin → fork head)`, '')
    lines.push('Changed top-level paths (pin → upstream master):', '')
    for (const [path, count] of report.changedPaths) lines.push(`- \`${path}\` (${String(count)})`)
    lines.push('')
    lines.push('## Desktop delta application', '')
    lines.push(`- Applies cleanly on upstream master: ${String(report.deltaApplies)}`)
    if (report.deltaApplies === false && report.applyError !== '') {
      lines.push('`git apply --check` diagnostic (first lines):', '')
      lines.push('```text')
      lines.push(report.applyError)
      lines.push('```')
    }
  }
  lines.push('', '## Re-pin readiness checklist (SPEC §30 — run in order, never auto-merge)', '')
  lines.push('1. Select the new upstream SHA (a release tag is preferred).')
  lines.push('2. Inspect upstream architectural changes (the drift above).')
  lines.push('3. Update `apps/desktop/docs/upstream-contract.md`.')
  lines.push('4. Run the full authoritative suite against the new SHA (release track).')
  lines.push('5. Manually test the agent / tool / approval / question flows.')
  lines.push('6. Only then change the pinned SHA in `UPSTREAM.md`.', '')
  return lines.join('\n')
}

function main(): void {
  const outPath = process.argv[2] ?? join(repoRoot, 'upstream-observation-report.md')
  let report: Report
  try {
    report = observe()
  } catch (error) {
    report = {
      generatedAt: new Date().toISOString(), pinnedSha: '(unparsed)', pinnedTag: '(unparsed)', upstreamSha: '',
      status: 'upstream-unknown', note: `observation aborted (non-blocking): ${error instanceof Error ? error.message : String(error)}`,
      commitsAhead: null, pinReachable: null, newTags: [], changedPaths: [], deltaCommits: null, deltaApplies: null, applyError: '',
    }
  }
  const rendered = render(report)
  writeFileSync(outPath, rendered)
  process.stdout.write(`${report.status}\n${rendered}\n`)
  // Observation never fails the build: the status is in the report, not the exit code.
  process.exit(0)
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
