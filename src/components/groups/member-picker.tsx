'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  contactSearchFilter,
  GROUP_ADD_BATCH,
  GROUP_ADD_PAUSE_SECONDS,
  GROUP_MEMBERS_PER_OPERATION,
  type mergeMembers,
  type PickedContact,
} from '@/lib/groups/ui';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

/**
 * Contact search plus typed numbers, with the running count and the pacing
 * note. Shared by the create wizard and the group's "Add members" dialog;
 * the caller owns the picked contacts and the typed text.
 */
export function MemberPicker({
  accountId,
  contacts,
  typedText,
  onContactsChange,
  onTypedTextChange,
  merged,
  typedInvalid,
}: {
  accountId: string | null;
  contacts: PickedContact[];
  typedText: string;
  onContactsChange: (v: PickedContact[]) => void;
  onTypedTextChange: (v: string) => void;
  merged: ReturnType<typeof mergeMembers>;
  typedInvalid: { input: string }[];
}) {
  const t = useTranslations('Groups.create');
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PickedContact[] | null>(null);
  const filter = contactSearchFilter(search);

  useEffect(() => {
    if (!filter || !accountId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { data } = await createClient()
        .from('contacts')
        .select('id, name, phone')
        .eq('account_id', accountId)
        .or(filter)
        .order('name')
        .limit(20);
      if (!cancelled) setHits((data ?? []) as PickedContact[]);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setHits(null);
    };
  }, [filter, accountId]);

  const picked = new Set(contacts.map((c) => c.id));
  const count = merged.members.length;
  const over = count > GROUP_MEMBERS_PER_OPERATION;

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="group-contact-search">{t('contactsLabel')}</Label>
        {contacts.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {contacts.map((c) => {
              const name = c.name || c.phone || c.id;
              return (
                <li
                  key={c.id}
                  className="bg-muted flex max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs"
                >
                  <span className="max-w-40 truncate">{name}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                    aria-label={t('removeMember', { name })}
                    onClick={() =>
                      onContactsChange(contacts.filter((x) => x.id !== c.id))
                    }
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <Input
          id="group-contact-search"
          type="search"
          value={search}
          placeholder={t('contactsSearch')}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        {search.trim() && (
          <ul className="border-border max-h-44 overflow-y-auto rounded-lg border">
            {!filter ? (
              <li className="text-muted-foreground px-3 py-2 text-xs">
                {t('contactsTypeMore')}
              </li>
            ) : hits === null ? (
              <li className="text-muted-foreground px-3 py-2 text-xs">
                {t('contactsSearching')}
              </li>
            ) : hits.length === 0 ? (
              <li className="text-muted-foreground px-3 py-2 text-xs">
                {t('contactsNone')}
              </li>
            ) : (
              hits.map((c) => (
                <li key={c.id}>
                  <label className="hover:bg-muted flex cursor-pointer items-center gap-2 px-3 py-1.5">
                    <Checkbox
                      checked={picked.has(c.id)}
                      onCheckedChange={(v) =>
                        onContactsChange(
                          v
                            ? [...contacts, c]
                            : contacts.filter((x) => x.id !== c.id)
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {c.name || c.phone}
                      {c.name && c.phone && (
                        <span className="text-muted-foreground ml-1.5 text-xs">
                          {c.phone}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))
            )}
          </ul>
        )}
        {merged.unusableContacts.map((c) => (
          <p
            key={c.id}
            className="text-xs text-amber-700 [[data-mode=dark]_&]:text-amber-300"
          >
            {t('noPhone', { name: c.name || c.id })}
          </p>
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="group-phones">{t('phonesLabel')}</Label>
        <Textarea
          id="group-phones"
          rows={3}
          value={typedText}
          placeholder={t('phonesPlaceholder')}
          onChange={(e) => onTypedTextChange(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">{t('phonesHint')}</p>
        {typedInvalid.map((x) => (
          <p key={x.input} className="text-destructive text-xs">
            {t('invalidNumber', { input: x.input })}
          </p>
        ))}
      </div>

      <div
        className={cn(
          'space-y-1 rounded-lg border p-3 text-xs',
          over
            ? 'border-amber-300 bg-amber-50 text-amber-900 [[data-mode=dark]_&]:border-amber-900 [[data-mode=dark]_&]:bg-amber-950 [[data-mode=dark]_&]:text-amber-200'
            : 'border-border bg-muted/40 text-muted-foreground'
        )}
      >
        <p className="text-foreground font-medium tabular-nums">
          {t('memberCount', { count, max: GROUP_MEMBERS_PER_OPERATION })}
        </p>
        {over && <p>{t('overCap', { max: GROUP_MEMBERS_PER_OPERATION })}</p>}
        <p>
          {t('pacingNote', {
            batch: GROUP_ADD_BATCH,
            seconds: GROUP_ADD_PAUSE_SECONDS,
          })}
        </p>
      </div>
    </>
  );
}
