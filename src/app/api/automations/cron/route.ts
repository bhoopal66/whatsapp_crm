import { timingSafeEqual } from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import {
  everyInterval,
  runChannelHealthCheck,
} from '@/lib/whatsapp/channel-health'
import { runTeamActivityAlertSweep } from '@/lib/team-activity/alert-sweep'
import { runJourneyTick } from '@/lib/journeys/host/tick'
import { reconcileCreatingRooms } from '@/lib/deal-rooms/reconcile'
import { runSubmissionGroupsCron } from '@/lib/submission-groups/cron'
import { evaluateCaseSla, sweepCaseGroupEnds } from '@/lib/cases/cron'
import { caseSlaStore, caseStore } from '@/lib/cases/server'
import { memoryStore } from '@/lib/memory/server'
import { runPbxCron } from '@/lib/pbx/housekeeping'
import { runChatFileSweep } from '@/lib/chat/file-cleanup'
import { dispatchPush } from '@/lib/push/dispatch'
import { runRecurringReminders } from '@/lib/calendar/reminders'
import { ConfirmationGate } from '@/lib/assist/confirm'
import { RateLimiter } from '@/lib/assist/rate'

/**
 * The channel health sweep rides along on this cron, at most once per
 * 5 minutes per process. It has its own endpoint
 * (/api/whatsapp/health/cron), but the production server's crontab
 * already pings this one every minute and cannot be changed yet, so
 * without this the monitor would never run there. Once the pinger calls
 * the dedicated path this is merely redundant: a transition is written
 * conditionally, so two overlapping sweeps do not both alert for it.
 */
const healthCheckDue = everyInterval(5 * 60_000)

function scheduleChannelHealthCheck() {
  try {
    if (!healthCheckDue()) return
    // after(): the response (and the automation work before it) never
    // waits on up to a minute of gateway probes, and the sweep is
    // awaited inside the callback so the runtime does not cut it off.
    after(async () => {
      try {
        const summary = await runChannelHealthCheck(supabaseAdmin())
        if (summary.changed > 0 || summary.failed > 0) {
          console.log('[automations-cron] channel health:', summary)
        }
      } catch (err) {
        console.error(
          '[automations-cron] channel health sweep failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the channel health sweep:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * The Team activity alert sweep (migration 068) rides along the same
 * way: at most once per 5 minutes per process, inside after(). It
 * alerts once per person or number per day, so an overlapping run
 * changes nothing.
 */
const teamActivitySweepDue = everyInterval(5 * 60_000)

function scheduleTeamActivitySweep() {
  try {
    if (!teamActivitySweepDue()) return
    after(async () => {
      const summary = await runTeamActivityAlertSweep(supabaseAdmin())
      if (summary && summary.alerts > 0) {
        console.log('[automations-cron] team activity alerts:', summary)
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the team activity sweep:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Team-chat files no live message carries (migration 087's
 * chat_orphan_files: a deleted or erased message's file the delete route
 * did not reach, or an upload never posted, older than 24 hours) are
 * removed with the service role. At most once per 15 minutes per
 * process, inside after(), at most 500 per run; failures are only
 * logged: such a file is already unreadable, the next run retries it.
 */
const chatFileSweepDue = everyInterval(15 * 60_000)

function scheduleChatFileSweep() {
  try {
    if (!chatFileSweepDue()) return
    after(async () => {
      try {
        const summary = await runChatFileSweep(supabaseAdmin())
        if (summary.failed.length > 0) {
          console.error(
            `[automations-cron] chat file sweep left ${summary.failed.length} of ${summary.found} file(s):`,
            summary.failed,
          )
        } else if (summary.found > 0) {
          console.log('[automations-cron] chat file sweep removed', summary.deleted)
        }
      } catch (err) {
        console.error(
          '[automations-cron] chat file sweep failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the chat file sweep:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Module 017a's edge stores (migration 084: replay claims, rate-limit
 * windows, lockouts) only grow; `edge_purge()` deletes what has expired.
 * At most once per 15 minutes per process, inside after(), and a failure
 * is only logged: an unpurged row is dead weight, never a wrong answer.
 */
const edgePurgeDue = everyInterval(15 * 60_000)

function scheduleEdgePurge() {
  try {
    if (!edgePurgeDue()) return
    after(async () => {
      try {
        const { error } = await supabaseAdmin().rpc('edge_purge')
        if (error) throw new Error(error.message)
      } catch (err) {
        console.error(
          '[automations-cron] edge purge failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the edge purge:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * The journey bot's tick (migration 086): due timers and due outbox
 * items. `GET /api/journeys/cron` is its own endpoint; this runs it at
 * most once a minute per process, inside after(), so an install that
 * pings only this cron is covered. A failure is only logged.
 */
const journeyTickDue = everyInterval(60_000)

function scheduleJourneyTick() {
  try {
    if (!journeyTickDue()) return
    after(async () => {
      try {
        await runJourneyTick({ db: supabaseAdmin() })
      } catch (err) {
        console.error(
          '[automations-cron] journey tick failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the journey tick:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * The deal-room reconcile (module 014c, migration 088): rooms still
 * `creating` after 2 minutes. `GET /api/deal-rooms/cron` is its own
 * endpoint; this runs it at most every 2 minutes per process, inside
 * after(), so an install that pings only this cron is covered. A
 * failure is only logged.
 */
const dealRoomReconcileDue = everyInterval(2 * 60_000)

function scheduleDealRoomReconcile() {
  try {
    if (!dealRoomReconcileDue()) return
    after(async () => {
      try {
        await reconcileCreatingRooms(supabaseAdmin())
      } catch (err) {
        console.error(
          '[automations-cron] deal room reconcile failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the deal room reconcile:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Submission groups (module 018a, migration 115): stale pending sends
 * settled failed, pending WhatsApp group creates finished and failed or
 * deferred closes retried, at most every 2 minutes per process, inside
 * after(). runSubmissionGroupsCron never throws; a failure is only logged.
 */
const submissionGroupsDue = everyInterval(2 * 60_000)

function scheduleSubmissionGroups() {
  try {
    if (!submissionGroupsDue()) return
    after(async () => {
      try {
        const r = await runSubmissionGroupsCron(supabaseAdmin())
        if (r.errors.length > 0) {
          console.error('[automations-cron] submission groups:', r.errors)
        }
      } catch (err) {
        console.error(
          '[automations-cron] submission groups failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule submission groups:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Cases (module 018c, migrations 122-124): the SLA job (case_sla_evaluate
 * over every running timer) and the group-end sweeper (final-stage cases
 * whose submission-group end never completed, each ended through its own
 * account's service), each at most every 5 minutes per process, inside
 * after(). The sweeper starts no case after 20 s. A failure is only logged.
 */
const caseSlaDue = everyInterval(5 * 60_000)
const caseGroupEndDue = everyInterval(5 * 60_000)
const CASE_GROUP_END_DEADLINE_MS = 20_000

function scheduleCaseSla() {
  try {
    if (!caseSlaDue()) return
    after(async () => {
      try {
        await evaluateCaseSla({ store: caseSlaStore() })
      } catch (err) {
        console.error(
          '[automations-cron] case SLA failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the case SLA job:',
      err instanceof Error ? err.message : err,
    )
  }
}

function scheduleCaseGroupEnds() {
  try {
    if (!caseGroupEndDue()) return
    after(async () => {
      try {
        const r = await sweepCaseGroupEnds({
          store: caseStore(),
          storeFor: caseStore,
          deadlineMs: CASE_GROUP_END_DEADLINE_MS,
        })
        const errors = r.results.filter((x) => x.reason === 'ERROR')
        if (errors.length > 0) {
          console.error(
            '[automations-cron] case group ends:',
            errors.map((x) => x.caseId),
          )
        }
      } catch (err) {
        console.error(
          '[automations-cron] case group ends failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the case group ends:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * CRM memory (module 019b, migration 129): memories past their expiry
 * are removed (memory_expire_due, every account) once a day per process,
 * inside after(). A failure is only logged.
 */
const memoryExpiryDue = everyInterval(24 * 60 * 60_000)

function scheduleMemoryExpiry() {
  try {
    if (!memoryExpiryDue()) return
    after(async () => {
      try {
        await memoryStore().expireDue(null)
      } catch (err) {
        console.error(
          '[automations-cron] memory expiry failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the memory expiry:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * The phone system's work (recordings, call-backs, event retries,
 * purge; GET /api/pbx/cron) rides along at most once a minute per
 * process, inside after(). It stops starting work after 45 s, and a
 * failure is only logged.
 */
const pbxCronDue = everyInterval(60_000)

function schedulePbxCron() {
  try {
    if (!pbxCronDue()) return
    after(async () => {
      try {
        const summary = await runPbxCron({ db: supabaseAdmin() })
        if (Object.keys(summary.errors).length > 0) {
          console.error('[automations-cron] pbx:', summary.errors)
        }
      } catch (err) {
        console.error(
          '[automations-cron] pbx run failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the pbx run:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Web push (docs/push.md) rides along at most once a minute per process,
 * inside after(): one dispatch pass over the outbox, then push_purge()
 * trims old rows. It is the fallback for the delivery loop that
 * instrumentation.ts starts in a production server, so an install whose
 * loop is not running still delivers within a minute or so. The outbox
 * claim is a lease, so a pass overlapping the loop sends nothing twice.
 * dispatchPush never throws and does nothing without VAPID keys.
 */
const pushDue = everyInterval(60_000)

function schedulePushDispatch() {
  try {
    if (!pushDue()) return
    after(async () => {
      try {
        const admin = supabaseAdmin()
        const summary = await dispatchPush(admin)
        if (summary.failed > 0) {
          console.error('[automations-cron] push:', summary)
        }
        const { error } = await admin.rpc('push_purge')
        if (error) {
          console.error('[automations-cron] push purge failed:', error.message)
        }
      } catch (err) {
        console.error(
          '[automations-cron] push run failed:',
          err instanceof Error ? err.message : err,
        )
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the push run:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Calendar reminders (migration 108) ride along at most once a minute
 * per process, inside after(): the SQL sweep rings one-off events,
 * meetings and tasks; recurring series are expanded in TS. A failure is
 * only logged, and one half failing still runs the other.
 */
const calendarDue = everyInterval(60_000)

function scheduleCalendarReminders() {
  try {
    if (!calendarDue()) return
    after(async () => {
      try {
        const admin = supabaseAdmin()
        const { error } = await admin.rpc('calendar_reminder_sweep', {
          p_now: new Date().toISOString(),
        })
        if (error) {
          console.error('[calendar] reminder sweep failed', error.message)
        }
        await runRecurringReminders(admin)
      } catch (err) {
        console.error('[calendar] reminder sweep failed', err)
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the calendar reminders:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Assistant safety (module 019a, migration 120): pending and confirmed
 * actions past their expiry are marked expired once a minute, and the
 * rate-limit events older than two of their windows are pruned once an
 * hour, per process, inside after(). Both only tidy up: the SQL checks
 * expiry and the window on every call, so a missed run is never a wrong
 * answer. A failure is only logged.
 */
const assistSweepDue = everyInterval(60_000)
const assistPruneDue = everyInterval(60 * 60_000)

function scheduleAssistHousekeeping() {
  try {
    const sweep = assistSweepDue()
    const prune = assistPruneDue()
    if (!sweep && !prune) return
    after(async () => {
      const admin = supabaseAdmin()
      if (sweep) {
        try {
          await new ConfirmationGate(admin).sweep()
        } catch (err) {
          console.error(
            '[automations-cron] assist pending sweep failed:',
            err instanceof Error ? err.message : err,
          )
        }
      }
      if (prune) {
        try {
          await new RateLimiter(admin).prune()
        } catch (err) {
          console.error(
            '[automations-cron] assist rate prune failed:',
            err instanceof Error ? err.message : err,
          )
        }
      }
    })
  } catch (err) {
    console.error(
      '[automations-cron] could not schedule the assist housekeeping:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    return await drainDueExecutions()
  } finally {
    scheduleChannelHealthCheck()
    scheduleTeamActivitySweep()
    scheduleEdgePurge()
    scheduleChatFileSweep()
    scheduleJourneyTick()
    scheduleDealRoomReconcile()
    scheduleSubmissionGroups()
    scheduleCaseSla()
    scheduleCaseGroupEnds()
    scheduleMemoryExpiry()
    schedulePbxCron()
    schedulePushDispatch()
    scheduleCalendarReminders()
    scheduleAssistHousekeeping()
  }
}

async function drainDueExecutions(): Promise<NextResponse> {
  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed })
}
