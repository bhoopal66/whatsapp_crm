// ============================================================
// POST /api/workspaces/archive — { accountId, archived: boolean }
//
// Archives a workspace (`archived: true`) or restores it (`false`)
// through `archive_workspace` (migration 105). Owner only, judged on
// the caller's row in THAT workspace (my_workspaces()), not the active
// one: an archived workspace is restored from another. The database
// checks the same and decides everything else.
//
//   200 { accountId, archived, activeAccountId, activeRole, moved,
//         invitationsRevoked }. activeAccountId is where the caller now
//         works: an archive moves everyone out of the workspace, so when
//         it differs from the workspace the client is in, the client
//         reloads into it (workspaceEntryPath(activeRole)).
//   400 a malformed body · 401 no session · 403 { error, code:
//   'forbidden' } not a live owner there · 409 { error, code, count? }
//   a refusal: 'no_other_workspace', 'channels_connected',
//   'calls_routed_here' (another workspace's phone system routes numbers
//   or extensions here; the error names them) or 'members_stranded'
//   (count: how many have nowhere to go).
//
// Authenticated by the session alone, as POST /api/workspaces/switch
// is: getCurrentAccount answers for the active workspace, which need
// not be the one archived or restored.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { parseMyWorkspaces } from '@/lib/auth/my-workspaces';
import { canArchiveWorkspace } from '@/lib/auth/roles';
import {
  archiveErrorResponse,
  NOT_AN_OWNER,
  parseArchiveResult,
} from '@/lib/auth/workspace-archive';
import { createClient } from '@/lib/supabase/server';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as {
      accountId?: unknown;
      archived?: unknown;
    } | null;
    const accountId = body?.accountId;
    const archived = body?.archived;
    if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
      return NextResponse.json(
        { error: "'accountId' must be a workspace id" },
        { status: 400 }
      );
    }
    if (typeof archived !== 'boolean') {
      return NextResponse.json(
        { error: "'archived' must be true or false" },
        { status: 400 }
      );
    }

    const { data: rows, error: listError } =
      await supabase.rpc('my_workspaces');
    if (listError) {
      console.error(
        '[POST /api/workspaces/archive] my_workspaces failed:',
        listError
      );
      return NextResponse.json(
        { error: 'Failed to load workspaces' },
        { status: 500 }
      );
    }
    const target = parseMyWorkspaces(rows).find(
      (w) => w.accountId === accountId
    );
    if (
      !target ||
      target.deactivated ||
      !target.role ||
      !canArchiveWorkspace(target.role)
    ) {
      return NextResponse.json(
        { error: NOT_AN_OWNER, code: 'forbidden' },
        { status: 403 }
      );
    }

    const { data, error } = await supabase.rpc('archive_workspace', {
      p_account_id: accountId,
      p_archive: archived,
    });
    if (error) {
      const failure = archiveErrorResponse(error, archived);
      if (failure.status >= 500) {
        console.error(
          '[POST /api/workspaces/archive] archive_workspace failed:',
          error
        );
      }
      return NextResponse.json(failure.body, { status: failure.status });
    }

    const result = parseArchiveResult(data);
    if (!result) {
      console.error(
        '[POST /api/workspaces/archive] unexpected archive_workspace result:',
        data
      );
      return NextResponse.json(
        {
          error: archived
            ? 'Could not archive the workspace'
            : 'Could not restore the workspace',
        },
        { status: 500 }
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
