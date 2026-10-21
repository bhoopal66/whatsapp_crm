'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { canArchiveWorkspace } from '@/lib/auth/roles';
import { MAX_WORKSPACE_NAME, planWorkspaceRename } from '@/lib/workspaces/form';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { SettingsPanelHead } from './settings-panel-head';
import {
  ArchivedWorkspacesCard,
  ArchiveWorkspaceCard,
} from './workspace-archive';

const ERROR_TEXT = 'text-destructive text-xs';

/**
 * Settings → Team → Workspace (admin+): the workspace's name and the
 * short name on its tile in Settings → Workspaces, saved through PATCH /api/account, which
 * sends only what changed. planWorkspaceRename holds the route's rules,
 * so a field is checked as it is typed. After a save, refreshProfile()
 * re-reads the account and my_workspaces(), so the workspace list and headers
 * show the new names without a reload.
 *
 * An owner also archives the workspace here, and restores archived
 * ones (`workspace-archive.tsx`, migration 105).
 */
export function WorkspacePanel() {
  const t = useTranslations('Settings.workspace');
  const { account, accountId, accountRole, workspaces, refreshProfile } =
    useAuth();
  // null while untouched: the fields show what is saved.
  const [draft, setDraft] = useState<{
    name: string;
    shortName: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // The account summary has no short name; my_workspaces() does.
  const shortName =
    workspaces.find((w) => w.accountId === accountId)?.shortName ?? null;
  const saved = account ? { name: account.name, shortName } : null;

  if (!saved) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t('loading')}
      </p>
    );
  }

  const values = draft ?? {
    name: saved.name,
    shortName: saved.shortName ?? '',
  };
  const plan = planWorkspaceRename(saved, values);

  async function save() {
    if (!plan.payload || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan.payload),
      });
      if (!res.ok) throw new Error(`PATCH /api/account ${res.status}`);
      toast.success(t('saved'));
      await refreshProfile();
      setDraft(null);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 max-w-2xl duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <Card>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <div className="space-y-1.5">
                <Label htmlFor="workspace-name">{t('nameLabel')}</Label>
                <Input
                  id="workspace-name"
                  value={values.name}
                  maxLength={120}
                  aria-invalid={!!plan.nameError}
                  onChange={(e) =>
                    setDraft({ ...values, name: e.target.value })
                  }
                  className="bg-muted border-border"
                />
                {plan.nameError ? (
                  <p className={ERROR_TEXT}>
                    {t(`errors.${plan.nameError}`, {
                      max: MAX_WORKSPACE_NAME,
                    })}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workspace-short-name">
                  {t('shortNameLabel')}
                </Label>
                <Input
                  id="workspace-short-name"
                  value={values.shortName}
                  maxLength={4}
                  aria-invalid={!!plan.shortNameError}
                  onChange={(e) =>
                    setDraft({ ...values, shortName: e.target.value })
                  }
                  className="bg-muted border-border font-semibold tracking-wider"
                />
                <p
                  className={cn(
                    'text-xs',
                    plan.shortNameError ? ERROR_TEXT : 'text-muted-foreground'
                  )}
                >
                  {plan.shortNameError
                    ? t(`errors.${plan.shortNameError}`)
                    : t('shortNameHint')}
                </p>
              </div>
            </div>
            <Button
              type="submit"
              disabled={saving || !plan.payload}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('save')
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
      {accountRole && canArchiveWorkspace(accountRole) ? (
        <ArchiveWorkspaceCard name={saved.name} />
      ) : null}
      <ArchivedWorkspacesCard />
    </section>
  );
}
