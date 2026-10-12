import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { chatFilesOfAccount, chunked, reasonOk } from '@/lib/chat/admin-tools';
import { erasePerson } from '@/lib/chat/api';
import { ChatError } from '@/lib/chat/errors';
import { isUuid } from '@/lib/chat/mentions';
import { CHAT_FILES_BUCKET } from '@/lib/chat/uploads';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

/** Storage removes take a bounded list. */
const FILE_BATCH = 100;

/**
 * POST /api/chat/admin/erase-person — Settings → Team chat's lawful
 * erasure (owner only). Body `{ userId, reason }`.
 *
 * chat_erase_person runs on the caller's own session, so the RPC checks
 * the owner role and writes chat_audit_log under their name. It deletes
 * the attachment rows and returns their storage paths, and those
 * objects are removed here with the service role: chat-files has no
 * DELETE policy, so a browser remove() would quietly delete nothing.
 * The rows are already gone by then, so a path that cannot be removed
 * is logged (the only record left of it) and counted, never thrown:
 * the erasure itself has committed.
 */
function supabaseAdmin() {
  return createAdminClient(
    serverSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

const STATUS_BY_CODE: Record<string, number> = {
  FORBIDDEN: 403,
  INVALID: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('owner');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!isUuid(userId)) {
      return NextResponse.json(
        { error: 'Choose the person to erase', key: 'invalid' },
        { status: 400 }
      );
    }
    if (!reasonOk(reason)) {
      return NextResponse.json(
        {
          error: 'A reason of at least 5 characters is required',
          key: 'reasonRequired',
        },
        { status: 400 }
      );
    }

    let paths: string[];
    try {
      paths = await erasePerson(ctx.supabase, {
        accountId: ctx.accountId,
        userId,
        reason,
      });
    } catch (err) {
      if (!(err instanceof ChatError)) throw err;
      const status = STATUS_BY_CODE[err.code] ?? 500;
      if (status === 500)
        console.error('[POST /api/chat/admin/erase-person]', err);
      return NextResponse.json(
        { error: 'The erasure failed', key: err.key },
        { status }
      );
    }

    // The message count is in the audit row the RPC wrote in the same
    // transaction; null if it cannot be read back.
    const { data: audit } = await ctx.supabase
      .from('chat_audit_log')
      .select('detail')
      .eq('account_id', ctx.accountId)
      .eq('actor_id', ctx.userId)
      .eq('action', 'erase_person')
      .eq('detail->>user_id', userId.toLowerCase())
      .order('at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const counted = (audit?.detail as Record<string, unknown> | undefined)
      ?.messages;
    const messages = typeof counted === 'number' ? counted : null;

    const owned = chatFilesOfAccount(paths, ctx.accountId);
    const failed = paths.filter((p) => !owned.includes(p));
    let deleted = 0;
    const storage = supabaseAdmin().storage.from(CHAT_FILES_BUCKET);
    for (const batch of chunked(owned, FILE_BATCH)) {
      // One retry: a storage blip should not leave files behind.
      let result = await storage.remove(batch);
      if (result.error) result = await storage.remove(batch);
      if (result.error) failed.push(...batch);
      else deleted += result.data?.length ?? 0;
    }
    if (failed.length > 0) {
      console.error(
        `[POST /api/chat/admin/erase-person] ${failed.length} erased file(s) left in ${CHAT_FILES_BUCKET} for account ${ctx.accountId}:`,
        failed
      );
    }

    return NextResponse.json({
      messages,
      files: paths.length,
      filesDeleted: deleted,
      filesFailed: failed.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
