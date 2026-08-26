/**
 * Persisted projection cache (`ctx.sessionProjectionCache`): durable
 * checkpoints of every client-visible or explicitly persisted projection unit's state, one record per
 * session on the domain data form (`session_projcache` domain — the shipped
 * json backend lands it beside `workspace.json`). The cache is a fold
 * shortcut, never an authority: a row is possibly stale (its `seq`
 * says how stale) but never wrong, so every write path is fail-soft (a lost
 * write costs a longer tail replay on the next cold read) and a
 * `ver` mismatch discards the row instead of migrating it. Design
 * authority: the session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
// Empty type import: applies the package's cordis Context merge
// (`ctx.sessionPersistence`), which this service reads on the cold path.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionCheckpoint, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { projectionCacheDomainSpec } from './spec.ts'
import type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

export { checkpointIdentity, checkpointRecord, checkpointRow, projectionCacheDomainSpec } from './spec.ts'
export type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the two mandatory write points (`turn/end` and session
 * disposal) are policy, not tunables, and always fire.
 */
export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
})

/** Per-session write-behind bookkeeping (live sessions only; dropped at retire). */
interface DirtyState {
  /** Committed events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The persisted projection cache service. Opens the `session_projcache`
 * domain at init, checkpoints live sessions on a throttled write-behind
 * (count/interval triggers from {@link Config}) plus two mandatory points —
 * `turn/end` and session disposal (the live-to-cold moment) — and serves the
 * cold-read ladder: cached row, persistence `readFrom` tail, registry
 * `restore`, durable write-back. Every durable write is fail-soft: failures
 * log a warning and the cache self-heals on the next write or cold read.
 * Plugin disposal drains the write-behind: it settles in-flight writes and
 * durably flushes every still-dirty session, so a clean shutdown never
 * leaves the final checkpoint (for example a rename after the last write)
 * un-written and the cold list serving a stale row.
 */
export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessionPersistence', 'sessions']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, CheckpointRecord>
  private readonly dirty = new Map<Session, DirtyState>()
  /** In-flight fail-soft checkpoint writes that disposal must settle. */
  private readonly inFlight = new Set<Promise<void>>()
  /** Per-session tail of the durable write chain (a session absent is clean). */
  private readonly writeTails = new Map<Session, Promise<void>>()
  /** Settles the facility close deferral when the disposal drain finishes (its `finally`). */
  private disposalSettled?: () => void

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
  }

  /** Open the domain and install the write-behind listeners. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.table = domain.table('sessions')
    // The facility unmounts concurrently with this plugin's drain and would
    // otherwise close the domain under it: defer its close until the drain
    // settles (settled in the drain's `finally`, so a drain failure cannot
    // stall the facility's unmount).
    const settled = new Promise<void>((resolve) => { this.disposalSettled = resolve })
    domain.deferClose(settled)
    this.installWritePath(domain)
  }

  /**
   * The stored record for one session, accepted only when its bound log
   * identity matches `expected`. A session id names a slot, not a lifecycle:
   * a recreated id or a persistence store swapped under a surviving cache
   * must not let an old record seed state folded from an unrelated log.
   * Synchronous from the domain's in-memory state.
   * @param id - the session whose record is read.
   * @param expected - the log identity the caller holds (live or stored header).
   * @returns the identity-matching record, or `undefined` (absent or unrelated).
   */
  private recordFor(id: SessionId, expected: CheckpointIdentity): CheckpointRecord | undefined {
    const record = this.requireTable().get(id)
    if (record === undefined) return undefined
    return identityMatches(record.identity, expected) ? record : undefined
  }

  /**
   * The zero-I/O listing read: whole values viewed straight from the stored
   * rows (version-matching keys only), each cut carried with its watermark
   * so a client value store can seed under its higher-seq-wins rule — as
   * stale as the last durable checkpoint but never wrong, and never from an
   * unrelated log (the caller's header is the identity witness). Fresher
   * paths (the history tail baseline, {@link coldSnapshot}) supersede these
   * values whenever a session is actually opened.
   * @param meta - the listed session's header (identity witness; no log read).
   * @returns the cut (`asOfSeq` = lowest served-row watermark), or
   *   `undefined` when no usable row exists for this lifecycle.
   */
  cachedSnapshot(meta: SessionHeader): ProjectionSnapshot | undefined {
    const record = this.recordFor(meta.id, identityOf(meta))
    if (record === undefined) return undefined
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows)
    const keys = Object.keys(values)
    if (keys.length === 0) return undefined
    // The block carries ONE cut: the lowest served watermark is the seq every
    // value is at least current as of (under-claiming is safe under
    // higher-seq-wins; over-claiming would let a stale value outrank pushes).
    const asOfSeq = Math.min(...keys.map(key => (record.rows[key] as { seq: number }).seq))
    return { asOfSeq, values }
  }

  /**
   * Durably checkpoint one live session NOW (both mandatory points call
   * this; tests and carriers may too). The registry cut is snapshotted at
   * this boundary (states are live references — a checkpoint taken later,
   * after teardown retires the units' registrations, would fold stale or
   * partial state), then the store pass is queued on the session's write
   * chain so concurrent stores land in the order their cuts were taken and a
   * slow older cut can never clobber a newer one. NOT fail-soft — callers on
   * the fail-soft paths contain it.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability and event emission.
   */
  write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    return this.queueWrite(session, () => this.storeAfterBarrier(session, rows))
  }

  /**
   * One write-chain slot: the durability barrier, then the whole-record store.
   * @param session - the session whose store is serialized on its chain.
   * @param rows - The cut snapshotted at the {@link write} boundary.
   * @returns resolution after durability and event emission.
   */
  private async storeAfterBarrier(session: Session, rows: ProjectionCheckpoint): Promise<void> {
    // Durability barrier: the checkpoint cut was taken before this slot, so
    // flushing AFTER it guarantees every event inside the cut is durably
    // logged before the cache row lands — a crash can leave the cache behind
    // the log (longer tail replay) but never ahead of it (phantom values
    // folded from events no stored log contains). At detach the store entry
    // is already gone; persistence's own retirement drain covers that path
    // and any residual overreach is caught by the cold read's anchored floor.
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
    await this.put(session.id, identityOf(session.header), rows)
  }

  /**
   * Cold-read one persisted session's projections with zero full-log load:
   * cached rows + a persistence `readFrom` tail from the registry's restore
   * floor, refolded by the registry and written back (fail-soft) so the next
   * cold read starts closer. A cache row invalidated by a shrunk log
   * (crash-repair truncation) triggers one full re-read from seq 0 — the
   * ladder's slow rung, still no crash. Rejects when the session has no
   * persisted log (`not found` from the persistence seam).
   * @param id - the persisted session to read.
   * @param signal - optional cancellation for the persistence reads.
   * @returns the snapshot cut at the stored log end.
   */
  async coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<ProjectionSnapshot> {
    const record = this.requireTable().get(id)
    const cached = record?.rows ?? {}
    const floor = this.ctx.sessionProjections.restoreFloor(cached)
    const persistence = this.ctx.sessionPersistence
    if (floor === undefined) {
      // No unit registered: nothing to fold, but the not-found contract must
      // hold in this topology too — the probe read rejects for an absent log
      // and dates the empty cut for a present one.
      const probe = await persistence.readFrom(id, 0, signal)
      return { asOfSeq: probe.events.at(-1)?.seq ?? -1, values: {} }
    }
    let restored: { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint }
    const tail = await persistence.readFrom(id, floor, signal)
    // The tail's stored header is the identity witness: a record bound to a
    // different lifecycle (recreated id, swapped store) is discarded whole
    // before any of its rows can seed a fold.
    const related = record === undefined || identityMatches(record.identity, identityOf(tail.meta))
    try {
      if (!related) throw new Error('unrelated log identity')
      restored = this.ctx.sessionProjections.restore(cached, tail.events, floor)
    } catch {
      // Recoverable failures are an unrelated record, a row outside the
      // supplied suffix or log end, and stateSchema rejection. The full read
      // removes every checkpoint seed and lets each unit refold from init.
      const whole = await persistence.readFrom(id, 0, signal)
      restored = this.ctx.sessionProjections.restore({}, whole.events, 0)
    }
    await this.putSoft(id, identityOf(tail.meta), restored.checkpoint, 'cold-read write-back')
    return restored.snapshot
  }

  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(domain: Domain<typeof projectionCacheDomainSpec>): void {
    // One disposer: a fiber tears its effects down in parallel, so the drain
    // and the domain close must be a single unit — the drain writes through
    // the domain, so it has to finish before the close lands. A clean
    // shutdown must leave every committed event's projection state durably
    // checkpointed: the mandatory detach write is fire-and-forget from its
    // listener, so without this drain a rename after the last checkpoint
    // would stay un-written and the cold list would serve a stale row.
    const disposeEvent = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        this.track(this.flushSoft(session, 'turn/end'))
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        this.track(this.flushSoft(session, 'count threshold'))
        return
      }
      state.timer ??= setTimeout(() => {
        this.track(this.flushSoft(session, 'interval'))
      }, this.config.writeIntervalMs)
    })

    // Detach (the live-to-cold moment): the second mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // The listener cannot await, so the write is tracked: the disposal drain
    // settles it before shutdown completes. flushSoft's synchronous prefix
    // reads and resets the dirty state, so dropping it right after is safe.
    const disposeDisposed = this.ctx.on('session/disposed', (session: Session) => {
      this.track(this.flushSoft(session, 'detach'))
      this.markClean(session)
      this.dirty.delete(session)
    })

    this.ctx.effect(() => async () => {
      try {
        // Close admission FIRST, in this disposer: effects on one fiber tear
        // down concurrently, so the listener disposers cannot be relied on to
        // run ahead of this drain. Once admission is closed, `inFlight` is a
        // complete set — a detach write from an already-dispatching store
        // lands in it synchronously and the settle loop below still catches
        // it — and no newer dirty state or write can appear.
        disposeEvent()
        disposeDisposed()
        for (const state of this.dirty.values()) {
          if (state.timer !== undefined) clearTimeout(state.timer)
        }
        while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
        for (const [session, state] of this.dirty) {
          if (state.pending > 0) this.track(this.flushSoft(session, 'disposal drain'))
        }
        while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
        this.dirty.clear()
        await domain.close()
      } finally {
        this.disposalSettled?.()
      }
    }, 'sessionProjectionCache.disposal')
  }

  /** Retain one fail-soft write until settlement so disposal can settle it. */
  private track(run: Promise<void>): void {
    this.inFlight.add(run)
    const forget = (): void => { this.inFlight.delete(run) }
    void run.then(forget, forget)
  }

  /**
   * Queue one checkpoint-and-store pass behind this session's prior passes.
   * A checkpoint's cut is taken at its chain slot, so passes land in the
   * order they were queued: a slow older cut (one that stalled on its
   * durability barrier) can never overwrite a newer one. A failed pass still
   * lets the next one run — the cache self-heals on the next write.
   * @param session - the session whose passes serialize.
   * @param run - One checkpoint-and-store pass.
   * @returns the pass's own settlement (rejections propagate to the caller;
   *   the chain itself moves on).
   */
  private queueWrite(session: Session, run: () => Promise<void>): Promise<void> {
    const previous = this.writeTails.get(session) ?? Promise.resolve()
    const result = previous.then(run, run)
    const tail = result.then(() => undefined, () => undefined)
    this.writeTails.set(session, tail)
    void tail.then(() => {
      if (this.writeTails.get(session) === tail) this.writeTails.delete(session)
    })
    return result
  }

  /**
   * One fail-soft durable checkpoint. Every caller has work by construction:
   * the throttle triggers only fire dirty (markClean clears the timer with
   * the counter) and the two mandatory points write unconditionally.
   */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  /** Reset one session's dirty bookkeeping (its checkpoint is being written). */
  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /** Replace one session's stored record with its log identity and a detached snapshot of `rows`. */
  private async put(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint): Promise<void> {
    const detached = snapshotJsonValue(rows)
    if (detached === undefined) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    await this.requireTable().put(id, { identity, rows: detached as CheckpointRecord['rows'] })
  }

  /** Fail-soft {@link put}: cache writes must never fail their caller's read or event path. */
  private async putSoft(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint, what: string): Promise<void> {
    try {
      await this.put(id, identity, rows)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${what} for "${id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  private requireTable(): KvTable<SessionId, CheckpointRecord> {
    /* v8 ignore next -- Service.init assigns the table before the service becomes injectable */
    if (this.table === undefined) throw new Error('session projection cache is not initialized')
    return this.table
  }
}

/** Project a header onto the identity fields a record is bound to. */
function identityOf(header: SessionHeader): CheckpointIdentity {
  return { createdAt: header.createdAt, ...header.cwd === undefined ? {} : { cwd: header.cwd } }
}

/** Whether a stored record's bound identity names the caller's lifecycle. */
function identityMatches(stored: CheckpointIdentity, expected: CheckpointIdentity): boolean {
  return stored.createdAt === expected.createdAt && stored.cwd === expected.cwd
}

export default SessionProjectionCache
