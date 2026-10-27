/**
 * Repair `calls` rows stored before the PBX's several end-of-call records
 * were merged (`src/lib/pbx/call-legs.ts`): the last record used to win,
 * so a trailing FAILED hid a no-answer, a voicemail leg moved the start,
 * and a transfer's answering person was lost.
 *
 *   npx tsx scripts/pbx-repair-call-legs.ts [--apply]
 *
 * Replays every stored 30012 (`pbx_events_raw`) per (connection, call id)
 * through the same merge ingest uses, and compares with the calls row.
 *
 *   (default)  dry run: one line per call that would change, then totals.
 *   --apply    writes status, talk/ring seconds, started/ended/answered
 *              times, extension, user_id (only when NULL), pbx_uid and
 *              meta.cdr_legs, each guarded by the row's updated_at; a row
 *              changed meanwhile is skipped and counted.
 *
 * Never creates or closes tasks, rings bells or touches recordings. Open
 * missed-call tasks whose call now merges to answered are listed as
 * "would be wrong, left alone" for a person to close. Payloads, tokens
 * and secrets are never printed.
 *
 * Reads `.env.local` for the Supabase URL and service-role key.
 */
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { planCallRepair, type RepairRow } from '../src/lib/pbx/call-repair';
import {
  parseYeastarEvent,
  type CallEndEvent,
} from '../src/lib/pbx/yeastar/events';

loadEnv({ path: '.env.local' });

const USAGE = `usage: npx tsx scripts/pbx-repair-call-legs.ts [--apply]

  (no flag)  dry run: list calls that would change, write nothing
  --apply    write the repaired rows (guarded by updated_at)
  --help     this text`;

const PAGE = 1000;
const CHUNK = 100;

type Row = Record<string, unknown>;

const COLUMNS =
  'id, account_id, connection_id, pbx_call_id, direction, status, talk_seconds, ring_seconds, started_at, ended_at, answered_at, extension, user_id, pbx_uid, meta, updated_at';

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const unknown = args.filter((a) => a !== '--apply');
  if (unknown.length) {
    console.error(`unknown argument: ${unknown[0]}\n\n${USAGE}`);
    process.exit(2);
  }
  const apply = args.includes('--apply');

  const url =
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      'NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_INTERNAL_URL) and SUPABASE_SERVICE_ROLE_KEY are required'
    );
    process.exit(2);
  }
  const db: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  });

  // 1. Every stored end event, grouped by (connection, call id).
  const groups = new Map<
    string,
    { connection: string; callId: string; events: CallEndEvent[] }
  >();
  let scanned = 0;
  let lastId: number | string = 0;
  for (;;) {
    const { data, error } = await db
      .from('pbx_events_raw')
      .select('id, connection_id, event_type, payload, received_at')
      .eq('event_type', 30012)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (error) {
      console.error('pbx_events_raw read failed:', error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as Row[];
    for (const r of rows) {
      scanned++;
      lastId = r.id as number | string;
      const payload = r.payload;
      if (
        typeof payload !== 'string' &&
        (typeof payload !== 'object' || payload === null)
      )
        continue;
      const parsed = parseYeastarEvent(payload as string | object);
      if (!parsed.ok || parsed.event.kind !== 'call_end') continue;
      const connection = String(r.connection_id);
      const gk = `${connection}\u0000${parsed.event.callId}`;
      const g = groups.get(gk) ?? {
        connection,
        callId: parsed.event.callId,
        events: [],
      };
      g.events.push(parsed.event);
      groups.set(gk, g);
    }
    if (rows.length < PAGE) break;
  }

  // 2. The calls rows and the extensions of each connection.
  const byConnection = new Map<string, string[]>();
  for (const g of groups.values()) {
    byConnection.set(g.connection, [
      ...(byConnection.get(g.connection) ?? []),
      g.callId,
    ]);
  }
  const calls = new Map<string, Row>();
  const extensions = new Map<string, Map<string, { user_id: string | null }>>();
  for (const [connection, callIds] of byConnection) {
    for (const part of chunks(callIds, CHUNK)) {
      const { data, error } = await db
        .from('calls')
        .select(COLUMNS)
        .eq('connection_id', connection)
        .in('pbx_call_id', part);
      if (error) {
        console.error('calls read failed:', error.message);
        process.exit(1);
      }
      for (const r of (data ?? []) as Row[]) {
        calls.set(`${connection}\u0000${String(r.pbx_call_id)}`, r);
      }
    }
    const ext = await db
      .from('pbx_extensions')
      .select('extension, account_id, user_id')
      .eq('connection_id', connection);
    if (ext.error) {
      console.error('pbx_extensions read failed:', ext.error.message);
      process.exit(1);
    }
    for (const e of (ext.data ?? []) as Row[]) {
      const k = `${connection}\u0000${String(e.account_id)}`;
      const m = extensions.get(k) ?? new Map();
      m.set(String(e.extension), {
        user_id: (e.user_id as string | null) ?? null,
      });
      extensions.set(k, m);
    }
  }

  // 3. Plan each call.
  let noRow = 0;
  let unchanged = 0;
  const changing: {
    row: Row;
    plan: NonNullable<ReturnType<typeof planCallRepair>>;
  }[] = [];
  for (const [gk, g] of groups) {
    const row = calls.get(gk);
    if (!row) {
      noRow++;
      continue;
    }
    const exts =
      extensions.get(`${g.connection}\u0000${String(row.account_id)}`) ??
      new Map();
    const plan = planCallRepair(row as unknown as RepairRow, g.events, exts);
    if (!plan || !plan.changed) unchanged++;
    else changing.push({ row, plan });
  }

  const show = (v: string | number | null) => (v === null ? '-' : String(v));
  for (const { row, plan } of changing) {
    const c = plan.changes;
    const parts = (Object.keys(c) as (keyof typeof c)[]).map(
      (k) => `${k} ${show(c[k].from)} -> ${show(c[k].to)}`
    );
    console.log(`${String(row.pbx_call_id)}: ${parts.join('; ')}`);
  }

  // 4. Open missed-call tasks the repair would contradict. Read only.
  const wrong: Row[] = [];
  const answeredIds = changing
    .filter((c) => c.plan.answered)
    .map((c) => String(c.row.id));
  for (const part of chunks(answeredIds, CHUNK)) {
    const { data, error } = await db
      .from('tasks')
      .select('id, source_ref')
      .eq('source', 'pbx')
      .eq('kind', 'missed_call')
      .eq('status', 'open')
      .in(
        'source_ref',
        part.map((id) => `call:${id}`)
      );
    if (error) {
      console.error('tasks read failed:', error.message);
      process.exit(1);
    }
    wrong.push(...((data ?? []) as Row[]));
  }

  // 5. Write, guarded by updated_at.
  let applied = 0;
  let raced = 0;
  if (apply) {
    for (const { row, plan } of changing) {
      const { data, error } = await db
        .from('calls')
        .update(plan.patch)
        .eq('id', String(row.id))
        .eq('updated_at', String(row.updated_at))
        .select('id');
      if (error) {
        console.error(
          `update failed for ${String(row.pbx_call_id)}:`,
          error.message
        );
        process.exit(1);
      }
      if (((data ?? []) as unknown[]).length) applied++;
      else raced++;
    }
  }

  console.log('');
  console.log(`end events scanned:        ${scanned}`);
  console.log(`calls with end events:     ${groups.size}`);
  console.log(`no calls row (skipped):    ${noRow}`);
  console.log(`already correct:           ${unchanged}`);
  console.log(`would change:              ${changing.length}`);
  if (apply) {
    console.log(`updated:                   ${applied}`);
    console.log(`changed meanwhile, skipped: ${raced}`);
  } else {
    console.log('dry run: nothing written; pass --apply to write');
  }
  if (wrong.length) {
    console.log('');
    console.log(
      `open missed-call tasks whose call now merges to answered (would be wrong, left alone): ${wrong.length}`
    );
    for (const t of wrong)
      console.log(`  task ${String(t.id)} (${String(t.source_ref)})`);
  }
}

// Only run when invoked directly.
if (process.argv[1] && /pbx-repair-call-legs\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
