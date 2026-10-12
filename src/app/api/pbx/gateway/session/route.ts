import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  gatewayAuthError,
  gatewayErrorResponse,
  gatewaySession,
} from '@/lib/pbx/gateway';

// POST /api/pbx/gateway/session — the WebSocket gateway's login. Answers
// { connectionId, wsUrl, topics, refreshAfterMs }: the socket URL embeds
// the shared API token (minted or reused server-side), and nothing else
// about the connection's credentials ever leaves the server.

export async function POST(request: Request) {
  const denied = gatewayAuthError(request);
  if (denied) return denied;
  try {
    const session = await gatewaySession(pbxServiceDb());
    return Response.json(session, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return gatewayErrorResponse(err);
  }
}
