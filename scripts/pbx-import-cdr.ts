/**
 * Import a Yeastar PBX's past call records (CDR) into `calls`: the calls
 * made before the live webhook was connected.
 *
 *   npx tsx scripts/pbx-import-cdr.ts --from <ISO> --to <ISO> \
 *     [--connection <id>] [--apply]
 *
 *   (default)  dry run: totals and per-extension figures, writes nothing.
 *   --apply    ingests each remaining record as its 30012 frame
 *              (`ingestPbxEvent` with `historical: true`): stored and
 *              deduped by hash in pbx_events_raw like any event, the calls
 *              row written as a live end writes it (legs merged, contact,
 *              routing, recording state, user), but no missed-call task,
 *              no bell, no call-back settled, no screen pop, and the
 *              connection's event clock left alone.
 *
 * The window is at most 24 hours and may not end in the future. Every
 * call id that already has a calls row is skipped: the live webhook owns
 * it, and a CDR leg need not key-match its webhook twin. The connection
 * is --connection, else PBX_CONNECTION_ID, else the only one.
 *
 * Reads `.env.local` (Supabase URL, service-role key, ENCRYPTION_KEY for
 * the PBX secret). encryption.ts reads ENCRYPTION_KEY at module load and
 * static imports are hoisted above any code, so everything that reaches
 * it is imported dynamically, after the env is loaded. Tokens, secrets
 * and payloads are never printed.
 */
import { config as loadEnv } from 'dotenv';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { CdrRecord } from '../src/lib/pbx/yeastar/api';

const USAGE = `usage: npx tsx scripts/pbx-import-cdr.ts --from <ISO> --to <ISO> [--connection <id>] [--apply]

  --from, --to    the window (at most 24 hours, not ending in the future)
  --connection    pbx_connections.id (default: PBX_CONNECTION_ID, else the only one)
  (no --apply)    dry run: totals per window and per extension, write nothing
  --apply         import the calls not yet in the CRM, without tasks or bells
  --help          this text`;

const PAGE_SIZE = 1000;
const CHUNK = 100;

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

interface Args {
  from: string;
  to: string;
  connection?: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const out: Partial<Args> = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--from' || a === '--to' || a === '--connection') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return `${a} needs a value`;
      out[a.slice(2) as 'from' | 'to' | 'connection'] = v;
    } else return `unknown argument: ${a}`;
  }
  if (!out.from) return '--from is required';
  if (!out.to) return '--to is required';
  return out as Args;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(`${args}\n\n${USAGE}`);
    process.exit(2);
  }

  loadEnv({ path: '.env.local' });
  const { importWindowError, planCdrImport } =
    await import('../src/lib/pbx/cdr-import');
  const from = new Date(args.from);
  const to = new Date(args.to);
  const refused = importWindowError(from, to, new Date());
  if (refused) {
    console.error(`${refused}\n\n${USAGE}`);
    process.exit(2);
  }

  const url =
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      'NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_INTERNAL_URL) and SUPABASE_SERVICE_ROLE_KEY are required'
    );
    process.exit(2);
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY is required (to read the PBX secret)');
    process.exit(2);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const { pbxApiFor } = await import('../src/lib/pbx/connection');
  const { cdrRecordToEventFrame, gatewayConnectionId, recordBackfill } =
    await import('../src/lib/pbx/gateway');
  const { ingestPbxEvent } = await import('../src/lib/pbx/process');
  const { CDR_MAX_PAGE_SIZE } = await import('../src/lib/pbx/yeastar/api');

  const db: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  });
  const connectionId = args.connection ?? (await gatewayConnectionId(db));

  // 1. The window's CDR, page by page (as backfillCdr reads it).
  const { api } = await pbxApiFor(db, connectionId);
  const pageSize = Math.min(PAGE_SIZE, CDR_MAX_PAGE_SIZE);
  const rows: CdrRecord[] = [];
  for (let page = 1; ; page++) {
    const { total, records } = await api.searchCdr({
      startTime: from,
      endTime: to,
      page,
      pageSize,
    });
    rows.push(...records);
    if (records.length < pageSize || rows.length >= total) break;
  }

  // 2. Which of its calls the CRM already has.
  const callIds = [
    ...new Set(
      rows
        .map((r) => r.call_id)
        .filter((c): c is string => typeof c === 'string' && c !== '')
    ),
  ];
  const existing = new Set<string>();
  for (const part of chunks(callIds, CHUNK)) {
    const { data, error } = await db
      .from('calls')
      .select('pbx_call_id')
      .eq('connection_id', connectionId)
      .in('pbx_call_id', part);
    if (error) {
      console.error('calls read failed:', error.message);
      process.exit(1);
    }
    for (const r of (data ?? []) as { pbx_call_id: string }[]) {
      existing.add(r.pbx_call_id);
    }
  }

  // 3. The plan.
  const plan = planCdrImport(rows, existing);
  console.log(
    `connection ${connectionId}, ${from.toISOString()} .. ${to.toISOString()}`
  );
  console.log(`CDR rows:                  ${plan.rows}`);
  console.log(`  identical repeats:       ${plan.rows - plan.distinctRows}`);
  console.log(`  unparsed:                ${plan.unparsed}`);
  console.log(`distinct calls:            ${plan.calls}`);
  console.log(`already in CRM (skipped):  ${plan.existing.length}`);
  console.log(
    `to import:                 ${plan.importCalls.length} calls, ${plan.toImport.length} records`
  );
  const exts = [...plan.perExtension].sort(([a], [b]) => a.localeCompare(b));
  if (exts.length) {
    console.log('\nextension   calls  answered  talk min');
    for (const [ext, t] of exts) {
      console.log(
        `${ext.padEnd(10)} ${String(t.calls).padStart(6)} ${String(t.answered).padStart(9)} ${(t.talkSeconds / 60).toFixed(1).padStart(9)}`
      );
    }
  }
  if (!args.apply) {
    console.log('\ndry run: nothing written (--apply to import)');
    return;
  }

  // 4. Ingest, quietly: no task, bell, call-back or screen pop.
  const result = {
    connectionId,
    from: from.toISOString(),
    to: to.toISOString(),
    records: plan.toImport.length,
    ingested: 0,
    duplicates: 0,
    failed: 0,
  };
  for (const record of plan.toImport) {
    const res = await ingestPbxEvent({
      db,
      connectionId,
      payload: cdrRecordToEventFrame(record),
      historical: true,
    });
    if (res.duplicate) result.duplicates++;
    else if (res.error) {
      result.failed++;
      console.error(`call ${String(record.call_id)}: ${res.error}`);
    } else result.ingested++;
  }
  await recordBackfill(db, result);
  console.log(
    `\ningested ${result.ingested}, duplicates ${result.duplicates}, failed ${result.failed}`
  );
  if (result.failed) process.exit(1);
}

// Only run when invoked directly.
if (process.argv[1] && /pbx-import-cdr\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
