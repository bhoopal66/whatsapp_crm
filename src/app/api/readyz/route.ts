import { supabaseAdmin } from '@/lib/automations/admin-client';

// GET /api/readyz — readiness (package 033c): the database answers a
// one-row read within READY_TIMEOUT_MS. 200 { ok: true }, else 503
// { ok: false }. No session and no detail in the body: the reason is
// logged on the server, never sent to an unauthenticated caller.

const READY_TIMEOUT_MS = 2_000;

export async function GET() {
  let ok = false;
  try {
    const { error } = await supabaseAdmin()
      .from('accounts')
      .select('id', { head: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(READY_TIMEOUT_MS));
    ok = !error;
    if (error)
      console.error(`[readyz] database check failed: ${error.code ?? 'error'}`);
  } catch {
    console.error('[readyz] database check threw');
  }
  return Response.json(
    { ok },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } }
  );
}
