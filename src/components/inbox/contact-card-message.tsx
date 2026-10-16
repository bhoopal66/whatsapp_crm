'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  UserRound,
  Phone,
  Mail,
  Building2,
  UserPlus,
  Check,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { validateContactPhone } from '@/lib/contacts/phone-validation';
import type { SharedContact } from '@/lib/whatsapp/contact-card';

/**
 * A contact card the customer shared, rendered the way WhatsApp shows
 * it — name, numbers, email, company — plus the one thing an agent
 * wants to do with it in a CRM: save it. Saving reuses an existing
 * contact with the same normalised number (the account-wide unique
 * index from migration 022) rather than creating a duplicate.
 */
export function ContactCardMessage({ cards }: { cards: SharedContact[] }) {
  return (
    <div className="flex flex-col gap-2">
      {cards.map((card, i) => (
        <ContactCard key={`${card.name}-${i}`} card={card} />
      ))}
    </div>
  );
}

function ContactCard({ card }: { card: SharedContact }) {
  const t = useTranslations('Inbox.contactCard');
  const { user, accountId } = useAuth();
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);

  // Neutral tints, so the card reads on the green outbound bubble and
  // the white inbound one alike.
  const muted = 'text-wa-meta';
  const primaryPhone = card.phones[0] ?? null;

  const save = async () => {
    if (!user || !accountId || !primaryPhone) return;
    // A card's TEL is whatever the sharer's address book holds, often
    // a local "050…" number; saved as-is, replies to it go nowhere.
    const checked = validateContactPhone(primaryPhone);
    if (!checked.ok) {
      toast.error(checked.error);
      return;
    }
    const key = checked.normalized;
    setSaving(true);
    try {
      const supabase = createClient();
      const { data: existing } = await supabase
        .from('contacts')
        .select('id')
        .eq('phone_normalized', key)
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        setSavedId(existing.id);
        toast.info(t('alreadySaved'));
        return;
      }
      const { data, error } = await supabase
        .from('contacts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: card.name || null,
          phone: key,
          email: card.emails[0] ?? null,
          company: card.org,
        })
        .select('id')
        .single();
      if (error) throw error;
      setSavedId(data.id);
      toast.success(t('saved', { name: card.name || primaryPhone }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn('bg-wa-quote min-w-56 rounded-lg p-3')}>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'bg-wa-avatar text-wa-avatar-fg flex h-9 w-9 shrink-0 items-center justify-center rounded-full'
          )}
        >
          <UserRound className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {card.name || primaryPhone || t('unnamed')}
          </p>
          {card.org && (
            <p
              className={cn('flex items-center gap-1 truncate text-xs', muted)}
            >
              <Building2 className="h-3 w-3 shrink-0" />
              {card.org}
            </p>
          )}
        </div>
      </div>

      {(card.phones.length > 0 || card.emails.length > 0) && (
        <ul className="mt-2 space-y-1">
          {card.phones.map((p) => (
            <li key={p} className="flex items-center gap-2 text-xs">
              <Phone className={cn('h-3 w-3 shrink-0', muted)} />
              <span className="break-all select-all">{p}</span>
            </li>
          ))}
          {card.emails.map((e) => (
            <li key={e} className="flex items-center gap-2 text-xs">
              <Mail className={cn('h-3 w-3 shrink-0', muted)} />
              <span className="break-all select-all">{e}</span>
            </li>
          ))}
        </ul>
      )}

      {primaryPhone && (
        <div className="border-wa-divider mt-2 border-t pt-2 text-xs">
          {savedId ? (
            <a
              href={`/contacts/${savedId}`}
              className={cn(
                'inline-flex items-center gap-1 hover:underline',
                muted
              )}
            >
              <Check className="h-3 w-3" />
              {t('viewContact')}
            </a>
          ) : (
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1 font-medium hover:underline disabled:opacity-60"
            >
              <UserPlus className="h-3 w-3" />
              {saving ? t('saving') : t('saveToContacts')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
