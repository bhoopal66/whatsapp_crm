// GET /api/healthz — liveness (package 033c): the process is up and
// serving. No session, no database, nothing in the body worth reading,
// so a load balancer or Docker can poll it as often as it likes.
// Readiness (the database answers) is GET /api/readyz.

export function GET() {
  return Response.json(
    { ok: true },
    { headers: { 'cache-control': 'no-store' } }
  );
}
