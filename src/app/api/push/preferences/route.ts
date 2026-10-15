// ============================================================
// /api/push/preferences — the caller's own push settings (migration
// 109's push_preferences, own-row CRUD under RLS). No row means the
// defaults: on, every kind on, no quiet hours.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { isPushKind } from '@/lib/push/kinds';
import { isValidTimeZone, parseClock } from '@/lib/push/quiet-hours';

interface Preferences {
  enabled: boolean;
  kinds: Record<string, boolean>;
  quietStart: string | null;
  quietEnd: string | null;
  timeZone: string | null;
}

const COLUMNS = 'enabled, kinds, quiet_start, quiet_end, time_zone';

/** Postgres' '22:00:00' → '22:00'. */
const toClock = (value: string | null): string | null =>
  value ? value.slice(0, 5) : null;

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

type Parsed = { ok: true; value: Preferences } | { ok: false; error: string };

function parsePreferences(body: unknown): Parsed {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid body' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean' };
  }
  if (!b.kinds || typeof b.kinds !== 'object' || Array.isArray(b.kinds)) {
    return { ok: false, error: 'kinds must be an object' };
  }
  const kinds: Record<string, boolean> = {};
  for (const [key, on] of Object.entries(b.kinds)) {
    if (!isPushKind(key)) return { ok: false, error: `Unknown kind: ${key}` };
    if (typeof on !== 'boolean') {
      return { ok: false, error: `kinds.${key} must be a boolean` };
    }
    kinds[key] = on;
  }

  const clock = (v: unknown): string | null | undefined => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) return undefined;
    return parseClock(v) === null ? undefined : v;
  };
  const quietStart = clock(b.quietStart);
  const quietEnd = clock(b.quietEnd);
  if (quietStart === undefined || quietEnd === undefined) {
    return { ok: false, error: 'Quiet hours must be HH:MM' };
  }
  if ((quietStart === null) !== (quietEnd === null)) {
    return { ok: false, error: 'Set both quiet-hours times or neither' };
  }
  if (quietStart !== null && quietStart === quietEnd) {
    return { ok: false, error: 'Quiet hours cannot start and end together' };
  }

  const tz = b.timeZone;
  if (tz !== undefined && tz !== null && typeof tz !== 'string') {
    return { ok: false, error: 'timeZone must be a string' };
  }
  const timeZone = tz ? tz : null;
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    return { ok: false, error: 'Unknown time zone' };
  }
  if (quietStart !== null && timeZone === null) {
    return { ok: false, error: 'A time zone is required with quiet hours' };
  }
  return {
    ok: true,
    value: { enabled: b.enabled, kinds, quietStart, quietEnd, timeZone },
  };
}

export async function GET() {
  try {
    const { supabase, userId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('push_preferences')
      .select(COLUMNS)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('[push/preferences] load failed:', error);
      return NextResponse.json(
        { error: 'Failed to load preferences' },
        { status: 500 }
      );
    }
    const prefs: Preferences = data
      ? {
          enabled: data.enabled,
          kinds: (data.kinds as Record<string, boolean> | null) ?? {},
          quietStart: toClock(data.quiet_start),
          quietEnd: toClock(data.quiet_end),
          timeZone: data.time_zone ?? null,
        }
      : {
          enabled: true,
          kinds: {},
          quietStart: null,
          quietEnd: null,
          timeZone: null,
        };
    return NextResponse.json(prefs);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, userId } = await getCurrentAccount();
    const parsed = parsePreferences(await request.json().catch(() => null));
    if (!parsed.ok) return bad(parsed.error);
    const p = parsed.value;
    const { error } = await supabase.from('push_preferences').upsert(
      {
        user_id: userId,
        enabled: p.enabled,
        kinds: p.kinds,
        quiet_start: p.quietStart,
        quiet_end: p.quietEnd,
        time_zone: p.timeZone,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    if (error) {
      console.error('[push/preferences] save failed:', error);
      return NextResponse.json(
        { error: 'Failed to save preferences' },
        { status: 500 }
      );
    }
    return NextResponse.json(p);
  } catch (err) {
    return toErrorResponse(err);
  }
}
