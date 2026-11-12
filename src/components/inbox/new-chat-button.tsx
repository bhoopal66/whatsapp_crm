'use client';

// "New chat" in the inbox list's header: a typed number becomes an
// open chat, or a first message through the contact screens' outreach
// (personal number, Team-activity limits and Meta templates included).
// The rules live in lib/inbox/new-chat.ts; this only gathers facts on
// the caller's RLS client and renders. Mounted only for people who may
// send (the list gates it with `useCan('send-messages')`).

import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  ContactChannelHint,
  ContactOutreachButtons,
  useContactOutreach,
  type ContactOutreachState,
} from '@/components/contacts/contact-outreach';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import {
  useAccountNumbers,
  useMyNumberIds,
} from '@/hooks/use-whatsapp-numbers';
import { NO_THREAD } from '@/lib/contacts/contact-thread';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  showPersonalOption,
  type PersonalNumberInfo,
} from '@/lib/contacts/personal-outreach';
import { validatePhoneToSave } from '@/lib/contacts/phone-validation';
import { predictSendChannels } from '@/lib/contacts/predict-send-channels';
import {
  decideNewChat,
  pickConversationToOpen,
  type NewChatConversation,
  type NewChatContact,
  type NewChatFacts,
} from '@/lib/inbox/new-chat';
import { createClient } from '@/lib/supabase/client';

async function visibleConversations(
  contactId: string
): Promise<NewChatConversation[]> {
  const { data, error } = await createClient()
    .from('conversations')
    .select('id, personal_owner_id')
    .eq('contact_id', contactId);
  if (error) throw error;
  return (data ?? []) as NewChatConversation[];
}

async function hasPersonalNumber(): Promise<boolean> {
  try {
    const res = await fetch('/api/whatsapp/personal');
    if (!res.ok) return false;
    return showPersonalOption((await res.json()) as PersonalNumberInfo);
  } catch {
    return false;
  }
}

export function NewChatButton({
  onOpenConversation,
}: {
  /** Opens a chat in the inbox by id. */
  onOpenConversation: (conversationId: string) => void;
}) {
  const t = useTranslations('Inbox.newChat');
  const tForm = useTranslations('Contacts.form');
  const { user, accountId } = useAuth();

  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // Set once the number has no chat the caller can see: the dialog
  // turns into the outreach buttons for it.
  const [composeFor, setComposeFor] = useState<NewChatContact | null>(null);
  const [personal, setPersonal] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open || personal !== null) return;
    let live = true;
    void hasPersonalNumber().then((v) => {
      if (live) setPersonal(v);
    });
    return () => {
      live = false;
    };
  }, [open, personal]);

  const channels = useAccountNumbers(open || !!composeFor);
  const myNumberIds = useMyNumberIds();
  const prediction = useMemo(
    () => predictSendChannels(channels ?? [], NO_THREAD, myNumberIds),
    [channels, myNumberIds]
  );

  // The sent message's chat: the send route does not return its id, so
  // read it back; a miss is left to the list's realtime update.
  async function openAfterSend(contactId: string) {
    if (!user) return;
    try {
      const rows = await visibleConversations(contactId);
      const id = pickConversationToOpen(rows, user.id, personal === true);
      if (id) onOpenConversation(id);
    } catch {
      // The realtime list update shows the new chat anyway.
    }
  }

  const outreach = useContactOutreach({
    contact: composeFor,
    thread: NO_THREAD,
    prediction,
    onSent: () => {
      const contactId = composeFor?.id;
      setComposeFor(null);
      setOpen(false);
      if (contactId) void openAfterSend(contactId);
    },
  });
  // Each button closes this dialog before the outreach dialog opens,
  // so two modal dialogs are never stacked.
  const handOff = (go: () => void) => () => {
    setOpen(false);
    go();
  };
  const outreachHere: ContactOutreachState = {
    ...outreach,
    openMessage: handOff(outreach.openMessage),
    openPersonalMessage: handOff(outreach.openPersonalMessage),
    openTemplate: handOff(outreach.openTemplate),
  };

  function start() {
    setPhone('');
    setName('');
    setComposeFor(null);
    setPersonal(null);
    setOpen(true);
  }

  async function handleContinue() {
    if (busy || !user || !accountId) return;
    const db = createClient();
    setBusy(true);
    try {
      const facts: NewChatFacts = {
        phone: validatePhoneToSave(null, phone),
        userId: user.id,
        hasPersonalNumber: personal ?? (await hasPersonalNumber()),
      };
      for (;;) {
        const step = decideNewChat(facts);
        switch (step.kind) {
          case 'invalid-phone':
            toast.error(step.message);
            return;
          case 'hidden-conflict':
            toast.error(tForm('toastConflictHidden'));
            return;
          case 'failed':
            toast.error(t('failed', { reason: step.message }));
            return;
          case 'find-contact':
            facts.visibleContact = await findExistingContact(
              db,
              accountId,
              step.phone
            );
            continue;
          case 'insert-contact': {
            const { data, error } = await db
              .from('contacts')
              .insert({
                user_id: user.id,
                account_id: accountId,
                name: name.trim() || null,
                phone: step.phone,
              })
              .select('id')
              .maybeSingle();
            if (isUniqueViolation(error)) {
              const again = await findExistingContact(
                db,
                accountId,
                step.phone
              );
              facts.insert = { kind: 'unique-violation', visible: again };
            } else if (error || !data) {
              facts.insert = {
                kind: 'error',
                message: error?.message ?? 'no row returned',
              };
            } else {
              facts.insert = {
                kind: 'created',
                id: (data as { id: string }).id,
              };
            }
            continue;
          }
          case 'find-conversations':
            facts.conversations = await visibleConversations(step.contact.id);
            continue;
          case 'open-conversation':
            setOpen(false);
            onOpenConversation(step.conversationId);
            return;
          case 'compose':
            setComposeFor(step.contact);
            return;
          default: {
            const never: never = step;
            throw new Error(`Unknown step ${String(never)}`);
          }
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      toast.error(t('failed', { reason }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={start}
        aria-label={t('button')}
        title={t('button')}
        className="text-wa-icon hover:text-wa-text h-9 w-9 shrink-0"
      >
        <MessageSquarePlus className="size-5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {composeFor
                ? t('composeDesc', { phone: composeFor.phone ?? phone })
                : t('desc')}
            </DialogDescription>
          </DialogHeader>
          {composeFor ? (
            <div>
              <div className="flex flex-wrap gap-2">
                <ContactOutreachButtons outreach={outreachHere} />
              </div>
              <ContactChannelHint channels={channels} prediction={prediction} />
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void handleContinue();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="new-chat-phone">{t('phone')}</Label>
                <Input
                  id="new-chat-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={t('phonePlaceholder')}
                  autoFocus
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-chat-name">{t('name')}</Label>
                <Input
                  id="new-chat-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={busy}
                >
                  {t('cancel')}
                </Button>
                <Button type="submit" disabled={!phone.trim() || busy}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {t('next')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      {outreach.dialogs}
    </>
  );
}
