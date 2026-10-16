'use client';

// The customer page's header card: who the customer is, their chat tag
// and consent badges, and the actions this person may take
// (`headerActions`, from `customerAccess`). On a phone the secondary
// actions fold into the overflow menu.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Building2,
  Check,
  Copy,
  LayoutTemplate,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Phone,
  Trash2,
} from 'lucide-react';

import {
  ChatTagChip,
  OptedOutBadge,
} from '@/components/contacts/contact-badges';
import {
  ContactChannelHint,
  type ContactOutreachState,
} from '@/components/contacts/contact-outreach';
import { CallButton } from '@/components/pbx/call-button';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import type { AccountNumber } from '@/hooks/use-whatsapp-numbers';
import type { CustomerAccess } from '@/lib/contacts/customer-access';
import {
  headerActions,
  type HeaderAction,
} from '@/lib/contacts/customer-layout';
import type { SendChannelPrediction } from '@/lib/contacts/predict-send-channels';
import type { ConsentFields } from '@/lib/pbx/call-ui';
import { initials } from '@/lib/pbx/timeline';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

export interface HeaderContact extends ConsentFields {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
}

export function CustomerHeader({
  contact,
  ownerName,
  conversationId,
  chip,
  access,
  outreach,
  channels,
  prediction,
  onEdit,
  listPath = '/contacts',
}: {
  contact: HeaderContact;
  ownerName: string | null;
  conversationId: string | null;
  chip: { label: string; color: string } | null;
  access: CustomerAccess;
  outreach: ContactOutreachState;
  channels: readonly AccountNumber[] | null;
  prediction: SendChannelPrediction;
  onEdit: () => void;
  /** Where delete returns to: the list this customer was opened from. */
  listPath?: string;
}) {
  const tl = useTranslations('CustomerTimeline');
  const t = useTranslations('Contacts.detailView');
  const tp = useTranslations('Contacts.page');
  const tj = useTranslations('Journeys.consent');
  const locale = useLocale();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyPhone = async () => {
    try {
      await navigator.clipboard.writeText(contact.phone ?? '');
    } catch {
      return void toast.error(t('copyFailed'));
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const actions = headerActions(access);
  const title =
    contact.name || contact.company || contact.phone || t('unnamed');
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  const remove = async () => {
    setDeleting(true);
    const { error } = await createClient()
      .from('contacts')
      .delete()
      .eq('id', contact.id);
    setDeleting(false);
    if (error) return void toast.error(tp('toastFailedDelete'));
    toast.success(tp('toastDeleted'));
    setConfirm(false);
    router.push(listPath);
  };

  const button = (a: HeaderAction) => {
    switch (a) {
      case 'call':
        return (
          <CallButton
            key={a}
            contact={contact}
            conversationId={conversationId ?? undefined}
          />
        );
      case 'whatsapp':
        return conversationId ? (
          <Link
            key={a}
            href={`/inbox?c=${conversationId}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <MessageCircle className="size-4" />
            {tl('whatsappButton')}
          </Link>
        ) : (
          <Button
            key={a}
            size="sm"
            variant="outline"
            disabled
            title={tl('noConversation')}
          >
            <MessageCircle className="size-4" />
            {tl('whatsappButton')}
          </Button>
        );
      case 'message':
        return (
          <Button
            key={a}
            size="sm"
            onClick={outreach.openMessage}
            disabled={outreach.sendingMessage}
          >
            {outreach.sendingMessage ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MessageSquarePlus className="size-4" />
            )}
            {t('sendMessageBtn')}
          </Button>
        );
      case 'template':
        return (
          <Button
            key={a}
            size="sm"
            variant="outline"
            onClick={outreach.openTemplate}
            disabled={outreach.sendingTemplate}
          >
            {outreach.sendingTemplate ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LayoutTemplate className="size-4" />
            )}
            {t('sendTemplateBtn')}
          </Button>
        );
      case 'edit':
        return (
          <Button key={a} size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="size-4" />
            {t('actions.edit')}
          </Button>
        );
      default:
        return null;
    }
  };
  const item = (a: HeaderAction, phoneOnly: boolean) => {
    const cls = phoneOnly ? 'sm:hidden' : undefined;
    if (a === 'template')
      return (
        <DropdownMenuItem
          key={a}
          className={cls}
          onClick={outreach.openTemplate}
          disabled={outreach.sendingTemplate}
        >
          <LayoutTemplate className="size-4" />
          {t('sendTemplateBtn')}
        </DropdownMenuItem>
      );
    if (a === 'edit')
      return (
        <DropdownMenuItem key={a} className={cls} onClick={onEdit}>
          <Pencil className="size-4" />
          {t('actions.edit')}
        </DropdownMenuItem>
      );
    return (
      <DropdownMenuItem
        key={a}
        variant="destructive"
        onClick={() => setConfirm(true)}
      >
        <Trash2 className="size-4" />
        {t('actions.delete')}
      </DropdownMenuItem>
    );
  };
  const hasMenu = actions.secondary.length + actions.menu.length > 0;

  return (
    <header className="border-border bg-card rounded-xl border p-4">
      <div className="flex items-start gap-3 sm:gap-4">
        <div className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl text-base font-semibold">
          {initials(title)}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="truncate text-xl font-bold">{title}</h1>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {contact.company && contact.name && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Building2 className="size-3.5 shrink-0" />
                <span className="truncate">{contact.company}</span>
              </span>
            )}
            {contact.phone && (
              <button
                type="button"
                onClick={() => void copyPhone()}
                aria-label={t('copyPhone')}
                className="hover:text-primary inline-flex cursor-pointer items-center gap-1 transition-colors"
              >
                <Phone className="size-3.5" />
                {contact.phone}
                {copied ? (
                  <Check className="text-primary size-3" />
                ) : (
                  <Copy className="size-3" />
                )}
              </button>
            )}
            {contact.email && (
              <a
                href={`mailto:${contact.email}`}
                className="inline-flex min-w-0 items-center gap-1 hover:underline"
              >
                <Mail className="size-3.5 shrink-0" />
                <span className="truncate">{contact.email}</span>
              </a>
            )}
            {ownerName && <span>{tl('ownerRm', { name: ownerName })}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs">
            <span className="text-muted-foreground">{t('chatTag')}:</span>
            {chip ? (
              <ChatTagChip chip={chip} />
            ) : (
              <span className="text-muted-foreground italic">
                {t('noChatTag')}
              </span>
            )}
            {contact.opted_out_at && (
              <OptedOutBadge
                label={tp('optedOut')}
                hint={tp('optedOutHint', { date: day(contact.opted_out_at) })}
              />
            )}
            {contact.do_not_contact_at && (
              <span
                title={contact.do_not_contact_reason ?? undefined}
                className="border-destructive/40 bg-destructive/10 text-destructive inline-flex items-center rounded-full border px-1.5 text-[10px] leading-4 font-medium"
              >
                {tj('dnc')}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {actions.bar.map(button)}
        {actions.secondary.map((a) => (
          <span key={a} className="hidden sm:contents">
            {button(a)}
          </span>
        ))}
        {hasMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={tl('moreActions')}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'icon-sm' }),
                actions.menu.length === 0 && 'sm:hidden'
              )}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {actions.secondary.map((a) => item(a, true))}
              {actions.menu.map((a) => item(a, false))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {access.send && (
        <ContactChannelHint channels={channels} prediction={prediction} />
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => !deleting && setConfirm(o)}
        title={tp('deleteContactTitle')}
        description={tp('deleteContactDesc', { name: title })}
        cancelLabel={t('messageDialog.cancel')}
        confirmLabel={tp('deleteBtn')}
        onConfirm={() => void remove()}
        destructive
      />
    </header>
  );
}
