import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import type { SafetyEntry } from '@/lib/team-activity/safety';
import { ChannelError, loadChannels } from '@/lib/whatsapp/channels';
import { getNumberSafetyRating } from '@/lib/whatsapp/provider';
import { WhapiError } from '@/lib/whatsapp/whapi-api';

/**
 * Whapi's Safety Meter for each of the account's Whapi numbers: Whapi's
 * own 1-3 rating of how likely WhatsApp is to restrict the number.
 * Admin+.
 *
 *   GET  → { numbers: SafetyEntry[] }        the stored ratings
 *   POST { channelId } → { number: SafetyEntry }  recalculate one
 *
 * Whapi recalculates at most once a day, so reads are cached here for
 * a quarter of an hour per number; a recalculation replaces the entry.
 */

const CACHE_MS = 15 * 60_000;
const cache = new Map<string, SafetyEntry>();

function failure(err: unknown): SafetyEntry['error'] {
  if (err instanceof WhapiError && [401, 403, 404].includes(err.status)) {
    return 'refused';
  }
  return 'unavailable';
}

async function read(
  channel: Parameters<typeof getNumberSafetyRating>[0],
  recalculate: boolean
): Promise<SafetyEntry> {
  const checkedAt = new Date().toISOString();
  try {
    const rating = await getNumberSafetyRating(channel, { recalculate });
    const entry: SafetyEntry = {
      channelId: channel.id,
      rating,
      error: null,
      checkedAt,
    };
    cache.set(channel.id, entry);
    return entry;
  } catch (err) {
    console.warn(
      `[team-activity/safety] number ${channel.id}:`,
      err instanceof Error ? err.message : err
    );
    // Not cached: the next look tries again.
    return {
      channelId: channel.id,
      rating: null,
      error: failure(err),
      checkedAt,
    };
  }
}

async function whapiNumbers(
  supabase: Parameters<typeof loadChannels>[0],
  accountId: string
) {
  const all = await loadChannels(supabase, accountId);
  return all.filter((c) => c.provider === 'whapi');
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    let channels;
    try {
      channels = await whapiNumbers(supabase, accountId);
    } catch (err) {
      if (err instanceof ChannelError) {
        return NextResponse.json({ numbers: [] });
      }
      throw err;
    }

    const now = Date.now();
    const numbers = await Promise.all(
      channels.map((c) => {
        const hit = cache.get(c.id);
        if (hit && now - Date.parse(hit.checkedAt) < CACHE_MS) return hit;
        return read(c, false);
      })
    );
    return NextResponse.json({ numbers });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(
      `team-activity-safety:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const channelId = (body as { channelId?: unknown } | null)?.channelId;
    if (typeof channelId !== 'string' || !channelId) {
      return NextResponse.json(
        { error: 'channelId is required' },
        { status: 400 }
      );
    }

    let channels;
    try {
      channels = await whapiNumbers(supabase, accountId);
    } catch (err) {
      if (err instanceof ChannelError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        );
      }
      throw err;
    }
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) {
      return NextResponse.json(
        { error: 'Not a Whapi number on this account' },
        { status: 404 }
      );
    }

    return NextResponse.json({ number: await read(channel, true) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
