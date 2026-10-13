import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  backfillCdr,
  gatewayAuthError,
  gatewayConnectionId,
  gatewayErrorResponse,
  recordBackfill,
} from '@/lib/pbx/gateway';

// POST /api/pbx/gateway/backfill { from, to } — after a reconnect, the
// gateway asks for the gap's call records (ISO times or epoch ms). The
// window is cut to its last 24 hours; each record is ingested as the
// Call End event it would have been. The result is kept on the
// connection for Settings → Phone system (migration 104).

export const maxDuration = 60;

const time = (v: unknown): Date | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function POST(request: Request) {
  const denied = gatewayAuthError(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  const b = (body ?? {}) as { from?: unknown; to?: unknown };
  const from = time(b.from);
  const to = time(b.to);
  if (!from || !to || from >= to) {
    return Response.json(
      { error: 'from and to must be times with from before to' },
      { status: 400 }
    );
  }
  const db = pbxServiceDb();
  try {
    const connectionId = await gatewayConnectionId(db);
    const result = await backfillCdr({ db, connectionId, from, to });
    await recordBackfill(db, result);
    return Response.json(result);
  } catch (err) {
    return gatewayErrorResponse(err);
  }
}
