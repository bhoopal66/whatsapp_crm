'use client';

// ============================================================
// Settings → Workspace: archiving this workspace, and restoring the
// archived ones (migration 105), through POST /api/workspaces/archive.
//
// The database decides everything; these cards only ask and read the
// answer through the pure helpers in `lib/auth/workspace-archive.ts`:
// a refusal's `code` picks the message, and a success reloads into the
// workspace the caller now works in when archiving moved them out.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import type { Workspace } from '@/lib/auth/my-workspaces';
import {
  afterArchive,
  archiveRefusalMessage,
  restorableWorkspaces,
  type ArchiveMessage,
} from '@/lib/auth/workspace-archive';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** The dialog's "what happens" lines, in order. */
const HAPPENS = ['moved', 'invitations', 'apiKeys', 'closed'] as const;
/** The dialog's "do these first" lines, in order. */
const FIRST = ['channels', 'routes', 'people'] as const;

/** The route's answer; `body` is null when there was none to read. */
async function postArchive(
  accountId: string,
  archived: boolean
): Promise<{ ok: boolean; body: unknown }> {
  try {
    const res = await fetch('/api/workspaces/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, archived }),
    });
    const body: unknown = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

function useRefusalText() {
  const t = useTranslations('Settings.workspace.archive');
  return (m: ArchiveMessage) => t(`errors.${m.key}`, { count: m.count ?? 0 });
}

/** Owner only: archive the workspace on screen, after a confirmation. */
export function ArchiveWorkspaceCard({ name }: { name: string }) {
  const t = useTranslations('Settings.workspace.archive');
  const refusalText = useRefusalText();
  const { accountId, refreshProfile, reloadIntoActiveWorkspace } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ArchiveMessage | null>(null);

  async function archive() {
    if (!accountId || busy) return;
    setBusy(true);
    setRefusal(null);
    const { ok, body } = await postArchive(accountId, true);
    if (!ok) {
      setRefusal(archiveRefusalMessage(body));
      setBusy(false);
      return;
    }
    const next = afterArchive(body, accountId);
    if (next.reload) {
      // A page load follows, so the dialog stays busy until it does.
      reloadIntoActiveWorkspace(next.role);
      return;
    }
    setBusy(false);
    setOpen(false);
    await refreshProfile();
  }

  return (
    <Card className="mt-6">
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t('title')}</h3>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        <Button
          type="button"
          variant="destructive"
          onClick={() => {
            setRefusal(null);
            setOpen(true);
          }}
        >
          {t('open')}
        </Button>
      </CardContent>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          setOpen(next);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('dialogTitle', { name })}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <p className="font-medium">{t('happensTitle')}</p>
              <ul className="text-muted-foreground list-disc space-y-1 pl-5">
                {HAPPENS.map((key) => (
                  <li key={key}>{t(`happens.${key}`)}</li>
                ))}
              </ul>
            </div>
            <div className="space-y-1.5">
              <p className="font-medium">{t('firstTitle')}</p>
              <ul className="text-muted-foreground list-disc space-y-1 pl-5">
                {FIRST.map((key) => (
                  <li key={key}>{t(`first.${key}`)}</li>
                ))}
              </ul>
            </div>
            {refusal ? (
              <div
                role="alert"
                className="border-destructive/30 bg-destructive-soft text-destructive rounded-md border p-3"
              >
                <p>{refusalText(refusal)}</p>
                {refusal.detail ? (
                  <p className="mt-1 text-xs">{refusal.detail}</p>
                ) : null}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void archive()}
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('archiving')}
                </>
              ) : (
                t('confirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * The archived workspaces the caller can restore (a live owner there),
 * each with Restore. Renders nothing when there are none.
 */
export function ArchivedWorkspacesCard() {
  const t = useTranslations('Settings.workspace.archive');
  const refusalText = useRefusalText();
  const { workspaces, accountId, refreshProfile, reloadIntoActiveWorkspace } =
    useAuth();
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const archived = restorableWorkspaces(workspaces);

  if (archived.length === 0) return null;

  async function restore(workspace: Workspace) {
    if (restoringId) return;
    setRestoringId(workspace.accountId);
    const { ok, body } = await postArchive(workspace.accountId, false);
    if (!ok) {
      const refusal = archiveRefusalMessage(body);
      toast.error(t('restoreFailed', { name: workspace.name }), {
        description: [refusalText(refusal), refusal.detail]
          .filter(Boolean)
          .join(' '),
      });
      setRestoringId(null);
      return;
    }
    const next = afterArchive(body, accountId);
    if (next.reload) {
      reloadIntoActiveWorkspace(next.role);
      return;
    }
    toast.success(t('restored', { name: workspace.name }));
    await refreshProfile();
    setRestoringId(null);
  }

  return (
    <Card className="mt-6">
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t('archivedTitle')}</h3>
          <p className="text-muted-foreground text-sm">
            {t('archivedDescription')}
          </p>
        </div>
        <ul className="divide-border divide-y">
          {archived.map((w) => (
            <li
              key={w.accountId}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className="min-w-0 truncate text-sm font-medium">
                {w.name}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!!restoringId}
                onClick={() => void restore(w)}
              >
                {restoringId === w.accountId ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('restoring')}
                  </>
                ) : (
                  t('restore')
                )}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
