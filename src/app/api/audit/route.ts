// ============================================================
// GET /api/audit — Settings → Audit log (admin+). Query: source
// (team_chat | recordings | phone | deal_rooms, default all), from / to
// (ISO; from inclusive, to exclusive), actor (user id), page (1-20).
// Answers `{ rows, page, hasMore }`, 50 rows newest first.
//
// The four tables' SELECT policies already open them to owners and
// admins of the active account, so everything is read with the caller's
// own client and filtered to that account. Each source returns its
// newest page × 50 + 1 rows, which is all a merged page can draw on.
// Names are cosmetic: a lookup that fails leaves them null.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  AUDIT_TABLES,
  idsToName,
  mergeAuditPage,
  nameAuditRows,
  parseAuditQuery,
  perSourceLimit,
  shapeAuditRows,
  type AuditRow,
} from '@/lib/audit/view';

type Row = Record<string, unknown>;

async function lookup(
  db: SupabaseClient,
  table: string,
  columns: string,
  accountId: string,
  key: string,
  ids: string[]
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from(table)
    .select(columns)
    .eq('account_id', accountId)
    .in(key, ids);
  if (error) console.error(`[GET /api/audit] ${table} names:`, error.message);
  return (data as unknown as Row[] | null) ?? [];
}

const text = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

async function names(db: SupabaseClient, accountId: string, rows: AuditRow[]) {
  const { people, byKind } = idsToName(rows);
  const [profiles, channels, rooms, calls] = await Promise.all([
    lookup(db, 'profiles', 'user_id, full_name', accountId, 'user_id', people),
    lookup(db, 'chat_channels', 'id, name', accountId, 'id', byKind.channel),
    lookup(db, 'deal_rooms', 'id, subject', accountId, 'id', byKind.deal_room),
    lookup(
      db,
      'calls',
      'id, remote_number, contact_id',
      accountId,
      'id',
      byKind.call
    ),
  ]);
  const callContacts = calls.map((c) => text(c.contact_id)).filter((v) => !!v);
  const contacts = await lookup(
    db,
    'contacts',
    'id, name, phone',
    accountId,
    'id',
    [...new Set([...byKind.contact, ...(callContacts as string[])])]
  );
  const contactName = new Map(
    contacts.map((c) => [String(c.id), text(c.name) ?? text(c.phone)])
  );
  const items = new Map<string, string>();
  const put = (k: string, v: string | null) => v && items.set(k, v);
  for (const c of channels) put(`channel:${c.id}`, text(c.name));
  for (const r of rooms) put(`deal_room:${r.id}`, text(r.subject));
  for (const [id, v] of contactName) put(`contact:${id}`, v);
  for (const c of calls) {
    const who = c.contact_id ? contactName.get(String(c.contact_id)) : null;
    put(`call:${c.id}`, who ?? text(c.remote_number));
  }
  const peopleNames = new Map<string, string>();
  for (const p of profiles) {
    const n = text(p.full_name);
    if (n) peopleNames.set(String(p.user_id), n);
  }
  return nameAuditRows(rows, peopleNames, items);
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const query = parseAuditQuery(new URL(request.url).searchParams);
    if (typeof query === 'string')
      return NextResponse.json({ error: query }, { status: 400 });

    const limit = perSourceLimit(query.page);
    const lists = await Promise.all(
      query.sources.map(async (source) => {
        const spec = AUDIT_TABLES[source];
        let q = ctx.supabase
          .from(spec.table)
          .select(spec.columns)
          .eq('account_id', ctx.accountId);
        if (query.from) q = q.gte('at', query.from);
        if (query.to) q = q.lt('at', query.to);
        if (query.actorId) q = q.eq(spec.actor, query.actorId);
        const { data, error } = await q
          .order('at', { ascending: false })
          .limit(limit);
        if (error)
          throw new Error(`${spec.table} read failed: ${error.message}`);
        return shapeAuditRows(source, (data as unknown as Row[] | null) ?? []);
      })
    );
    const { rows, hasMore } = mergeAuditPage(lists, query.page);
    return NextResponse.json({
      rows: await names(ctx.supabase, ctx.accountId, rows),
      page: query.page,
      hasMore,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
