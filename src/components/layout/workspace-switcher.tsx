'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronsUpDown, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import type { Workspace } from '@/lib/auth/my-workspaces';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** The workspace's short name in a square chip ("TC"). */
function ShortChip({ workspace }: { workspace: Workspace }) {
  return (
    <span className="bg-primary/10 text-primary flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold">
      {workspace.shortName ?? workspace.name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Compact switcher for a person in several workspaces (migration 083):
 * the active workspace, and a menu of the others. Switching reloads the
 * app in the chosen workspace (see `switchWorkspace`). Interim: the
 * workspace rail from the design replaces it.
 */
export function WorkspaceSwitcher() {
  const t = useTranslations('Sidebar');
  const { workspaces, activeWorkspaceId, switchWorkspace } = useAuth();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const active =
    workspaces.find((w) => w.accountId === activeWorkspaceId) ??
    workspaces.find((w) => w.isActive);
  const others = workspaces.filter((w) => w !== active);
  if (!active || others.length === 0) return null;

  const choose = async (workspace: Workspace) => {
    setSwitchingTo(workspace.accountId);
    try {
      // Resolves into a page load, so the state is never reset on success.
      await switchWorkspace(workspace.accountId);
    } catch (err) {
      setSwitchingTo(null);
      toast.error(
        t('workspaceSwitchFailed', {
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('switchWorkspace')}
        className="hover:bg-muted/60 focus:bg-muted/60 data-popup-open:bg-muted/60 mb-2 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors focus:outline-none"
      >
        <ShortChip workspace={active} />
        <span
          className="text-foreground min-w-0 flex-1 truncate font-medium"
          title={active.name}
        >
          {active.name}
        </span>
        {switchingTo ? (
          <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
        ) : (
          <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        className="bg-popover text-popover-foreground ring-border min-w-56"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('switchWorkspace')}</DropdownMenuLabel>
          {others.map((w) => (
            <DropdownMenuItem
              key={w.accountId}
              // switch_account() refuses a deactivated membership.
              disabled={w.deactivated || switchingTo !== null}
              onClick={() => choose(w)}
              className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
            >
              <ShortChip workspace={w} />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {w.deactivated ? (
                <span className="text-muted-foreground text-[10px] uppercase">
                  {t('workspaceDeactivated')}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
