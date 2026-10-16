'use client';

// Writing to a contact from the contact screens: a plain message (the
// Whapi number) or an approved template (the Meta number), each
// find-or-creating the conversation through POST /api/whatsapp/send.
//
// Templates exist because Meta only allows a business-initiated
// conversation to start with a pre-approved one; the Whapi transport
// has no such rule and no template registry, so on a WhatsApp-Web
// channel an ordinary text is the *normal* way to say hello and
// templates are just saved canned replies. The send route accepts
// `contact_id` with any message type and find-or-creates the
// conversation, so neither needs an inbound message first.
//
// Which number each action goes out on: with both providers connected
// the two buttons split by nature, a free-form message on the Whapi
// number (no service window to fall outside of) and an approved
// template on the Meta number (the only thing that opens a
// business-initiated conversation there). The send route is told the
// provider explicitly; when that provider isn't connected it falls
// back to the account default, and `ContactChannelHint` says so
// instead of surprising the agent (`predictSendChannels`).
//
// `useContactOutreach` keeps the trigger and the dialogs apart, so a
// host can put the buttons in one place (the sheet's header) and mount
// the dialogs elsewhere (beside the sheet, not inside it).
// `ContactOutreach` renders both together.

import { useMemo, useState, type ReactNode } from 'react';
import { Loader2, LayoutTemplate, MessageSquarePlus, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { OutreachBanner } from '@/components/inbox/outreach-banner';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { useMyOutreach } from '@/hooks/use-my-outreach';
import type { AccountNumber } from '@/hooks/use-whatsapp-numbers';
import type { ContactThread } from '@/lib/contacts/contact-thread';
import type { SendChannelPrediction } from '@/lib/contacts/predict-send-channels';
import { limitNotices } from '@/lib/team-activity/thread-guard';
import type { MessageTemplate } from '@/types';

export function channelName(c: AccountNumber): string {
  const name = c.label || c.waba_id || c.phone_number_id;
  return `${name} (${c.provider === 'meta' ? 'Cloud API' : 'Whapi'})`;
}

export interface ContactOutreachProps {
  /** The contact written to; null: nothing to send to. */
  contact: { id: string; phone: string | null } | null;
  /** Its thread: whether a message would start a chat. */
  thread: ContactThread;
  prediction: SendChannelPrediction;
  /** After a message or template was accepted. */
  onSent?: () => void;
}

export interface ContactOutreachState {
  openMessage: () => void;
  openTemplate: () => void;
  sendingMessage: boolean;
  sendingTemplate: boolean;
  /** The message dialog and the template picker; mount once. */
  dialogs: ReactNode;
}

export function useContactOutreach({
  contact,
  thread,
  prediction,
  onSent,
}: ContactOutreachProps): ContactOutreachState {
  const t = useTranslations('Contacts.detailView');
  const { user, accountRole } = useAuth();
  const contactId = contact?.id ?? null;
  const { messageChannel } = prediction;

  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  const [messageDialogOpen, setMessageDialogOpen] = useState(false);
  const [messageText, setMessageText] = useState('');
  // When the message dialog opened: whether the message would start a
  // chat (nothing said for 24 hours) is judged against it.
  const [messageDialogOpenedAt, setMessageDialogOpenedAt] = useState(0);
  const [sendingMessage, setSendingMessage] = useState(false);

  // Team activity (migration 068): a message from here usually starts
  // a chat, so warn at the day's new-chat limit before it is typed.
  const myOutreach = useMyOutreach(
    messageDialogOpen && accountRole && accountRole !== 'viewer'
      ? user?.id
      : null,
    messageDialogOpenedAt
  );
  const messageNotices = useMemo(() => {
    // As in the inbox: nothing for 24 hours, and the customer did not
    // write last (answering them is a reply, however late).
    const lastAt = thread.last ? Date.parse(thread.last.at) : null;
    const starting =
      !thread.last?.byCustomer &&
      (lastAt === null ||
        !Number.isFinite(lastAt) ||
        lastAt <= messageDialogOpenedAt - 24 * 3600_000);
    return limitNotices({
      starting,
      day: myOutreach,
      channelId: messageChannel?.id ?? null,
      provider:
        messageChannel?.provider === 'whapi' ||
        messageChannel?.provider === 'meta'
          ? messageChannel.provider
          : null,
    });
  }, [thread.last, messageDialogOpenedAt, myOutreach, messageChannel]);

  async function handleSendMessage() {
    const text = messageText.trim();
    if (!contactId || !text || sendingMessage) return;

    setSendingMessage(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Same find-or-create path the template send uses — omitting
          // conversation_id lets the route open the thread if this is
          // the first contact we've ever had with this number.
          contact_id: contactId,
          message_type: 'text',
          content_text: text,
          // A plain message belongs on the Whapi number — see the
          // note at the top of this file.
          provider: 'whapi',
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(t('toastMessageFailed', { reason }));
        return;
      }

      toast.success(t('toastMessageSent'));
      setMessageText('');
      setMessageDialogOpen(false);
      onSent?.();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'network error';
      toast.error(t('toastMessageFailed', { reason }));
    } finally {
      setSendingMessage(false);
    }
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one for this
          // contact, mirroring the inbox template-send payload otherwise.
          contact_id: contactId,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
          // An approved template belongs on the Meta number — see the
          // note at the top of this file.
          provider: 'meta',
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(t('toastTemplateFailed', { reason }));
        return;
      }

      toast.success(t('toastTemplateSent', { name: template.name }));
      onSent?.();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'network error';
      toast.error(`Failed to send template: ${reason}`);
    } finally {
      setSendingTemplate(false);
    }
  }

  const dialogs = (
    <>
      <Dialog open={messageDialogOpen} onOpenChange={setMessageDialogOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('messageDialog.title')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('messageDialog.desc', { phone: contact?.phone ?? '' })}
              {messageChannel &&
                ` ${t('messageDialog.via', { channel: channelName(messageChannel) })}`}
            </DialogDescription>
          </DialogHeader>
          {messageNotices.length > 0 && (
            <div className="overflow-hidden rounded-lg">
              <OutreachBanner notices={messageNotices} />
            </div>
          )}
          <Textarea
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            placeholder={t('messageDialog.placeholder')}
            rows={5}
            autoFocus
            // Enter sends, Shift+Enter makes a newline — the same reflex
            // the inbox composer trains.
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSendMessage();
              }
            }}
            className="bg-background border-border resize-none"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setMessageDialogOpen(false)}
              disabled={sendingMessage}
            >
              {t('messageDialog.cancel')}
            </Button>
            <Button
              onClick={() => void handleSendMessage()}
              disabled={!messageText.trim() || sendingMessage}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {sendingMessage ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {t('messageDialog.send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TemplatePicker
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onSelect={handleSendTemplate}
      />
    </>
  );

  return {
    openMessage: () => {
      setMessageDialogOpenedAt(Date.now());
      setMessageDialogOpen(true);
    },
    openTemplate: () => setTemplatePickerOpen(true),
    sendingMessage,
    sendingTemplate,
    dialogs,
  };
}

/** "Send message" (primary) and "Send template" (secondary). */
export function ContactOutreachButtons({
  outreach,
}: {
  outreach: ContactOutreachState;
}) {
  const t = useTranslations('Contacts.detailView');
  return (
    <>
      <Button
        size="sm"
        onClick={outreach.openMessage}
        disabled={outreach.sendingMessage}
        className="bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {outreach.sendingMessage ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <MessageSquarePlus className="size-4" />
        )}
        {t('sendMessageBtn')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={outreach.openTemplate}
        disabled={outreach.sendingTemplate}
        className="border-border"
      >
        {outreach.sendingTemplate ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <LayoutTemplate className="size-4" />
        )}
        {t('sendTemplateBtn')}
      </Button>
    </>
  );
}

/** The caption naming the number each button will use; nothing until
 *  the account's numbers are loaded, or with none connected. */
export function ContactChannelHint({
  channels,
  prediction: { messageChannel, templateChannel },
}: {
  channels: readonly AccountNumber[] | null;
  prediction: SendChannelPrediction;
}) {
  const t = useTranslations('Contacts.detailView');
  if (!channels || channels.length === 0) return null;
  return (
    <p className="text-muted-foreground mt-2 text-xs">
      {messageChannel &&
        t('channelHint.message', { channel: channelName(messageChannel) })}
      {messageChannel && templateChannel && ' · '}
      {templateChannel &&
        t('channelHint.template', { channel: channelName(templateChannel) })}
    </p>
  );
}

/** The buttons and their dialogs together, for a host with no reason
 *  to mount them apart. */
export function ContactOutreach(props: ContactOutreachProps) {
  const outreach = useContactOutreach(props);
  return (
    <>
      <ContactOutreachButtons outreach={outreach} />
      {outreach.dialogs}
    </>
  );
}
