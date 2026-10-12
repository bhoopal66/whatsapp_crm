// ============================================================
// POST /api/pbx/connection/test — one cheap authenticated call
// (`testConnection`), recorded as the connection's status:
// connected / auth_failed / disconnected, plus last_error.
//
// Never retried: five failed logins in a row get this server's IP
// blocked by the PBX. A refused credential or a blocked IP also sets
// backoff_until, which every process honours (pbxApiFor) until it
// passes or the credentials are changed. Admin+.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { ownConnection, pbxServiceDb } from '@/lib/pbx/admin';
import {
  PBX_AUTH_BACKOFF_MS,
  PbxConnectionError,
  pbxApiFor,
} from '@/lib/pbx/connection';
import { YeastarError } from '@/lib/pbx/yeastar';

async function record(
  db: SupabaseClient,
  id: string,
  status: 'connected' | 'auth_failed' | 'disconnected',
  lastError: string | null,
  backoffUntil: string | null | undefined
) {
  await db
    .from('pbx_connections')
    .update({ status, last_error: lastError })
    .eq('id', id);
  if (backoffUntil !== undefined) {
    await db
      .from('pbx_connection_secrets')
      .update({ backoff_until: backoffUntil })
      .eq('connection_id', id);
  }
}

export async function POST() {
  try {
    const ctx = await requireRole('admin');
    const db = pbxServiceDb();
    const conn = await ownConnection(db, ctx.accountId);
    if (!conn) {
      return NextResponse.json(
        { error: 'No PBX connection is configured' },
        { status: 404 }
      );
    }
    try {
      const { api } = await pbxApiFor(db, conn.id);
      const { extensionCount } = await api.testConnection();
      await record(db, conn.id, 'connected', null, null);
      return NextResponse.json({
        status: 'connected',
        lastError: null,
        extensionCount,
      });
    } catch (err) {
      if (err instanceof PbxConnectionError) {
        if (err.code === 'auth_backoff') {
          return NextResponse.json(
            {
              error:
                'The PBX refused these credentials a few minutes ago. Correct them, or wait before testing again.',
            },
            { status: 429 }
          );
        }
        return NextResponse.json(
          {
            error:
              'The PBX credentials are incomplete or unreadable. Save them again.',
          },
          { status: 409 }
        );
      }
      if (!(err instanceof YeastarError)) throw err;
      const refused = err.isAuthFailure || err.isIpBlocked;
      const status = refused ? 'auth_failed' : 'disconnected';
      await record(
        db,
        conn.id,
        status,
        err.message,
        refused
          ? new Date(Date.now() + PBX_AUTH_BACKOFF_MS).toISOString()
          : undefined
      );
      return NextResponse.json({ status, lastError: err.message });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
