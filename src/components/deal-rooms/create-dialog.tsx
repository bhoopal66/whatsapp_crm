'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import {
  CONSENT_METHODS,
  GROUP_NAME_MAX,
  allowedGuestBanks,
  canAddInvitee,
  clip,
  createOutcome,
  createRoomBody,
  dealChoices,
  dealOptionLabel,
  defaultGroupName,
  groupNameOk,
  initialCreateState,
  inviteeIssues,
  placesTaken,
  withCustomer,
  type ConsentMethod,
  type Invitee,
  type InviteeRole,
} from '@/lib/deal-rooms/create-form';
import type {
  DealRoomContact as Contact,
  DealRoomDeal as Deal,
} from '@/lib/deal-rooms/entry';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

const field = 'bg-background w-full rounded-md border px-2 py-1.5 text-sm';

interface Prefill {
  /** The customer the room is for: picked, and on the list. */
  initialContact?: Contact | null;
  /** The deal it links: chosen, even when it is no longer open. */
  initialDeal?: Deal | null;
}

function CreateBody({
  onDone,
  initialContact,
  initialDeal,
}: { onDone: () => void } & Prefill) {
  const t = useTranslations('Chat.rooms.create');
  const router = useRouter();
  const sb = useMemo(() => createClient(), []);
  const { account, workspaces, activeWorkspaceId } = useAuth();
  const workspace =
    workspaces.find((w) => w.accountId === activeWorkspaceId)?.name ??
    account?.name ??
    '';
  // The body mounts when the dialog opens: the prefill is read once.
  const [seed] = useState(() =>
    initialCreateState({ contact: initialContact, deal: initialDeal })
  );
  const [keepDeal] = useState(() =>
    seed.dealId && initialDeal ? initialDeal : null
  );
  const [query, setQuery] = useState(seed.query);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contact, setContact] = useState<Contact | null>(seed.contact);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealId, setDealId] = useState(seed.dealId);
  const [subject, setSubject] = useState('');
  const [named, setNamed] = useState(false);
  const [invitees, setInvitees] = useState<Invitee[]>(seed.invitees);
  const [banks, setBanks] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Invitee>({
    displayName: '',
    phone: '',
    role: 'partner',
  });
  const [consent, setConsent] = useState(false);
  const [method, setMethod] = useState<ConsentMethod>('verbal');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void sb
      .from('bank_guest_policies')
      .select('bank_code, guests_allowed')
      .then(({ data }) => setBanks(allowedGuestBanks(data ?? [])));
  }, [sb]);
  useEffect(() => {
    const q = query.trim().replace(/[%,()]/g, ' ');
    const id = setTimeout(() => {
      let req = sb.from('contacts').select('id, name, phone, company');
      if (q)
        req = req.or(
          `name.ilike.%${q}%,company.ilike.%${q}%,phone.ilike.%${q}%`
        );
      void req
        .order('updated_at', { ascending: false })
        .limit(20)
        .then(({ data }) => setContacts((data ?? []) as Contact[]));
    }, 250);
    return () => clearTimeout(id);
  }, [sb, query]);

  // The contact whose deals were asked for last: a slower answer for an
  // earlier pick is dropped.
  const dealsFor = useRef<string | null>(null);
  const loadDeals = useCallback(
    async (contactId: string, keep: Deal | null) => {
      dealsFor.current = contactId;
      const { data } = await sb
        .from('deals')
        .select('id, title')
        .eq('contact_id', contactId)
        .eq('status', 'open')
        .order('created_at', { ascending: false });
      if (dealsFor.current !== contactId) return;
      setDeals(dealChoices((data ?? []) as Deal[], keep));
    },
    [sb]
  );
  useEffect(() => {
    if (seed.contact) void loadDeals(seed.contact.id, keepDeal);
  }, [seed, keepDeal, loadDeals]);

  const deal = deals.find((d) => d.id === dealId) ?? null;
  const name = named
    ? subject
    : contact
      ? defaultGroupName({
          customer: contact.name ?? contact.phone ?? '',
          workspace,
          deal: deal?.title,
        })
      : '';
  const pick = async (c: Contact) => {
    setContact(c);
    setDealId('');
    setInvitees((list) => withCustomer(list, c));
    await loadDeals(c.id, null);
  };
  const issues = inviteeIssues(invitees, banks);
  const ready =
    !!contact && groupNameOk(name) && issues.length === 0 && consent && !busy;

  const create = async () => {
    if (!contact || !ready) return;
    setBusy(true);
    try {
      const body = createRoomBody({
        contactId: contact.id,
        dealId: dealId || null,
        subject: name,
        invitees,
        method,
        consentText: t('consentText', {
          customer: contact.name ?? contact.phone ?? '',
          group: name.trim(),
          people: invitees.map((p) => p.displayName.trim()).join(', '),
          workspace,
        }),
      });
      const res = await fetch('/api/deal-rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const outcome = createOutcome(res, await res.json().catch(() => ({})));
      if (outcome.error) {
        toast.error(t('failed', { error: outcome.error }));
      }
      if (outcome.roomId) {
        onDone();
        router.push(`/chat/rooms/${outcome.roomId}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const chip = (p: Invitee) =>
    p.role === 'bank_guest'
      ? t('chip.bank', { name: p.displayName, bank: p.bankCode ?? '' })
      : t(`chip.${p.role}`, { name: p.displayName });
  const issue = issues[0];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description', { workspace })}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">{t('link')}</label>
          <input
            className={field}
            value={query}
            placeholder={t('search')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="max-h-40 overflow-y-auto rounded-md border">
            {contacts.length === 0 && (
              <li className="text-muted-foreground p-2 text-xs">
                {t('noCustomers')}
              </li>
            )}
            {contacts.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => void pick(c)}
                  className={cn(
                    'hover:bg-muted w-full px-2 py-1.5 text-left text-sm',
                    contact?.id === c.id && 'bg-muted font-medium'
                  )}
                >
                  {dealOptionLabel({
                    contactName: c.name,
                    company: c.company,
                    dealTitle: null,
                  })}
                </button>
              </li>
            ))}
          </ul>
          {contact && (
            <select
              aria-label={t('deal')}
              className={field}
              value={dealId}
              onChange={(e) => setDealId(e.target.value)}
            >
              <option value="">{t('noDeal')}</option>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>
                  {dealOptionLabel({
                    contactName: contact.name,
                    company: contact.company,
                    dealTitle: d.title,
                  })}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="deal-room-name">
            {t('groupName')}
          </label>
          <input
            id="deal-room-name"
            className={field}
            value={name}
            maxLength={GROUP_NAME_MAX}
            onChange={(e) => {
              setNamed(true);
              setSubject(clip(e.target.value, GROUP_NAME_MAX));
            }}
          />
          <p className="text-muted-foreground text-right text-xs">
            {Array.from(name).length} / {GROUP_NAME_MAX}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t('who')}</p>
        <div className="flex flex-wrap gap-2">
          {invitees.map((p, i) => (
            <span
              key={`${p.phone}-${i}`}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs',
                p.role === 'bank_guest'
                  ? 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300'
                  : 'bg-muted text-foreground'
              )}
            >
              {chip(p)}
              <button
                type="button"
                aria-label={t('remove', { name: p.displayName })}
                onClick={() => setInvitees((l) => l.filter((_, j) => j !== i))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {canAddInvitee(invitees.length) && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="text-muted-foreground inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs"
            >
              <Plus className="size-3" /> {t('add')}
            </button>
          )}
        </div>
        {adding && (
          <div className="grid gap-2 rounded-md border p-2 sm:grid-cols-4">
            <input
              className={field}
              placeholder={t('name')}
              value={draft.displayName}
              onChange={(e) =>
                setDraft({ ...draft, displayName: e.target.value })
              }
            />
            <input
              className={field}
              placeholder={t('phone')}
              inputMode="tel"
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            />
            <select
              aria-label={t('role')}
              className={field}
              value={draft.role}
              onChange={(e) =>
                setDraft({ ...draft, role: e.target.value as InviteeRole })
              }
            >
              {(['customer', 'partner', 'bank_guest'] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </select>
            {draft.role === 'bank_guest' ? (
              <select
                aria-label={t('bank')}
                className={field}
                value={draft.bankCode ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, bankCode: e.target.value })
                }
              >
                <option value="">
                  {banks.size ? t('bank') : t('noBanks')}
                </option>
                {[...banks].sort().map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <span />
            )}
            <div className="flex gap-2 sm:col-span-4">
              <Button
                size="sm"
                onClick={() => {
                  setInvitees((l) => [...l, draft]);
                  setDraft({ displayName: '', phone: '', role: 'partner' });
                  setAdding(false);
                }}
                disabled={!draft.displayName.trim() || !draft.phone.trim()}
              >
                {t('addConfirm')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAdding(false)}
              >
                {t('cancel')}
              </Button>
            </div>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          {t('places', { workspace, places: placesTaken(invitees.length) })}
        </p>
        {invitees.some((p) => p.role === 'bank_guest') && (
          <p className="text-xs text-violet-800 dark:text-violet-300">
            {t('guestWaits')}
          </p>
        )}
        {issue && invitees.length > 0 && (
          <p role="alert" className="text-destructive text-xs">
            {t(
              `issues.${issue.kind}`,
              'name' in issue
                ? { name: issue.name }
                : 'max' in issue
                  ? { max: issue.max }
                  : {}
            )}
          </p>
        )}
      </div>

      <div className="border-warning/40 bg-warning-soft text-foreground rounded-md border p-3 text-xs">
        <p className="font-semibold">{t('before.title')}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>{t('before.phones')}</li>
          <li>{t('before.max', { workspace })}</li>
          <li>{t('before.cost')}</li>
          <li>{t('before.limits')}</li>
        </ul>
        <label className="mt-2 flex items-start gap-2">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5"
          />
          <span className="font-medium">{t('consent')}</span>
        </label>
        <select
          aria-label={t('method')}
          className={cn(field, 'mt-2 sm:w-56')}
          value={method}
          onChange={(e) => setMethod(e.target.value as ConsentMethod)}
        >
          {CONSENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`methods.${m}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground mr-auto text-xs">{t('footer')}</p>
        <Button variant="outline" onClick={onDone}>
          {t('cancel')}
        </Button>
        <Button
          disabled={!ready}
          onClick={() => void create()}
          className="bg-[#8A5A1E] text-white hover:bg-[#744A16]"
        >
          {busy ? t('creating') : t('submit')}
        </Button>
      </div>
    </>
  );
}

/**
 * "New deal room": from the New channel dialog and the rooms sidebar,
 * and (prefilled) from the customer page, a pipeline deal and the inbox
 * contact panel.
 */
export function CreateDealRoomDialog({
  open,
  onOpenChange,
  initialContact,
  initialDeal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Prefill) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[860px]">
        {open && (
          <CreateBody
            onDone={() => onOpenChange(false)}
            initialContact={initialContact}
            initialDeal={initialDeal}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
