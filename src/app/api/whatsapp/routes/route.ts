import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  ROUTING_SURFACES,
  isRoutingSurface,
  loadChannels,
  primaryChannel,
  ChannelError,
  type RoutingSurface,
} from '@/lib/whatsapp/channels';

/**
 * The admin-level routing selector: which connected number sends what.
 *
 * An account can hold a Whapi channel (conversational — free-form
 * replies, no 24-hour window) and a Meta Cloud API number (marketing —
 * approved templates on the official business platform) at the same
 * time. This endpoint backs the Settings → WhatsApp screen where an
 * admin points each surface at one of them.
 *
 * A surface with no row falls back to the account's primary channel, so
 * an install that never touches this behaves exactly as a
 * single-channel one did.
 *
 * Note that two surfaces are advisory rather than absolute: `inbox` and
 * `api` reply on whichever number the customer last wrote to, and fall
 * back to their configured route only for a thread with no inbound
 * history. Replying to someone from a number they never contacted is
 * both confusing and, on Meta, outside the service window. The bot
 * surfaces (`broadcast`, `automation`, `flow`, `ai_reply`) always obey
 * the route — that is the point of routing marketing to Meta.
 */

/** Human-readable purpose per surface, shown next to each selector. */
const SURFACE_DESCRIPTIONS: Record<RoutingSurface, string> = {
  inbox: 'Replies an agent types in the shared inbox',
  broadcast: 'Campaigns sent to many contacts at once',
  automation: 'Keyword, tag, and scheduled automation steps',
  flow: 'Conversational flow nodes',
  ai_reply: 'AI auto-reply drafts sent to the customer',
  api: 'Messages sent through the public /api/v1 endpoints',
};

/** Surfaces that follow the customer's channel before consulting a route. */
const FOLLOWS_CONVERSATION: RoutingSurface[] = ['inbox', 'api'];

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const channels = await loadChannels(supabase, accountId);
    const fallback = primaryChannel(channels);

    const { data: routes, error } = await supabase
      .from('whatsapp_routes')
      .select('surface, config_id')
      .eq('account_id', accountId);

    if (error) {
      console.error('[whatsapp/routes] load failed:', error);
      return NextResponse.json(
        { error: 'Failed to load routing' },
        { status: 500 }
      );
    }

    const bySurface = new Map(
      (routes ?? []).map((r) => [r.surface as string, r.config_id as string])
    );

    return NextResponse.json({
      // Credentials are stripped — this is the browser-facing shape.
      channels: channels.map((c) => ({
        id: c.id,
        provider: c.provider,
        label: c.label,
        phone_number_id: c.phoneNumberId,
        waba_id: c.wabaId,
        is_primary: c.isPrimary,
        status: c.status,
      })),
      routes: ROUTING_SURFACES.map((surface) => {
        const explicit = bySurface.get(surface) ?? null;
        return {
          surface,
          description: SURFACE_DESCRIPTIONS[surface],
          /** null means "inherit the primary channel". */
          config_id: explicit,
          /** What will actually be used right now. */
          effective_config_id: explicit ?? fallback?.id ?? null,
          follows_conversation: FOLLOWS_CONVERSATION.includes(surface),
        };
      }),
    });
  } catch (error) {
    if (error instanceof ChannelError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    return toErrorResponse(error);
  }
}

/**
 * Set (or clear) the channel for one or more surfaces.
 *
 * Body: `{ routes: { [surface]: config_id | null } }`, where null means
 * "inherit the primary". Partial updates are fine — surfaces the body
 * does not mention are left alone.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const body = (await request.json()) as {
      routes?: Record<string, string | null>;
      /** Optionally move the account fallback to another channel. */
      primary_config_id?: string;
    };
    const requested = body.routes ?? {};
    if (typeof requested !== 'object') {
      return NextResponse.json(
        {
          error: 'Body must be { routes: { <surface>: <channel id or null> } }',
        },
        { status: 400 }
      );
    }

    const channels = await loadChannels(supabase, accountId);
    const validIds = new Set(channels.map((c) => c.id));

    if (body.primary_config_id !== undefined) {
      if (!validIds.has(body.primary_config_id)) {
        return NextResponse.json(
          {
            error: `No connected WhatsApp channel with id "${body.primary_config_id}".`,
          },
          { status: 400 }
        );
      }
      // Two statements, and the order matters: migration 046 enforces at
      // most one primary per account with a partial unique index, so
      // promoting before demoting trips the constraint.
      const { error: demoteError } = await supabase
        .from('whatsapp_config')
        .update({ is_primary: false })
        .eq('account_id', accountId)
        .neq('id', body.primary_config_id);
      if (demoteError) {
        console.error('[whatsapp/routes] demote failed:', demoteError);
        return NextResponse.json(
          { error: 'Failed to update routing' },
          { status: 500 }
        );
      }

      const { error: promoteError } = await supabase
        .from('whatsapp_config')
        .update({ is_primary: true })
        .eq('id', body.primary_config_id)
        .eq('account_id', accountId);
      if (promoteError) {
        console.error('[whatsapp/routes] promote failed:', promoteError);
        return NextResponse.json(
          { error: 'Failed to update routing' },
          { status: 500 }
        );
      }
    }

    // Validate everything before writing anything, so a typo in one
    // surface cannot leave the routing half-applied.
    const toSet: Array<{ surface: RoutingSurface; configId: string }> = [];
    const toClear: RoutingSurface[] = [];

    for (const [surface, configId] of Object.entries(requested)) {
      if (!isRoutingSurface(surface)) {
        return NextResponse.json(
          { error: `Unknown surface "${surface}".` },
          { status: 400 }
        );
      }
      if (configId === null) {
        toClear.push(surface);
        continue;
      }
      if (typeof configId !== 'string' || !validIds.has(configId)) {
        return NextResponse.json(
          { error: `No connected WhatsApp channel with id "${configId}".` },
          { status: 400 }
        );
      }
      toSet.push({ surface, configId });
    }

    if (toClear.length > 0) {
      const { error } = await supabase
        .from('whatsapp_routes')
        .delete()
        .eq('account_id', accountId)
        .in('surface', toClear);
      if (error) {
        console.error('[whatsapp/routes] clear failed:', error);
        return NextResponse.json(
          { error: 'Failed to update routing' },
          { status: 500 }
        );
      }
    }

    if (toSet.length > 0) {
      // UNIQUE(account_id, surface) makes this an idempotent upsert —
      // re-pointing a surface replaces its row rather than adding one.
      const { error } = await supabase.from('whatsapp_routes').upsert(
        toSet.map(({ surface, configId }) => ({
          account_id: accountId,
          surface,
          config_id: configId,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'account_id,surface' }
      );
      if (error) {
        console.error('[whatsapp/routes] upsert failed:', error);
        return NextResponse.json(
          { error: 'Failed to update routing' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      updated: toSet.length + toClear.length,
    });
  } catch (error) {
    if (error instanceof ChannelError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    return toErrorResponse(error);
  }
}
