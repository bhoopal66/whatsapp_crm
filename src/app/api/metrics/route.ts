import { supabaseAdmin } from '@/lib/automations/admin-client';
import { bearerMatches, metricsToken } from '@/lib/metrics/auth';
import { collectOutbox, readOutboxStats } from '@/lib/metrics/outbox';
import { collectPosture, startupPosture } from '@/lib/metrics/posture';
import { collectProcess } from '@/lib/metrics/process';
import { edgeRefusals, metricsRegistry } from '@/lib/metrics/registry';

// GET /api/metrics — Prometheus text format 0.0.4 (packages 033f-g).
// `Authorization: Bearer METRICS_TOKEN` (at least 32 characters). Unset:
// 501 not_configured. Missing or wrong: 401 unauthorized. No session.
//
// Per process: the process gauges, edge refusal counters (since start),
// the HR automated-message queue (migration 228; `wacrm_outbox_stats_up 0`
// when it cannot be read within 2 s) and which optional integrations are
// configured. Never a customer, an id or a value of a secret.
//
// docs/monitoring.md is the operator contract.

const refuse = (status: number, error: string) =>
  Response.json(
    { error },
    { status, headers: { 'cache-control': 'no-store' } }
  );

export async function GET(request: Request) {
  const token = metricsToken();
  if (!token) return refuse(501, 'not_configured');
  if (!bearerMatches(request.headers.get('authorization'), token)) {
    return refuse(401, 'unauthorized');
  }

  const registry = metricsRegistry();
  // Registered up front so the family shows (empty) before the first refusal.
  edgeRefusals();
  collectProcess(registry);
  collectPosture(registry, startupPosture());
  let stats = null;
  try {
    stats = await readOutboxStats(supabaseAdmin());
  } catch {
    stats = null;
  }
  collectOutbox(registry, stats);

  return new Response(registry.render(), {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
