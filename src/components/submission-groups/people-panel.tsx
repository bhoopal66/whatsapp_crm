'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { Button } from '@/components/ui/button';
import {
  addableStaff,
  STAFF_LABELS,
  type SgAccess,
  type StaffLabel,
} from '@/lib/submission-groups/ui';

const selectClass =
  'border-border bg-background text-foreground h-8 rounded-md border px-2 text-sm';

/** The group's access list; an admin adds, relabels and removes while it is ACTIVE. */
export function PeoplePanel({
  groupId,
  access,
  editable,
  onChanged,
}: {
  groupId: string;
  access: SgAccess[];
  editable: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('SubmissionGroups.people');
  const tl = useTranslations('SubmissionGroups.labels');
  const { members } = useWorkspaceMembers();
  const [busy, setBusy] = useState<string | null>(null);
  const [addUser, setAddUser] = useState('');
  const [addLabel, setAddLabel] = useState<StaffLabel>('agent');
  const [removing, setRemoving] = useState<SgAccess | null>(null);

  const candidates = addableStaff(members, access);

  const put = async (userId: string, label: StaffLabel) => {
    setBusy(userId);
    try {
      const res = await fetch(`/api/submission-groups/${groupId}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, label }),
      });
      if (!res.ok) {
        toast.error(t('saveFailed'));
        return false;
      }
      onChanged();
      return true;
    } catch {
      toast.error(t('saveFailed'));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: SgAccess) => {
    setRemoving(null);
    setBusy(row.user_id);
    try {
      const qs = new URLSearchParams({ user_id: row.user_id });
      const res = await fetch(
        `/api/submission-groups/${groupId}/access?${qs}`,
        { method: 'DELETE' }
      );
      if (!res.ok) toast.error(t('removeFailed'));
      else onChanged();
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!addUser) return;
    if (await put(addUser, addLabel)) setAddUser('');
  };

  return (
    <section className="bg-card space-y-3 rounded-lg border p-3">
      <div>
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground text-xs">{t('hint')}</p>
      </div>
      {access.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-border divide-y">
          {access.map((a) => (
            <li key={a.user_id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {a.name || t('unknown')}
              </span>
              {editable ? (
                <>
                  <select
                    value={a.label}
                    disabled={busy === a.user_id}
                    aria-label={t('labelFor', { name: a.name ?? '' })}
                    onChange={(e) =>
                      void put(a.user_id, e.target.value as StaffLabel)
                    }
                    className={selectClass}
                  >
                    {STAFF_LABELS.map((l) => (
                      <option key={l} value={l}>
                        {tl(l)}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('remove', { name: a.name ?? '' })}
                    disabled={busy === a.user_id}
                    onClick={() => setRemoving(a)}
                  >
                    {busy === a.user_id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <X className="size-4" />
                    )}
                  </Button>
                </>
              ) : (
                <span className="bg-success-soft text-success shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
                  {tl(a.label)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <div className="border-border space-y-2 border-t pt-3">
          <p className="text-xs font-medium">{t('add')}</p>
          <select
            value={addUser}
            onChange={(e) => setAddUser(e.target.value)}
            aria-label={t('person')}
            className={`${selectClass} w-full`}
          >
            <option value="">{t('pickPerson')}</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <select
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value as StaffLabel)}
              aria-label={t('label')}
              className={`${selectClass} flex-1`}
            >
              {STAFF_LABELS.map((l) => (
                <option key={l} value={l}>
                  {tl(l)}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!addUser || busy !== null}
              onClick={() => void add()}
            >
              <Plus className="size-4" aria-hidden />
              {t('addButton')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('removeTitle')}
        description={t('removeBody', { name: removing?.name ?? '' })}
        cancelLabel={t('cancel')}
        confirmLabel={t('removeConfirm')}
        onConfirm={() => removing && void remove(removing)}
        destructive
      />
    </section>
  );
}
