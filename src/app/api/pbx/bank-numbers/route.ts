// ============================================================
// /api/pbx/bank-numbers — bank staff numbers whose calls stay
// unrecorded while the workspace excludes them (pbx_bank_numbers,
// migration 089; a bank's DSA terms decide when that can change).
//
//   GET — { bankNumbers: [{ number, bankCode }] }
//   PUT — { bankNumbers, loaded }: the list as the screen now has it,
//         and the numbers it loaded. Numbers are reduced to digits (3
//         to 20) and may not repeat. bankNumbers is upserted, and only
//         what the admin removed (loaded minus bankNumbers) is deleted:
//         a number listed after the screen loaded (a deal-room call
//         lists a bank officer's, lib/deal-rooms/call.ts) is never
//         touched, so a stale screen cannot make that officer's calls
//         recordable again.
//
// Admin+, written with the caller's own client (admin RLS).
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { digitsOnly } from '@/lib/pbx/extensions';

const MAX_NUMBERS = 1000;
/** Numbers per DELETE … IN (…), to keep the URL short. */
const CHUNK = 200;
/** Rows per read: PostgREST's default `db-max-rows`. */
const READ_PAGE = 1000;

const fail = (error: string) => NextResponse.json({ error }, { status: 400 });

/**
 * Every listed number, a page at a time. Deal-room calls can list more
 * than MAX_NUMBERS, and an unpaged read stops at PostgREST's 1,000 rows:
 * the screen would never show (or let an admin remove) the rest, and
 * would send back a `loaded` that omits them.
 */
async function read(supabase: SupabaseClient, accountId: string) {
  const rows: { number: string; bank_code: string }[] = [];
  for (let from = 0; ;) {
    const { data, error } = await supabase
      .from('pbx_bank_numbers')
      .select('number, bank_code')
      .eq('account_id', accountId)
      .order('number', { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error)
      throw new Error(`pbx_bank_numbers read failed: ${error.message}`);
    const page = (data ?? []) as { number: string; bank_code: string }[];
    if (page.length === 0) break;
    rows.push(...page);
    // By what came back: a server capping below READ_PAGE still pages.
    from += page.length;
  }
  return rows;
}

const reply = (rows: { number: string; bank_code: string }[]) =>
  NextResponse.json({
    bankNumbers: rows.map((r) => ({ number: r.number, bankCode: r.bank_code })),
  });

function parse(
  body: unknown
):
  | { bankNumbers: { number: string; bankCode: string }[]; loaded: string[] }
  | string {
  const b = body as { bankNumbers?: unknown; loaded?: unknown } | null;
  const list = b?.bankNumbers;
  if (!Array.isArray(list)) return 'bankNumbers must be a list';
  // The cap counts what the admin submits, never a number listed since
  // the screen loaded. `loaded` is not held to it: deal-room calls can
  // list more than the cap, and an admin must still be able to trim it.
  if (list.length > MAX_NUMBERS) return `At most ${MAX_NUMBERS} numbers`;
  const rawLoaded = b?.loaded;
  if (!Array.isArray(rawLoaded)) return 'loaded must be a list';
  const loaded = rawLoaded.map((n) => digitsOnly(n));
  if (!loaded.every((n) => /^[0-9]{3,20}$/.test(n)))
    return 'loaded must list the numbers the screen loaded';
  const seen = new Set<string>();
  const out: { number: string; bankCode: string }[] = [];
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const number = digitsOnly(r.number);
    if (!/^[0-9]{3,20}$/.test(number))
      return 'Each number must have 3 to 20 digits';
    if (seen.has(number)) return `${number} is listed twice`;
    seen.add(number);
    const bankCode = typeof r.bankCode === 'string' ? r.bankCode.trim() : '';
    if (!bankCode || bankCode.length > 32)
      return `${number}: bankCode must be 1 to 32 characters`;
    out.push({ number, bankCode });
  }
  return { bankNumbers: out, loaded };
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    return reply(await read(ctx.supabase, ctx.accountId));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const input = parse(await request.json().catch(() => null));
    if (typeof input === 'string') return fail(input);
    const { bankNumbers, loaded } = input;
    if (bankNumbers.length) {
      const { error } = await ctx.supabase.from('pbx_bank_numbers').upsert(
        bankNumbers.map((r) => ({
          account_id: ctx.accountId,
          number: r.number,
          bank_code: r.bankCode,
        })),
        { onConflict: 'account_id,number' }
      );
      if (error)
        throw new Error(`pbx_bank_numbers write failed: ${error.message}`);
    }
    // Only what the admin removed: a row the screen never loaded stays.
    const kept = new Set(bankNumbers.map((r) => r.number));
    const removed = loaded.filter((n) => !kept.has(n));
    // `loaded` is uncapped (see parse), so in chunks: one IN list of
    // thousands of numbers is a URL PostgREST refuses.
    for (let i = 0; i < removed.length; i += CHUNK) {
      const { error } = await ctx.supabase
        .from('pbx_bank_numbers')
        .delete()
        .eq('account_id', ctx.accountId)
        .in('number', removed.slice(i, i + CHUNK));
      if (error)
        throw new Error(`pbx_bank_numbers delete failed: ${error.message}`);
    }
    return reply(await read(ctx.supabase, ctx.accountId));
  } catch (err) {
    return toErrorResponse(err);
  }
}
