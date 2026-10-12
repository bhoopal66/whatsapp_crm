'use client';

// ============================================================
// The workspace rail (migration 083): a narrow column at the far left
// of the sidebar, one tile per workspace the person belongs to, and a
// "+" tile for owners and admins that opens "Create a workspace".
//
// The rail is dark in BOTH modes, by design, so its colours are fixed
// rather than mode tokens. The badges come from
// `chat_workspace_badges()` (087): team-chat unread and mentions for
// every workspace at once. Badges are a courtesy, so a failed read
// shows none rather than an error.
//
// Switching reloads the app in the chosen workspace (`switchWorkspace`).
// The sidebar decides whether to render the rail (`showWorkspaceRail`).
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { CreateWorkspaceDialog } from '@/components/workspaces/create-workspace-dialog';
import { useAuth } from '@/hooks/use-auth';
import type { Workspace } from '@/lib/auth/my-workspaces';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import {
  badgeFor,
  parseWorkspaceBadges,
  type WorkspaceBadgeRow,
} from '@/lib/workspaces/form';

/** How often the badges are re-read while the app is open. */
const BADGE_REFRESH_MS = 60_000;

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

function tileLabel(workspace: Workspace): string {
  return workspace.shortName ?? (workspace.name.charAt(0).toUpperCase() || '?');
}

export function WorkspaceRail({ canCreate }: { canCreate: boolean }) {
  const t = useTranslations('Workspaces.rail');
  const tSidebar = useTranslations('Sidebar');
  const { workspaces, activeWorkspaceId, switchWorkspace, refreshProfile } =
    useAuth();
  const badges = useWorkspaceBadges(workspaces.length > 0);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const choose = async (workspace: Workspace) => {
    if (workspace.accountId === activeWorkspaceId || switchingTo) return;
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
    <nav
      aria-label={t('label')}
      className="flex w-16 shrink-0 flex-col items-center gap-3 overflow-y-auto bg-[#0b1f17] py-3"
    >
      <ul className="flex flex-col items-center gap-3">
        {workspaces.map((w) => {
          const active = w.accountId === activeWorkspaceId;
          const badge = badgeFor(w.accountId, badges);
          // switch_account() refuses a deactivated membership.
          const disabled = w.deactivated || (!!switchingTo && !active);
          const description = [
            w.name,
            w.deactivated ? tSidebar('workspaceDeactivated') : null,
            badge?.kind === 'mentions'
              ? t('mentions', { count: badge.count })
              : badge
                ? t('unread')
                : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={w.accountId}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={description}
                      aria-current={active ? 'true' : undefined}
                      disabled={disabled}
                      onClick={() => choose(w)}
                      className={cn(
                        'relative flex size-11 items-center justify-center rounded-xl text-sm font-bold text-white transition-colors focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none',
                        active
                          ? 'bg-[#00a884] ring-2 ring-[#25d366] ring-offset-2 ring-offset-[#0b1f17]'
                          : 'bg-[#2a3530] hover:bg-[#35433d]',
                        w.deactivated && 'opacity-40',
                        disabled && !w.deactivated && 'opacity-70'
                      )}
                    >
                      {switchingTo === w.accountId ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        tileLabel(w)
                      )}
                      {badge?.kind === 'mentions' ? (
                        <span className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#f15c6d] px-1 text-[10px] font-semibold text-white ring-2 ring-[#0b1f17]">
                          {badge.count > 9 ? '9+' : badge.count}
                        </span>
                      ) : badge ? (
                        <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-white ring-2 ring-[#0b1f17]" />
                      ) : null}
                    </button>
                  }
                />
                <TooltipContent side="right">{description}</TooltipContent>
              </Tooltip>
            </li>
          );
        })}
      </ul>

      {canCreate ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('create')}
                  onClick={() => setCreateOpen(true)}
                  className="flex size-11 items-center justify-center rounded-xl border-2 border-dashed border-white/30 text-white/70 transition-colors hover:border-white/60 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                >
                  <Plus className="size-5" />
                </button>
              }
            />
            <TooltipContent side="right">{t('create')}</TooltipContent>
          </Tooltip>
          <CreateWorkspaceDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreatedElsewhere={() => void refreshProfile()}
          />
        </>
      ) : null}
    </nav>
  );
}
