// ============================================================
// /api/pbx/bank-numbers — bank staff numbers whose calls stay
// unrecorded while the workspace excludes them (pbx_bank_numbers,
// migration 089; a bank's DSA terms decide when that can change).
//
//   GET — { bankNumbers: [{ number, bankCode }] }
//   PUT — the same shape, replacing the list. Numbers are reduced to
//         digits (3 to 20) and may not repeat.
//
// Admin+, written with the caller's own client (admin RLS).
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { digitsOnly } from '@/lib/pbx/extensions';

const MAX_NUMBERS = 1000;

const fail = (error: string) => NextResponse.json({ error }, { status: 400 });

async function read(supabase: SupabaseClient, accountId: string) {
  const { data, error } = await supabase
    .from('pbx_bank_numbers')
    .select('number, bank_code')
    .eq('account_id', accountId)
    .order('number', { ascending: true });
  if (error) throw new Error(`pbx_bank_numbers read failed: ${error.message}`);
  return (data ?? []) as { number: string; bank_code: string }[];
}

const reply = (rows: { number: string; bank_code: string }[]) =>
  NextResponse.json({
    bankNumbers: rows.map((r) => ({ number: r.number, bankCode: r.bank_code })),
  });

function parse(body: unknown): { number: string; bankCode: string }[] | string {
  const list = (body as { bankNumbers?: unknown } | null)?.bankNumbers;
  if (!Array.isArray(list)) return 'bankNumbers must be a list';
  if (list.length > MAX_NUMBERS) return `At most ${MAX_NUMBERS} numbers`;
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
  return out;
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
    const existing = await read(ctx.supabase, ctx.accountId);
    if (input.length) {
      const { error } = await ctx.supabase.from('pbx_bank_numbers').upsert(
        input.map((r) => ({
          account_id: ctx.accountId,
          number: r.number,
          bank_code: r.bankCode,
        })),
        { onConflict: 'account_id,number' }
      );
      if (error)
        throw new Error(`pbx_bank_numbers write failed: ${error.message}`);
    }
    const kept = new Set(input.map((r) => r.number));
    const removed = existing.map((r) => r.number).filter((n) => !kept.has(n));
    if (removed.length) {
      const { error } = await ctx.supabase
        .from('pbx_bank_numbers')
        .delete()
        .eq('account_id', ctx.accountId)
        .in('number', removed);
      if (error)
        throw new Error(`pbx_bank_numbers delete failed: ${error.message}`);
    }
    return reply(await read(ctx.supabase, ctx.accountId));
  } catch (err) {
    return toErrorResponse(err);
  }
}
