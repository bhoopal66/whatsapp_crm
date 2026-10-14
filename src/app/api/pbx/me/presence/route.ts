// ============================================================
// PUT /api/pbx/me/presence — set my own status on the PBX, as the
// Linkus app does. { status } → { status }
//
// status is one of Yeastar's six presence values (do_not_disturb is
// DND). The extension is ALWAYS the caller's own (pbx_my_extension(), on
// the caller's client): an extension in the body is never read. The PBX
// takes its own extension id, not the number, so the number is looked
// up first (extension/search), then extension/update is sent with
// presence_status only. The caller's pbx_presence row is then written
// through the event processor's writer (writePresence), so open screens
// move at once rather than when the PBX's 30009 event arrives; an
// extension whose presence_monitor is off keeps no row. That write is
// best-effort: the PBX has already changed, and its event writes the
// same row. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  fail,
  jsonObject,
  myExtension,
  noExtension,
  pbxFailure,
} from '@/lib/pbx/calls';
import { pbxApiFor } from '@/lib/pbx/connection';
import { writePresence } from '@/lib/pbx/process';
import {
  PRESENCE_STATUSES,
  type PresenceStatus,
} from '@/lib/pbx/yeastar/events';

const isPresenceStatus = (v: unknown): v is PresenceStatus =>
  typeof v === 'string' && (PRESENCE_STATUSES as readonly string[]).includes(v);

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const b = await jsonObject(request);
    if (!b) return fail('Invalid JSON body');
    if (!isPresenceStatus(b.status))
      return fail(`status must be one of ${PRESENCE_STATUSES.join(', ')}`);
    const status = b.status;

    const ext = await myExtension(ctx.supabase);
    if (!ext) return noExtension();

    const service = pbxServiceDb();
    const { api } = await pbxApiFor(service, ext.connectionId);
    const found = await api.findExtension(ext.extension);
    if (!found)
      return fail('The phone system does not list your extension', 409, {
        code: 'extension_not_on_pbx',
      });
    await api.setPresence({ id: found.id, status });

    try {
      await writePresence(
        {
          db: service,
          connectionId: ext.connectionId,
          connectionAccountId: ctx.accountId,
        },
        ext.extension,
        { presence: status }
      );
    } catch (err) {
      console.error(
        `[pbx] presence row for ${ext.connectionId}/${ext.extension}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    return NextResponse.json({ status });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
