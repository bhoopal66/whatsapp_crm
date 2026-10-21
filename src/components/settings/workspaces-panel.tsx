'use client';

// ============================================================
// Settings → My account → Workspaces: every workspace the person
// belongs to (migration 083), and the only place to switch between
// them. It replaced the workspace rail at the sidebar's left edge.
// Owners and admins also create a workspace from here.
//
// The badges come from `chat_workspace_badges()` (087): team-chat
// unread and mentions for every workspace at once. Badges are a
// courtesy, so a failed read shows none rather than an error.
//
// Switching reloads the app in the chosen workspace (`switchWorkspace`).
// A workspace it cannot switch into (`isSwitchableWorkspace`: a
// deactivated membership, or an archived workspace, which only its
// owners see) is listed with the reason and no Switch button.
//
// This is also a bank guest's one Settings section: without it a guest
// in several workspaces could not switch at all.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CreateWorkspaceDialog } from '@/components/workspaces/create-workspace-dialog';
import { useAuth } from '@/hooks/use-auth';
import type { Workspace } from '@/lib/auth/my-workspaces';
import type { AccountRole } from '@/lib/auth/roles';
import { isSwitchableWorkspace } from '@/lib/auth/workspace-archive';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import {
  badgeFor,
  parseWorkspaceBadges,
  workspaceTileLabel,
  type WorkspaceBadgeRow,
} from '@/lib/workspaces/form';

/** How often the badges are re-read while the panel is open. */
const BADGE_REFRESH_MS = 60_000;

/** The role names the sidebar already carries. */
const ROLE_LABEL_KEY: Record<AccountRole, string> = {
  owner: 'roleOwner',
  admin: 'roleAdmin',
  team_leader: 'roleTeamLeader',
  agent: 'roleAgent',
  viewer: 'roleViewer',
  bank_guest: 'roleBankGuest',
};

function useWorkspaceBadges(enabled: boolean): WorkspaceBadgeRow[] {
  const [badges, setBadges] = useState<WorkspaceBadgeRow[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      Promise.resolve(createClient().rpc('chat_workspace_badges'))
        .then(({ data, error }) => {
          if (!cancelled) setBadges(error ? [] : parseWorkspaceBadges(data));
        })
        .catch(() => {
          if (!cancelled) setBadges([]);
        });
    };
    load();
    const timer = window.setInterval(load, BADGE_REFRESH_MS);
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [enabled]);

  return badges;
}

export function WorkspacesPanel() {
  const t = useTranslations('Workspaces.list');
  const tSidebar = useTranslations('Sidebar');
  const {
    workspaces,
    activeWorkspaceId,
    switchWorkspace,
    refreshProfile,
    profileLoading,
    canManageMembers,
  } = useAuth();
  const badges = useWorkspaceBadges(workspaces.length > 0);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // Owner/admin of the active workspace: the gate POST /api/workspaces
  // applies, and the one the sidebar's "+" tile used.
  const canCreate = !profileLoading && canManageMembers;

  const choose = async (workspace: Workspace) => {
    if (
      workspace.accountId === activeWorkspaceId ||
      switchingTo ||
      !isSwitchableWorkspace(workspace)
    ) {
      return;
    }
    setSwitchingTo(workspace.accountId);
    try {
      // Resolves into a page load, so the state is never reset on success.
      await switchWorkspace(workspace.accountId);
    } catch (err) {
      setSwitchingTo(null);
      toast.error(
        tSidebar('workspaceSwitchFailed', {
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    }
  };

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-foreground text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        {canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t('create')}
          </Button>
        ) : null}
      </div>

      {profileLoading ? (
        <div className="space-y-3" aria-busy="true">
          <div className="bg-muted/50 h-16 w-full animate-pulse rounded-xl" />
        </div>
      ) : workspaces.length === 0 ? (
        <Card className="text-muted-foreground px-5 py-6 text-sm">
          {t('empty')}
        </Card>
      ) : (
        <ul className="space-y-2" aria-label={t('title')}>
          {workspaces.map((w) => {
            const active = w.accountId === activeWorkspaceId;
            const badge = badgeFor(w.accountId, badges);
            const switchable = isSwitchableWorkspace(w);
            const busy = switchingTo === w.accountId;
            return (
              <li
                key={w.accountId}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'bg-card flex items-center gap-3.5 rounded-xl border p-3.5',
                  active ? 'border-primary/50' : 'border-border',
                  !switchable && 'opacity-70'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold',
                    active
                      ? 'bg-primary-soft text-primary'
                      : 'bg-muted text-foreground'
                  )}
                >
                  {workspaceTileLabel(w)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground truncate text-sm font-semibold">
                      {w.name || t('unnamed')}
                    </span>
                    {active ? (
                      <span className="bg-primary-soft text-primary rounded-full px-2 py-0.5 text-[11px] font-semibold">
                        {t('active')}
                      </span>
                    ) : null}
                    {w.deactivated ? (
                      <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[11px] font-medium">
                        {tSidebar('workspaceDeactivated')}
                      </span>
                    ) : null}
                    {w.archived ? (
                      <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[11px] font-medium">
                        {t('archived')}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    {w.role ? (
                      <span>{tSidebar(ROLE_LABEL_KEY[w.role])}</span>
                    ) : null}
                    {badge?.kind === 'mentions' ? (
                      <span className="bg-primary text-primary-foreground inline-flex h-5 min-w-5 items-center rounded-full px-1.5 text-[11px] font-semibold">
                        {t('mentions', { count: badge.count })}
                      </span>
                    ) : badge ? (
                      <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
                        <span
                          aria-hidden="true"
                          className="bg-primary size-2 rounded-full"
                        />
                        {t('unread')}
                      </span>
                    ) : null}
                  </div>
                  {w.archived ? (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('archivedHint')}
                    </p>
                  ) : null}
                </div>
                {!active && switchable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!switchingTo}
                    aria-label={t('switchTo', { name: w.name })}
                    onClick={() => void choose(w)}
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                    {busy ? t('switching') : t('switch')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canCreate ? (
        <CreateWorkspaceDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreatedElsewhere={() => void refreshProfile()}
        />
      ) : null}
    </section>
  );
}
