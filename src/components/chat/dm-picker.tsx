'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { openDm, type ChatPerson } from '@/lib/chat';
import {
  dmCandidates,
  DM_MAX_OTHERS,
  filterPeople,
  togglePick,
} from '@/lib/chat/compose';
import { avatarTint, initialOf, roleLabelKey } from '@/lib/chat/view';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';

export const GREEN_BUTTON =
  'bg-[#0E7C5A] text-white hover:bg-[#0B6A4C] disabled:opacity-50';

/**
 * Search + tick list of people, with the picked ones as removable chips
 * above. Adding stops at `max`; the boxes of the rest are disabled then.
 */
export function PeoplePicker({
  candidates,
  picked,
  onChange,
  max,
  autoFocus,
}: {
  candidates: readonly ChatPerson[];
  picked: readonly string[];
  onChange: (ids: string[]) => void;
  max?: number;
  autoFocus?: boolean;
}) {
  const t = useTranslations('Chat.picker');
  const tChat = useTranslations('Chat');
  const tRole = useTranslations('Sidebar');
  const [q, setQ] = useState('');
  const shown = useMemo(() => filterPeople(candidates, q), [candidates, q]);
  const byId = useMemo(
    () => new Map(candidates.map((p) => [p.userId, p])),
    [candidates]
  );
  const full = max !== undefined && picked.length >= max;
  const nameOf = (p: ChatPerson | undefined) =>
    p?.fullName?.trim() || tChat('unknownPerson');

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {picked.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('picked')}>
          {picked.map((id) => {
            const name = nameOf(byId.get(id));
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onChange(togglePick(picked, id))}
                  aria-label={t('remove', { name })}
                  className="flex items-center gap-1 rounded-full bg-emerald-50 py-0.5 pr-1.5 pl-2.5 text-xs font-semibold text-[#0E7C5A] hover:bg-emerald-100 [[data-mode=dark]_&]:bg-emerald-500/15 [[data-mode=dark]_&]:text-emerald-300"
                >
                  {name}
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <label className="border-input bg-background focus-within:border-ring flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
        <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('search')}
          aria-label={t('search')}
          autoFocus={autoFocus}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </label>
      {full && (
        <p className="text-muted-foreground text-xs" role="status">
          {t('limit', { max: max ?? 0 })}
        </p>
      )}
      <ul className="max-h-72 min-h-0 overflow-y-auto rounded-lg border">
        {shown.length === 0 ? (
          <li className="text-muted-foreground px-3 py-6 text-center text-sm">
            {t('none')}
          </li>
        ) : (
          shown.map((p) => {
            const on = picked.includes(p.userId);
            const roleKey = roleLabelKey(p.role);
            return (
              <li key={p.userId}>
                <label
                  className={cn(
                    'hover:bg-muted/60 flex cursor-pointer items-center gap-3 px-3 py-2',
                    on && 'bg-muted/40',
                    !on && full && 'cursor-not-allowed opacity-50'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && full}
                    onChange={() => onChange(togglePick(picked, p.userId, max))}
                    className="size-4 shrink-0 accent-[#0E7C5A]"
                  />
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold',
                      avatarTint(p.userId)
                    )}
                    aria-hidden
                  >
                    {initialOf(p.fullName)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {nameOf(p)}
                    </span>
                    {roleKey && (
                      <span className="text-muted-foreground block truncate text-xs">
                        {tRole(roleKey)}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

function DmPickerBody({ onDone }: { onDone: () => void }) {
  const t = useTranslations('Chat.dm');
  const router = useRouter();
  const ws = useChatWorkspaceContext();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(
    () => dmCandidates(ws.people, ws.userId),
    [ws.people, ws.userId]
  );

  const open = async () => {
    if (!ws.accountId || picked.length === 0 || busy) return;
    setBusy(true);
    try {
      const id = await openDm(ws.sb, {
        accountId: ws.accountId,
        memberIds: picked,
      });
      await ws.reloadChannels();
      onDone();
      router.push(`/chat/${id}`);
    } catch (err) {
      ws.fail(err);
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg font-bold">{t('title')}</DialogTitle>
        <DialogDescription>
          {t('subtitle', { max: DM_MAX_OTHERS })}
        </DialogDescription>
      </DialogHeader>
      <PeoplePicker
        candidates={candidates}
        picked={picked}
        onChange={setPicked}
        max={DM_MAX_OTHERS}
        autoFocus
      />
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          {t('cancel')}
        </Button>
        <Button
          className={GREEN_BUTTON}
          disabled={picked.length === 0 || busy}
          onClick={() => void open()}
        >
          {t('open')}
        </Button>
      </DialogFooter>
    </>
  );
}

/** "New message": pick 1–7 people, then open (or reopen) that DM. */
export function DmPicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && <DmPickerBody onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
