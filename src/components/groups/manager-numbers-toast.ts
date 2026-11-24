'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { reasonKey } from '@/lib/groups/group-page';
import type { ManagerNumbersReport } from '@/lib/groups/manager-numbers';

/** Says what happened to the managers' saved numbers (PUT and create). */
export function useManagerNumbersToast() {
  const t = useTranslations('Groups.page');
  const m = useTranslations('Groups.page.managersTab');
  const who = (name: string) => name || m('unnamed');
  return (numbers: ManagerNumbersReport | null | undefined) => {
    for (const name of numbers?.added ?? []) {
      toast.success(m('numberAdded', { name: who(name) }));
    }
    for (const name of numbers?.removed ?? []) {
      toast.success(m('numberRemoved', { name: who(name) }));
    }
    for (const f of numbers?.failed ?? []) {
      toast.error(
        f.reason === 'refused'
          ? m('numberRefused', { name: who(f.name) })
          : m('numberFailed', {
              name: who(f.name),
              reason: t(`reasons.${reasonKey(f.reason)}`),
            })
      );
    }
  };
}
