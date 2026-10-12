import { NextResponse } from 'next/server';

import {
  requireRole,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  inviteTemplateStatus,
  loadDealRoomSettings,
  parseSettingsInput,
} from '@/lib/deal-rooms/settings';
import { metaChannel } from '@/lib/deal-rooms/shared';
import { ChannelError } from '@/lib/whatsapp/channels';

/**
 * Deal rooms — the account's group-invite template (`deal_room_settings`,
 * migration 088), admin-only. Besides the saved row, the answer says
 * whether a Meta number is connected and whether each named copy is
 * synced from the WABA and APPROVED (the Arabic copy as language `ar`):
 * an invite sent with anything else is refused by Meta.
 */
async function view(ctx: AccountContext) {
  const settings = await loadDealRoomSettings(ctx.supabase, ctx.accountId);
  // The service role, scoped to the caller's account by every query.
  const admin = supabaseAdmin();
  const [meta, template, templateAr] = await Promise.all([
    metaChannel(admin, ctx.accountId),
    settings.inviteTemplateName
      ? inviteTemplateStatus(
          admin,
          ctx.accountId,
          settings.inviteTemplateName,
          settings.inviteTemplateLanguage
        )
      : null,
    settings.inviteTemplateNameAr
      ? inviteTemplateStatus(
          admin,
          ctx.accountId,
          settings.inviteTemplateNameAr,
          'ar'
        )
      : null,
  ]);
  return { settings, metaNumber: meta !== null, template, templateAr };
}

function errorResponse(err: unknown) {
  if (err instanceof ChannelError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return toErrorResponse(err);
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    return NextResponse.json(await view(ctx));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Expected a JSON body' },
        { status: 400 }
      );
    }
    const parsed = parseSettingsInput(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    // The caller's client: RLS lets only an admin of the account write.
    const { error } = await ctx.supabase
      .from('deal_room_settings')
      .upsert(
        { account_id: ctx.accountId, ...parsed.value, updated_by: ctx.userId },
        { onConflict: 'account_id' }
      );
    if (error) {
      console.error('[deal-rooms] settings not saved:', error.message);
      return NextResponse.json(
        { error: 'Could not save the deal room settings' },
        { status: 500 }
      );
    }
    return NextResponse.json(await view(ctx));
  } catch (err) {
    return errorResponse(err);
  }
}
