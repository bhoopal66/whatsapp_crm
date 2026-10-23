// ============================================================
// POST /api/pbx/extensions/sync — read every extension off the
// workspace's PBX (`extension/list`, paged) into pbx_extensions.
//
// A known extension gets only its registration columns refreshed: its
// workspace and person are an admin's mapping and a sync never reverts
// them. A new one is inserted unmapped in the connection's workspace
// (ON CONFLICT DO NOTHING, so a concurrent sync or mapping wins). An
// extension gone from the PBX is left alone. Answers the list, with
// the PBX's caller ID name for each extension it still has.
//
// One PBX login at most, never retried: a refused credential or a
// blocked IP backs every process off, as the connection test does.
// Admin+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { ownConnection, pbxServiceDb } from '@/lib/pbx/admin';
import {
  PBX_AUTH_BACKOFF_MS,
  PbxConnectionError,
  pbxApiFor,
} from '@/lib/pbx/connection';
import {
  adminWorkspaces,
  connectionExtensions,
  registrationOf,
} from '@/lib/pbx/extensions';
import {
  YeastarError,
  type ExtensionSummary,
  type YeastarApi,
} from '@/lib/pbx/yeastar';

const PAGE_SIZE = 100;
/** A guard against a PBX that ignores `page`: 20,000 extensions. */
const MAX_PAGES = 200;
/** Extension numbers per UPDATE … IN (…), to keep the URL short. */
const CHUNK = 200;
/** Rows per read of the known extensions; PostgREST caps a read at 1,000. */
const READ_PAGE = 1000;

async function listAll(api: YeastarApi): Promise<ExtensionSummary[]> {
  const byNumber = new Map<string, ExtensionSummary>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { total, items } = await api.listExtensions({
      page,
      pageSize: PAGE_SIZE,
    });
    for (const e of items) {
      const n = e.number.trim();
      if (n && n.length <= 32) byNumber.set(n, { ...e, number: n });
    }
    if (items.length === 0 || page * PAGE_SIZE >= total) break;
  }
  return [...byNumber.values()];
}

export async function POST() {
  try {
    const ctx = await requireRole('admin');
    const db = pbxServiceDb();
    const conn = await ownConnection(db, ctx.accountId);
    if (!conn) {
      return NextResponse.json(
        { error: 'No PBX connection is configured' },
        { status: 404 }
      );
    }

    let found: ExtensionSummary[];
    try {
      const { api } = await pbxApiFor(db, conn.id);
      found = await listAll(api);
    } catch (err) {
      if (err instanceof PbxConnectionError) {
        return err.code === 'auth_backoff'
          ? NextResponse.json(
              {
                error:
                  'The PBX refused these credentials a few minutes ago. Correct them, or wait before trying again.',
              },
              { status: 429 }
            )
          : NextResponse.json(
              {
                error:
                  'The PBX credentials are incomplete or unreadable. Save them again.',
              },
              { status: 409 }
            );
      }
      if (!(err instanceof YeastarError)) throw err;
      const refused = err.isAuthFailure || err.isIpBlocked;
      await db
        .from('pbx_connections')
        .update({
          status: refused ? 'auth_failed' : 'disconnected',
          last_error: err.message,
        })
        .eq('id', conn.id);
      if (refused) {
        await db
          .from('pbx_connection_secrets')
          .update({
            backoff_until: new Date(
              Date.now() + PBX_AUTH_BACKOFF_MS
            ).toISOString(),
          })
          .eq('connection_id', conn.id);
      }
      return NextResponse.json(
        {
          error: refused
            ? `The PBX refused the credentials: ${err.message}`
            : `The PBX could not be read: ${err.message}`,
        },
        { status: 502 }
      );
    }

    // Every known extension, a page at a time: one past an unpaged read's
    // 1,000 rows would be taken for new, skipped by the insert's ON
    // CONFLICT DO NOTHING, and never get its registration refreshed.
    const known = new Set<string>();
    for (let from = 0; ;) {
      const { data, error: readError } = await db
        .from('pbx_extensions')
        .select('extension')
        .eq('connection_id', conn.id)
        .order('extension', { ascending: true })
        .range(from, from + READ_PAGE - 1);
      if (readError)
        throw new Error(`pbx_extensions read failed: ${readError.message}`);
      const page = (data ?? []) as { extension: string }[];
      if (page.length === 0) break;
      for (const r of page) known.add(r.extension);
      // By what came back: a server capping below READ_PAGE still pages.
      from += page.length;
    }

    const stamp = new Date().toISOString();
    const groups = new Map<
      string,
      { reg: ReturnType<typeof registrationOf>; numbers: string[] }
    >();
    const fresh: Record<string, unknown>[] = [];
    for (const e of found) {
      const reg = registrationOf(e.online);
      if (!known.has(e.number)) {
        fresh.push({
          connection_id: conn.id,
          extension: e.number,
          account_id: conn.account_id,
          ...reg,
        });
        continue;
      }
      const key = `${reg.registration_state}:${reg.client_kind}`;
      const g = groups.get(key) ?? { reg, numbers: [] };
      g.numbers.push(e.number);
      groups.set(key, g);
    }
    // Only the registration columns: never account_id or user_id.
    for (const { reg, numbers } of groups.values()) {
      for (let i = 0; i < numbers.length; i += CHUNK) {
        const { error } = await db
          .from('pbx_extensions')
          .update({ ...reg, updated_at: stamp })
          .eq('connection_id', conn.id)
          .in('extension', numbers.slice(i, i + CHUNK));
        if (error)
          throw new Error(`pbx_extensions update failed: ${error.message}`);
      }
    }
    if (fresh.length) {
      const { error } = await db.from('pbx_extensions').upsert(fresh, {
        onConflict: 'connection_id,extension',
        ignoreDuplicates: true,
      });
      if (error)
        throw new Error(`pbx_extensions insert failed: ${error.message}`);
    }
    await db
      .from('pbx_connections')
      .update({ status: 'connected', last_error: null })
      .eq('id', conn.id);

    const workspaces = await adminWorkspaces(ctx.supabase);
    const views = await connectionExtensions(
      db,
      conn.id,
      new Set(workspaces.map((w) => w.accountId))
    );
    const onPbx = new Map(found.map((e) => [e.number, e]));
    return NextResponse.json({
      extensions: views.map((v) => ({
        ...v,
        onPbx: onPbx.has(v.extension),
        callerIdName: onPbx.get(v.extension)?.callerIdName ?? null,
      })),
      total: found.length,
      added: fresh.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
