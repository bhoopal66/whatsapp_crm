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
    scheduleJourneyTick()
    scheduleDealRoomReconcile()
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
