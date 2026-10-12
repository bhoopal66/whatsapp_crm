import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { chatFilesOfAccount } from '@/lib/chat/admin-tools';
import { deleteMessage } from '@/lib/chat/api';
import { ChatError } from '@/lib/chat/errors';
import { removeChatFiles } from '@/lib/chat/file-cleanup';
import { isUuid } from '@/lib/chat/mentions';
import { CHAT_FILES_BUCKET } from '@/lib/chat/uploads';
import { serverSupabaseUrl } from '@/lib/supabase/urls';

/**
 * POST /api/chat/messages/[id]/delete — deletes a team-chat message and
 * its files.
 *
 * chat_delete_message runs on the caller's own session, so the RPC alone
 * decides who may delete (the author, or a workspace owner/admin) and
 * there is no role check here. It drops the attachment rows, which makes
 * the objects unreadable at once, and returns their storage paths; those
 * are removed with the service role (chat-files has no DELETE policy),
 * only inside the caller's workspace prefix. A path that cannot be
 * removed is logged and counted, never thrown: the delete has committed,
 * and the cron's orphan sweep (chat_orphan_files) removes it later.
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
  DISABLED: 403,
  INVALID: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { error: 'Message not found', key: 'notFound' },
        { status: 404 }
      );
    }
    const ctx = await getCurrentAccount();

    let paths: string[];
    try {
      paths = await deleteMessage(ctx.supabase, id);
    } catch (err) {
      if (!(err instanceof ChatError)) throw err;
      const status = STATUS_BY_CODE[err.code] ?? 500;
      if (status === 500)
        console.error('[POST /api/chat/messages/[id]/delete]', err);
      return NextResponse.json(
        { error: 'The message could not be deleted', key: err.key },
        { status }
      );
    }

    const owned = chatFilesOfAccount(paths, ctx.accountId);
    const failed = paths.filter((p) => !owned.includes(p));
    const removed =
      owned.length > 0
        ? await removeChatFiles(supabaseAdmin(), owned)
        : { deleted: 0, failed: [] };
    failed.push(...removed.failed);
    if (failed.length > 0) {
      console.error(
        `[POST /api/chat/messages/[id]/delete] ${failed.length} file(s) of message ${id} left in ${CHAT_FILES_BUCKET} for account ${ctx.accountId}:`,
        failed
      );
    }

    return NextResponse.json({
      files: paths.length,
      filesDeleted: removed.deleted,
      filesFailed: failed.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
