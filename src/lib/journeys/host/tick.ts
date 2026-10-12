/**
 * The journey cron tick: fires due timers and drains files whose head
 * outbox item is due (fairly: `journey_drain_candidates` backs off a
 * failing head), for accounts whose `journey_settings.enabled` is on.
 * Server-only (service-role client). Called by `GET /api/journeys/cron`
 * and, at most once a minute per process, by the automation cron.
 *
 * Timers live in the file (`body.timers`); `journey_files.next_timer_at`
 * is the earliest `fireAt`, kept by journey_commit. A timer fires as a
 * TIMER event whose id is `timer:<kind>:<fireAt>`, so a timer fired twice
 * (two overlapping ticks) is a duplicate the store refuses. The file is
 * reloaded before each timer: firing one can cancel the others.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createRunner } from '../runner';
import type { WorkflowDef } from '../schema';
import { toMs } from '../time';
import { SHIPPED_WORKFLOW } from '../workflow';
import { SupabaseConsentPort } from './consent';
import { createJourneySink, withFailureRecording } from './sink';
import { JourneyDbError, SupabaseJourneyStore } from './store';

/** A workflow's `journey_settings.workflow_key`: `<id>.v<version>` (086's default is the shipped one). */
export const workflowKey = (def: WorkflowDef): string =>
  `${def.id}.v${def.version}`;
export const SHIPPED_WORKFLOW_KEY = workflowKey(SHIPPED_WORKFLOW);

/** At most this many timers fired per file per tick (a guard against a timer that never clears). */
const MAX_TIMERS_PER_FILE = 10;

export interface JourneyTickResult {
  accounts: number;
  timersFired: number;
  filesDrained: number;
  delivered: number;
  dropped: number;
  errors: number;
}

export interface JourneyTickArgs {
  db: SupabaseClient;
  now?: Date;
  /** Files per phase (due timers, files to drain). */
  limit?: number;
  /** Workflow definitions by `journey_settings.workflow_key`; the shipped one by default. */
  workflows?: Record<string, WorkflowDef>;
}

export async function runJourneyTick({
  db,
  now = new Date(),
  limit = 50,
  workflows = { [SHIPPED_WORKFLOW_KEY]: SHIPPED_WORKFLOW },
}: JourneyTickArgs): Promise<JourneyTickResult> {
  const at = now.toISOString();
  const result: JourneyTickResult = {
    accounts: 0,
    timersFired: 0,
    filesDrained: 0,
    delivered: 0,
    dropped: 0,
    errors: 0,
  };

  const { data: settings, error } = await db
    .from('journey_settings')
    .select('account_id, workflow_key')
    .eq('enabled', true);
  if (error) throw new JourneyDbError('journey_settings', error);

  const store = new SupabaseJourneyStore(db);
  const consent = new SupabaseConsentPort(db);
  const runners = new Map<string, ReturnType<typeof createRunner>>();
  const runnerOf = new Map<string, ReturnType<typeof createRunner>>();
  for (const s of (settings ?? []) as {
    account_id: string;
    workflow_key: string;
  }[]) {
    const def = workflows[s.workflow_key];
    if (!def) {
      console.warn(
        `[journeys] account ${s.account_id}: unknown workflow ${s.workflow_key}; not ticked`
      );
      continue;
    }
    let runner = runners.get(s.workflow_key);
    if (!runner) {
      runner = createRunner({
        def,
        store,
        consent,
        sink: withFailureRecording(
          createJourneySink({ db, now: () => now, def }),
          db
        ),
      });
      runners.set(s.workflow_key, runner);
    }
    runnerOf.set(s.account_id, runner);
  }
  const accountIds = [...runnerOf.keys()];
  result.accounts = accountIds.length;
  if (!accountIds.length) return result;

  // 1. Due timers. handle() drains the file after each commit.
  const handled = new Set<string>();
  const { data: due, error: dueErr } = await db
    .from('journey_files')
    .select('id, account_id')
    .in('account_id', accountIds)
    .is('closed_at', null)
    .lte('next_timer_at', at)
    .order('next_timer_at', { ascending: true })
    .limit(limit);
  if (dueErr) throw new JourneyDbError('journey_files', dueErr);
  for (const f of (due ?? []) as { id: string; account_id: string }[]) {
    const runner = runnerOf.get(f.account_id)!;
    handled.add(f.id);
    const tried = new Set<string>();
    try {
      for (let i = 0; i < MAX_TIMERS_PER_FILE; i++) {
        const file = await store.load(f.id);
        const timer = (file?.timers ?? [])
          .filter((t) => toMs(t.fireAt) <= now.getTime())
          .filter((t) => !tried.has(`timer:${t.kind}:${t.fireAt}`))
          .sort((a, b) => toMs(a.fireAt) - toMs(b.fireAt))[0];
        if (!timer) break;
        const id = `timer:${timer.kind}:${timer.fireAt}`;
        tried.add(id);
        const r = await runner.handle(
          {
            type: 'TIMER',
            kind: timer.kind,
            at: timer.fireAt,
            id,
            fileId: f.id,
          },
          at
        );
        if (r.status === 'ok') {
          result.timersFired++;
          result.delivered += r.drain.delivered;
          result.dropped += r.drain.dropped ?? 0;
          if (r.drain.error) throw r.drain.error;
        } else if (r.status === 'rejected')
          console.warn(
            `[journeys] file ${f.id}: timer ${id} rejected: ${r.error.message}`
          );
      }
    } catch (err) {
      result.errors++;
      console.error(
        `[journeys] file ${f.id}: timer tick failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // 2. Files whose head outbox item is due (a quiet-hours SEND and its LOG_COST wait until their not_before), fairly:
  // a head that failed recently is backed off and never-tried heads go first (journey_drain_candidates, 086), so a
  // file stuck on one item cannot hold a slot every tick and starve the others.
  const { data: pending, error: pendErr } = await db.rpc(
    'journey_drain_candidates',
    { p_now: at, p_limit: limit, p_account_ids: accountIds }
  );
  if (pendErr) throw new JourneyDbError('journey_drain_candidates', pendErr);
  for (const o of (pending ?? []) as {
    file_id: string;
    account_id: string;
  }[]) {
    if (handled.has(o.file_id)) continue;
    handled.add(o.file_id);
    // A drain reports a failed delivery as `error`, but it throws when it cannot even read the file's items.
    try {
      const d = await runnerOf.get(o.account_id)!.drain(o.file_id, at);
      result.filesDrained++;
      result.delivered += d.delivered;
      result.dropped += d.dropped ?? 0;
      if (d.error) throw d.error;
    } catch (err) {
      result.errors++;
      console.error(
        `[journeys] file ${o.file_id}: drain stopped:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return result;
}
