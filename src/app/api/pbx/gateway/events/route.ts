import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  gatewayAuthError,
  gatewayConnectionId,
  gatewayErrorResponse,
} from '@/lib/pbx/gateway';
import { ingestPbxEvent } from '@/lib/pbx/process';

// POST /api/pbx/gateway/events — one raw text frame from the Yeastar
// socket, as the body. Processed before answering (unlike the webhook):
// the gateway retries until it gets a 2xx, and the processor's dedupe
// makes a retried frame land once. A frame the processor cannot read is
// still a 200: it is stored with its error, and retrying cannot help.

export const maxDuration = 60;

export async function POST(request: Request) {
  const denied = gatewayAuthError(request);
  if (denied) return denied;
  const db = pbxServiceDb();
  let connectionId: string;
  try {
    connectionId = await gatewayConnectionId(db);
  } catch (err) {
    return gatewayErrorResponse(err);
  }
  const frame = await request.text();
  const result = await ingestPbxEvent({ db, connectionId, payload: frame });
  if (result.error?.startsWith('event not stored')) {
    return Response.json({ error: 'Temporarily unavailable' }, { status: 503 });
  }
  return Response.json({
    ok: true,
    duplicate: result.duplicate,
    ...(result.error ? { error: result.error } : {}),
  });
}
