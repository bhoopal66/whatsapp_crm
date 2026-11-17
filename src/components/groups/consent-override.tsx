'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { canOverrideGroupConsent } from '@/lib/auth/roles';
import {
  reasonKey,
  summarizeAddMembers,
  type AddMembersSummary,
} from '@/lib/groups/group-page';

/**
 * Owner/admin only: add the people the consent screen left out anyway.
 * The server re-checks the role (403 `not_allowed`); this only decides
 * whether to offer the button.
 */
export function ConsentOverride({
  groupId,
  skippedWaIds,
  onResult,
}: {
  groupId: string;
  skippedWaIds: string[];
  onResult: (summary: AddMembersSummary) => void;
}) {
  const t = useTranslations('Groups.consentOverride');
  const tp = useTranslations('Groups.page');
  const { accountRole } = useAuth();
  const [busy, setBusy] = useState(false);

  if (
    !accountRole ||
    !canOverrideGroupConsent(accountRole) ||
    skippedWaIds.length === 0
  ) {
    return null;
  }

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phones: skippedWaIds,
          contactIds: [],
          overrideConsent: true,
        }),
      });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const code = (json as { code?: string } | null)?.code;
        toast.error(tp(`reasons.${reasonKey(code)}`));
        return;
      }
      onResult(summarizeAddMembers(json));
    } catch {
      toast.error(tp('reasons.unknown'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-warning/30 bg-warning-soft text-warning flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-xs">
      <p>{t('warning')}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void run()}
      >
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {t('addAnyway')}
      </Button>
    </div>
  );
}
