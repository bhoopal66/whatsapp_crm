import { pickActiveProfile } from '@/lib/auth/active-profile';
import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  MetaError,
  listWabaPhoneNumbers,
  verifyPhoneNumber,
  subscribeWabaToApp,
} from '@/lib/whatsapp/meta-api';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';

/**
 * Connect a Meta WhatsApp Cloud API number, alongside the Whapi channel.
 *
 * Sibling of `/api/whatsapp/config`, which owns the Whapi channel. They
 * are separate routes rather than one polymorphic endpoint because
 * almost nothing about connecting them is shared: Whapi verifies one
 * token and writes a callback URL onto the channel, while Meta needs a
 * (phone number id, WABA id, access token) triple, a subscription on
 * the WABA, and a webhook configured by hand in the App dashboard.
 *
 * ─── The two numbers are necessarily different ────────────────────
 *
 * A Whapi channel pairs to a number that still lives in the WhatsApp
 * app. Registering a number on the Cloud API removes it from the app.
 * So this is never "the same number, two ways" — it is a second,
 * marketing-side number, and the routing selector decides what goes
 * out on which.
 *
 * ─── Column reuse ─────────────────────────────────────────────────
 *
 * `whatsapp_config` was originally shaped around exactly these Meta
 * fields, so for a `provider='meta'` row every column means what its
 * name says again: `phone_number_id` is Meta's, `waba_id` is a real
 * WABA, `verify_token` is the hub.challenge token, and `app_secret`
 * holds the App Secret used to verify inbound webhook signatures.
 * See migration 046.
 */

/** Meta credentials never leave the server; the client only sees these. */
interface SafeChannel {
  connected: boolean;
  phone_number_id?: string;
  waba_id?: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  status?: string;
  subscribed: boolean;
  label?: string | null;
  is_primary?: boolean;
}

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  const { data: rows } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId);
  return (pickActiveProfile(rows)?.account_id as string) ?? null;
}

/** Turn a Graph failure into something an operator can act on. */
function explainMetaError(err: unknown): string {
  if (err instanceof MetaError) {
    if (err.isAuthError) {
      return (
        'Meta rejected the access token. Check it has not expired and that it ' +
        'carries the whatsapp_business_messaging and whatsapp_business_management ' +
        'permissions. A System User token is the durable choice — user tokens expire.'
      );
    }
    if (err.status === 404) {
      return (
        'Meta does not recognise that phone number id. Copy it from ' +
        'WhatsApp → API Setup in the Meta app dashboard — it is a numeric id, ' +
        'not the phone number itself.'
      );
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Unknown error contacting Meta.';
}

/** `…1234` — enough to recognise an id in an error without printing it. */
function tail(id: string): string {
  return `…${id.slice(-4)}`;
}

/** Current state of the account's Meta channel, with no secrets in it. */
export async function GET() {
  try {
    try {
      await requireRole('admin');
    } catch (err) {
      return toErrorResponse(err);
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select(
        'phone_number_id, waba_id, access_token, status, subscribed_apps_at, label, is_primary'
      )
      .eq('account_id', accountId)
      .eq('provider', 'meta')
      .maybeSingle();

    if (!config) {
      return NextResponse.json({
        connected: false,
        subscribed: false,
      } satisfies SafeChannel);
    }

    // Re-verify against Graph so the page shows live state (quality
    // rating, verified name) rather than whatever was true at save time.
    let live: Awaited<ReturnType<typeof verifyPhoneNumber>> | null = null;
    try {
      live = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
      });
    } catch {
      // Token revoked, expired, or Graph unreachable. Fall back to the
      // stored row rather than blanking the whole settings panel.
      live = null;
    }

    return NextResponse.json({
      connected: true,
      phone_number_id: config.phone_number_id,
      waba_id: config.waba_id ?? undefined,
      display_phone_number: live?.display_phone_number,
      verified_name: live?.verified_name,
      quality_rating: live?.quality_rating,
      status: live ? config.status : 'disconnected',
      subscribed: config.subscribed_apps_at != null,
      label: config.label,
      is_primary: config.is_primary,
    } satisfies SafeChannel);
  } catch (error) {
    console.error('[whatsapp/config/meta] GET failed:', error);
    return NextResponse.json(
      { error: 'Failed to load configuration' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    try {
      await requireRole('admin');
    } catch (err) {
      return toErrorResponse(err);
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const body = (await request.json()) as {
      phone_number_id?: string;
      waba_id?: string;
      access_token?: string;
      app_secret?: string;
      verify_token?: string;
      label?: string;
    };

    const phoneNumberId = (body.phone_number_id ?? '').trim();
    const wabaId = (body.waba_id ?? '').trim();
    let accessToken = (body.access_token ?? '').trim();

    if (!phoneNumberId) {
      return NextResponse.json(
        { error: 'A phone number id is required.' },
        { status: 400 }
      );
    }

    // Look the existing row up first: the settings panel shows a masked
    // placeholder rather than the real token, so a re-save sends no
    // token at all and must reuse the stored one instead of erroring.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, access_token, phone_number_id, waba_id')
      .eq('account_id', accountId)
      .eq('provider', 'meta')
      .maybeSingle();

    // One Meta number per account (migration 060's partial unique
    // index). A save naming a DIFFERENT number used to UPDATE the
    // existing row in place — silently re-pointing every route,
    // conversation and approved template tied to the live number, and
    // leaving that number's own inbound to be dropped as unknown. So it
    // is refused, before any Graph call, as is clearing the WABA id.
    // Filling in a WABA id the row never had is still a re-save; the
    // WABA check below covers it.
    //
    // The SAME number under a different WABA is a correction, not a
    // switch: a mistyped WABA id can be stored (a first save whose
    // listing failed), and refusing it left only Disconnect, which drops
    // the number's routes and unlinks its conversations. It goes on to
    // the listing below and is saved only if Meta lists the number
    // under the new WABA.
    const replacedWabaId: string | null =
      existing &&
      existing.phone_number_id === phoneNumberId &&
      existing.waba_id != null &&
      wabaId &&
      existing.waba_id !== wabaId
        ? String(existing.waba_id)
        : null;
    if (
      existing &&
      (existing.phone_number_id !== phoneNumberId ||
        (existing.waba_id != null && !wabaId))
    ) {
      const current =
        `phone number id ${tail(existing.phone_number_id)}` +
        (existing.waba_id ? ` on WABA ${tail(existing.waba_id)}` : '');
      return NextResponse.json(
        {
          error:
            `This account already has a Meta number connected (${current}). ` +
            'Only one is supported — disconnect it first. Disconnecting also ' +
            'removes the routes that point at it, so set them again after ' +
            'connecting the new number.',
        },
        { status: 409 }
      );
    }

    if (!accessToken) {
      if (!existing?.access_token) {
        return NextResponse.json(
          { error: 'An access token is required to connect a Meta number.' },
          { status: 400 }
        );
      }
      try {
        accessToken = decrypt(existing.access_token);
      } catch {
        return NextResponse.json(
          {
            error:
              'The stored access token could not be decrypted (ENCRYPTION_KEY changed). Paste the token again.',
          },
          { status: 400 }
        );
      }
    }

    // Verify BEFORE saving. A bad credential stored as "connected" is
    // the most confusing state to debug later — the same reasoning the
    // Whapi route applies to its token.
    let phoneInfo;
    try {
      phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken });
    } catch (err) {
      return NextResponse.json(
        { error: explainMetaError(err) },
        { status: 400 }
      );
    }

    // A phone number id may only belong to one account — the inbound
    // Meta webhook routes on it, so a duplicate would deliver another
    // account's messages here. UNIQUE enforces this, but checking first
    // gives a comprehensible error instead of a constraint violation.
    // Under the caller's RLS another account's row is invisible, so this
    // only catches what RLS shows; the save below maps the UNIQUE
    // violation itself to the same 409 (`claimedByAnother`).
    const { data: claimed } = await supabase
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .neq('account_id', accountId)
      .maybeSingle();

    if (claimed) return claimedResponse();

    // Subscribe the WABA to this app so Meta actually delivers webhooks.
    // Best-effort: the credentials are still worth saving if it fails
    // (it needs whatsapp_business_management, which a messaging-only
    // token lacks), and the settings panel surfaces the gap.
    //
    // But only a WABA the number provably belongs to. Subscribing is
    // app-wide and nothing here ever undoes it, so a mistyped WABA id
    // would deliver every one of ITS numbers' callbacks to this app for
    // good, to be dropped as unknown. A listing that says "not ours" is
    // a hard 400; a listing that fails (permissions, Graph down) skips
    // the subscription, like a failed subscribe.
    let subscribedAt: string | null = null;
    let subscribeError: string | null = null;
    if (wabaId) {
      let listed: boolean | null = null;
      try {
        const numbers = await listWabaPhoneNumbers({ wabaId, accessToken });
        listed = numbers.some((n) => String(n.id) === phoneNumberId);
      } catch (err) {
        subscribeError = explainMetaError(err);
        console.warn(
          '[whatsapp/config/meta] WABA phone-number check failed:',
          subscribeError
        );
      }
      if (listed === false) {
        return NextResponse.json(
          {
            error:
              `Phone number id ${phoneNumberId} is not one of the numbers in ` +
              `WhatsApp Business Account ${wabaId}. Copy both ids from the same ` +
              'number in WhatsApp → API Setup: the WABA id shown there is the ' +
              'account that number belongs to.',
          },
          { status: 400 }
        );
      }
      // A first save may go ahead unverified, like a failed subscribe.
      // Replacing a stored WABA id may not: nothing would then show the
      // new id is any better than the one it overwrites.
      if (listed === null && replacedWabaId) {
        return NextResponse.json(
          {
            error:
              `Could not confirm that phone number id ${phoneNumberId} belongs ` +
              `to WhatsApp Business Account ${wabaId}, so the connected ` +
              `number's WABA id (${tail(replacedWabaId)}) was not changed. ` +
              `Meta said: ${subscribeError}`,
          },
          { status: 409 }
        );
      }
      if (listed) {
        try {
          await subscribeWabaToApp({ wabaId, accessToken });
          subscribedAt = new Date().toISOString();
        } catch (err) {
          subscribeError = explainMetaError(err);
          console.warn(
            '[whatsapp/config/meta] WABA subscribe failed:',
            subscribeError
          );
        }
      }
    }

    const baseRow = {
      phone_number_id: phoneNumberId,
      waba_id: wabaId || null,
      access_token: encrypt(accessToken),
      // Both are optional (a single-app self-host can supply them as
      // META_APP_SECRET / META_VERIFY_TOKEN instead) and both are
      // write-only in the UI. Omitting one on a re-save must LEAVE the
      // stored value alone, not clear it — `undefined` keys are dropped
      // from the request body, so an unrelated edit can't silently
      // break inbound signature verification.
      ...(body.app_secret?.trim()
        ? { app_secret: encrypt(body.app_secret.trim()) }
        : {}),
      ...(body.verify_token?.trim()
        ? { verify_token: encrypt(body.verify_token.trim()) }
        : {}),
      status: 'connected',
      connected_at: new Date().toISOString(),
      subscribed_apps_at: subscribedAt,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { error } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('id', existing.id);
      if (claimedByAnother(error)) return claimedResponse();
      if (error) {
        console.error('[whatsapp/config/meta] update failed:', error);
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        );
      }
    } else {
      // At most one primary per account (partial unique index, migration
      // 046), so only claim it when nothing else is connected.
      const { count: siblingCount } = await supabase
        .from('whatsapp_config')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId);

      const { error } = await supabase.from('whatsapp_config').insert({
        account_id: accountId,
        user_id: user.id,
        provider: 'meta',
        label: body.label?.trim() || 'Marketing (Cloud API)',
        is_primary: (siblingCount ?? 0) === 0,
        ...baseRow,
      });
      if (claimedByAnother(error)) return claimedResponse();
      if (error) {
        console.error('[whatsapp/config/meta] insert failed:', error);
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      saved: true,
      subscribed: subscribedAt != null,
      subscribe_error: subscribeError,
      channel: {
        phone_number_id: phoneInfo.id,
        display_phone_number: phoneInfo.display_phone_number,
        verified_name: phoneInfo.verified_name,
        quality_rating: phoneInfo.quality_rating,
      },
    });
  } catch (error) {
    console.error('[whatsapp/config/meta] POST failed:', error);
    return NextResponse.json(
      { error: 'Failed to save configuration' },
      { status: 500 }
    );
  }
}

/** Disconnect the Meta number. Leaves the Whapi channel untouched. */
export async function DELETE() {
  try {
    try {
      await requireRole('admin');
    } catch (err) {
      return toErrorResponse(err);
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    // Routes pointing at this channel go with it (ON DELETE CASCADE),
    // so every surface routed to Meta falls back to the primary.
    const { error } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)
      .eq('provider', 'meta');

    if (error) {
      console.error('[whatsapp/config/meta] delete failed:', error);
      return NextResponse.json(
        { error: 'Failed to disconnect' },
        { status: 500 }
      );
    }

    // If the Meta number was the default, hand the flag to the oldest
    // remaining number, so every "Use default" still names a real one
    // rather than whatever `primaryChannel` happens to see first.
    const { data: remaining } = await supabase
      .from('whatsapp_config')
      .select('id, is_primary')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true });
    if (remaining && remaining.length > 0 && !remaining.some((r) => r.is_primary)) {
      await supabase
        .from('whatsapp_config')
        .update({ is_primary: true })
        .eq('id', remaining[0].id)
        .eq('account_id', accountId);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[whatsapp/config/meta] DELETE failed:', error);
    return NextResponse.json(
      { error: 'Failed to disconnect' },
      { status: 500 }
    );
  }
}

function claimedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'That phone number id is already connected to another account.' },
    { status: 409 }
  );
}

/** The UNIQUE (phone_number_id) violation: another account holds it. */
function claimedByAnother(
  error: { code?: string; message?: string; details?: string } | null
): boolean {
  return (
    error?.code === '23505' &&
    /phone_number_id/.test(`${error.message ?? ''} ${error.details ?? ''}`)
  );
}
