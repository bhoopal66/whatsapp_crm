// GET /api/desk/settings — desk WhatsApp routing (migration 230):
// `{ settings, numbers }` (numbers = this workspace's company WhatsApp
// numbers, for an admin to mark as desk numbers). Staff.
// PUT — `{ routingEnabled, deskChannelIds, escalateMinutes,
// expectedUpdatedAt }`, owners and admins; answers `{ ok, updatedAt }`:
// routing is off until switched on here. `expectedUpdatedAt` is the
// `updatedAt` the card loaded (null: nothing stored); another stored
// version, or no key, is 409 SETTINGS_CHANGED (316).
import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  DeskBadRequest,
  deskErrorResponse,
  expectedVersion,
  readJson,
  requireUuid,
} from '@/lib/desk/http';
import { DeskStore, DeskStoreError } from '@/lib/desk/store';
import { supabaseAdmin } from '@/lib/submission-groups/server';

export async function GET() {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const admin = supabaseAdmin();
    const settings = await new DeskStore(admin).settings(
      ctx.userId,
      ctx.accountId
    );
    const { data, error } = await admin
      .from('whatsapp_config')
      .select('id, provider, label, waba_id, is_personal')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true });
    // A failed read is not "no numbers".
    if (error) throw new DeskStoreError('whatsapp_config', error.code ?? null);
    const numbers = (
      (data ?? []) as {
        id: string;
        provider: string;
        label: string | null;
        waba_id: string | null;
        is_personal: boolean | null;
      }[]
    )
      .filter((n) => !n.is_personal)
      .map((n) => ({
        id: n.id,
        label:
          n.label || (n.provider === 'meta' ? 'Cloud API' : n.waba_id) || n.id,
      }));
    return NextResponse.json({ settings, numbers });
  } catch (err) {
    return deskErrorResponse(err, 'settings');
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const body = await readJson(request);
    if (typeof body.routingEnabled !== 'boolean')
      throw new DeskBadRequest('routingEnabled must be true or false');
    if (!Array.isArray(body.deskChannelIds) || body.deskChannelIds.length > 20)
      throw new DeskBadRequest('deskChannelIds must be a list');
    const ids = body.deskChannelIds.map((v) =>
      requireUuid(v, 'deskChannelIds')
    );
    const minutes = body.escalateMinutes;
    if (
      typeof minutes !== 'number' ||
      !Number.isInteger(minutes) ||
      minutes < 15 ||
      minutes > 1440
    )
      throw new DeskBadRequest('escalateMinutes must be 15 to 1440');
    const updatedAt = await new DeskStore(supabaseAdmin()).setSettings(
      ctx.userId,
      ctx.accountId,
      {
        routingEnabled: body.routingEnabled,
        deskChannelIds: ids,
        escalateMinutes: minutes,
        expectedUpdatedAt: expectedVersion(body),
      }
    );
    return NextResponse.json({ ok: true, updatedAt });
  } catch (err) {
    return deskErrorResponse(err, 'settings save');
  }
}
