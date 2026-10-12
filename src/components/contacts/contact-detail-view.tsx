'use client';

import { CallButton } from '@/components/pbx/call-button';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { validatePhoneToSave } from '@/lib/contacts/phone-validation';
import { useAuth } from '@/hooks/use-auth';
import { useMyOutreach } from '@/hooks/use-my-outreach';
import { limitNotices } from '@/lib/team-activity/thread-guard';
import { OutreachBanner } from '@/components/inbox/outreach-banner';
import {
  predictNumber,
  useAccountNumbers,
  useMyNumberIds,
  type AccountNumber,
} from '@/hooks/use-whatsapp-numbers';
import { formatCurrency } from '@/lib/currency';
import { toast } from 'sonner';
import type { Contact, ContactNote, CustomField, ContactCustomValue, Deal, MessageTemplate } from '@/types';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  X,
  DollarSign,
  LayoutTemplate,
  MessageSquarePlus,
  Send,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useChatTags } from '@/hooks/use-chat-tags';
import { chatTagChipStyle, chatTagColor } from '@/lib/chat-tags/style';
import {
  chatTagsByContact,
  contactChatTagChip,
  type ChatTagIds,
} from '@/lib/contacts/chat-tag-column';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

/** Mirrors `describeChannel` server-side, minus the encryption import. */
interface ContactThread {
  pin: string | null;
  home: string | null;
  /** The last message that reached WhatsApp; null: none. */
  last: { at: string; byCustomer: boolean } | null;
  /** The chat tag (migration 075), picked as the contacts list picks
   *  it; null: no thread. */
  chatTags: ChatTagIds | null;
}

const NO_THREAD: ContactThread = {
  pin: null,
  home: null,
  last: null,
  chatTags: null,
};

function channelName(c: AccountNumber): string {
  const name = c.label || c.waba_id || c.phone_number_id;
  return `${name} (${c.provider === 'meta' ? 'Cloud API' : 'Whapi'})`;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const t = useTranslations('Contacts.detailView');
  const locale = useLocale();
  const { tree: chatTagTree } = useChatTags();
  const supabase = createClient();
  const { accountId, defaultCurrency, user, accountRole } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  // Send a plain message — the other way to open a thread with this
  // contact. Templates exist because Meta only allowed a
  // business-initiated conversation to start with a pre-approved one;
  // the Whapi transport has no such rule and no template registry, so
  // on a WhatsApp-Web channel an ordinary text is the *normal* way to
  // say hello and templates are just saved canned replies. The send
  // route already accepts `contact_id` with any message type and
  // find-or-creates the conversation, so this needs no new endpoint.
  const [messageDialogOpen, setMessageDialogOpen] = useState(false);
  const [messageText, setMessageText] = useState('');
  // When the message dialog opened: whether the message would start a
  // chat (nothing said for 24 hours) is judged against it.
  const [messageDialogOpenedAt, setMessageDialogOpenedAt] = useState(0);
  const [sendingMessage, setSendingMessage] = useState(false);

  // Which number each action goes out on. With both providers
  // connected the two buttons split by nature: a free-form message on
  // the Whapi number (no service window to fall outside of) and an
  // approved template on the Meta number (the only thing that opens a
  // business-initiated conversation there). The send route is told
  // the provider explicitly; when that provider isn't connected it
  // falls back to the account default, and this list is what lets the
  // caption below the buttons say so instead of surprising the agent.
  //
  // With several Whapi numbers (migration 060) the server picks the
  // thread's own number, then one the sender is allocated to — so the
  // caption asks the same two questions.
  const channels = useAccountNumbers(open);
  const myNumberIds = useMyNumberIds();
  // The thread's pin (migration 061) and its own number, in the order
  // the server prefers them for a provider-pinned send. Stored with the
  // contact it was read for and only believed for that contact: opening
  // another contact would otherwise show the previous one's chat tag
  // (and predict its number) until the new read lands.
  const [loadedThread, setLoadedThread] = useState<{
    contactId: string;
    thread: ContactThread;
  } | null>(null);
  const thread =
    loadedThread && loadedThread.contactId === contactId
      ? loadedThread.thread
      : NO_THREAD;

  useEffect(() => {
    if (!contactId || !open) return;
    let cancelled = false;
    (async () => {
      // Oldest first. The send-number fields come from the oldest
      // thread, as before; the chat tag from the first thread that
      // carries one, which is what the contacts list shows and filters on.
      const { data: rows } = await supabase
        .from('conversations')
        .select('id, contact_id, channel_id, send_channel_id, chat_tag_id, chat_sub_tag_id')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true });
      const data = rows?.[0] ?? null;
      // Whether a message from here would start a chat (Team activity,
      // migration 068) turns on the last message that went out or came
      // in, and on who sent it.
      const { data: lastRow } = data?.id
        ? await supabase
            .from('messages')
            .select('sender_type, created_at')
            .eq('conversation_id', data.id as string)
            .neq('status', 'failed')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        : { data: null };
      if (!cancelled) {
        setLoadedThread({
          contactId,
          thread: {
            pin: (data?.send_channel_id as string | null) ?? null,
            home: (data?.channel_id as string | null) ?? null,
            last: lastRow?.created_at
              ? {
                  at: lastRow.created_at as string,
                  byCustomer: lastRow.sender_type === 'customer',
                }
              : null,
            chatTags: data
              ? (chatTagsByContact(
                  rows as (ChatTagIds & { contact_id: string })[]
                ).get(contactId) ?? null)
              : null,
          },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, open, supabase]);

  const { messageChannel, templateChannel } = useMemo(() => {
    const list = channels ?? [];
    const fallback = list.find((c) => c.is_primary) ?? list[0] ?? null;
    // Mirrors resolveSendChannel: a person's pin on the chat wins when
    // it is the kind of number the button asks for, or when that kind
    // is not connected at all; otherwise the kind wins, preferring the
    // thread's own number, then one this user is allocated to.
    const pinned = thread.pin ? list.find((c) => c.id === thread.pin) : undefined;
    const pick = (provider: 'whapi' | 'meta') =>
      (pinned &&
      (pinned.provider === provider || !list.some((c) => c.provider === provider))
        ? pinned
        : predictNumber(list, provider, [thread.home, ...(myNumberIds ?? [])])) ??
      fallback;
    return {
      messageChannel: pick('whapi'),
      templateChannel: pick('meta'),
    };
  }, [channels, myNumberIds, thread]);

  // Team activity (migration 068): a message from here usually starts
  // a chat, so warn at the day's new-chat limit before it is typed.
  const myOutreach = useMyOutreach(
    messageDialogOpen && accountRole && accountRole !== 'viewer' ? user?.id : null,
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
        messageChannel?.provider === 'whapi' || messageChannel?.provider === 'meta'
          ? messageChannel.provider
          : null,
    });
  }, [thread.last, messageDialogOpenedAt, myOutreach, messageChannel]);

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);

    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (data) {
      setContact(data);
      setEditName(data.name ?? '');
      setEditPhone(data.phone);
      setEditEmail(data.email ?? '');
      setEditCompany(data.company ?? '');
    }
    setLoading(false);
  }, [contactId, supabase]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, supabase]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase.from('custom_fields').select('*').order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [contactId, supabase]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, supabase]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
    }
  }, [open, contactId, fetchContact, fetchNotes, fetchCustomFields, fetchDeals]);

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error(t('toastPhoneRequired'));
      return;
    }
    // Same rule as the contact form: a changed number must carry its
    // country code; unchanged digits are left alone (see
    // validatePhoneToSave).
    const checkedPhone = validatePhoneToSave(contact?.phone, editPhone);
    if (!checkedPhone.ok) {
      toast.error(checkedPhone.error);
      return;
    }

    setSavingDetails(true);
    const { error } = await supabase
      .from('contacts')
      .update({
        name: editName.trim() || null,
        phone: checkedPhone.phone,
        email: editEmail.trim() || null,
        company: editCompany.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId);

    if (error) {
      toast.error(t('toastUpdateFailed'));
    } else {
      toast.success(t('toastUpdated'));
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user || !accountId) {
      toast.error(t('toastNotAuthenticated'));
      setSavingNote(false);
      return;
    }

    const { error } = await supabase.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: user.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error(t('toastNoteAddFailed'));
    } else {
      setNewNote('');
      fetchNotes();
      toast.success(t('toastNoteAdded'));
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error(t('toastNoteDeleteFailed'));
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success(t('toastNoteDeleted'));
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', contactId);

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('contact_custom_values')
          .insert(rows);
        if (error) throw error;
      }

      toast.success(t('toastCustomFieldsSaved'));
    } catch {
      toast.error(t('toastCustomFieldsFailed'));
    }
    setSavingCustom(false);
  }

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
          // note on `channels` above.
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'network error';
      toast.error(t('toastMessageFailed', { reason }));
    } finally {
      setSendingMessage(false);
    }
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues,
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
          // note on `channels` above.
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'network error';
      toast.error(`Failed to send template: ${reason}`);
    } finally {
      setSendingTemplate(false);
    }
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        {loading || !contact ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Header */}
            <SheetHeader className="p-4 border-b border-border/50">
              <div className="flex items-center gap-3">
                <Avatar className="size-12 bg-muted border border-border">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-popover-foreground truncate">
                    {contact.name || t('unnamed')}
                  </SheetTitle>
                  <SheetDescription className="text-muted-foreground text-xs mt-0.5">
                    {t('contactDetailsDesc')}
                  </SheetDescription>
                  <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                    <button
                      onClick={copyPhone}
                      className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer"
                    >
                      <Phone className="size-3" />
                      {contact.phone}
                      {copiedPhone ? (
                        <Check className="size-3 text-primary" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                    <CallButton contact={contact} />
                    {contact.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="size-3" />
                        {contact.email}
                      </span>
                    )}
                    {contact.company && (
                      <span className="flex items-center gap-1">
                        <Building2 className="size-3" />
                        {contact.company}
                      </span>
                    )}
                  </div>
                  <ChatTagLine
                    label={t('chatTag')}
                    empty={t('noChatTag')}
                    chip={contactChatTagChip(thread.chatTags, chatTagTree)}
                  >
                    {contact.opted_out_at && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="border-destructive/40 bg-destructive/10 text-destructive inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium" />
                          }
                        >
                          {t('optedOut', {
                            date: new Date(contact.opted_out_at).toLocaleDateString(
                              locale,
                              { month: 'short', day: 'numeric', year: 'numeric' }
                            ),
                          })}
                        </TooltipTrigger>
                        <TooltipContent>{t('optedOutHint')}</TooltipContent>
                      </Tooltip>
                    )}
                  </ChatTagLine>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {/* Primary action: just write to them. Templates are the
                    secondary path now — see the note on
                    `messageDialogOpen` above. */}
                <Button
                  size="sm"
                  onClick={() => {
                    setMessageDialogOpenedAt(Date.now());
                    setMessageDialogOpen(true);
                  }}
                  disabled={sendingMessage}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {sendingMessage ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <MessageSquarePlus className="size-4" />
                  )}
                  {t('sendMessageBtn')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTemplatePickerOpen(true)}
                  disabled={sendingTemplate}
                  className="border-border"
                >
                  {sendingTemplate ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LayoutTemplate className="size-4" />
                  )}
                  {t('sendTemplateBtn')}
                </Button>
              </div>
              {channels && channels.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {messageChannel &&
                    t('channelHint.message', {
                      channel: channelName(messageChannel),
                    })}
                  {messageChannel && templateChannel && ' · '}
                  {templateChannel &&
                    t('channelHint.template', {
                      channel: channelName(templateChannel),
                    })}
                </p>
              )}
            </SheetHeader>

            {/* Tabs */}
            <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
              <TabsList className="bg-muted/50 border-b border-border mx-4 mt-3">
                <TabsTrigger
                  value="details"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.details')}
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.notes')}
                </TabsTrigger>
                <TabsTrigger
                  value="custom"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.custom')}
                </TabsTrigger>
                <TabsTrigger
                  value="deals"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.deals')}
                </TabsTrigger>
              </TabsList>

              {/* Details Tab */}
              <TabsContent value="details" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('name')}</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      {t('phone')} <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('email')}</Label>
                    <Input
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('company')}</Label>
                    <Input
                      value={editCompany}
                      onChange={(e) => setEditCompany(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <Button
                    onClick={saveDetails}
                    disabled={savingDetails}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                    size="sm"
                  >
                    {savingDetails ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    {t('saveChangesBtn')}
                  </Button>
                </div>
              </TabsContent>

              {/* Notes Tab */}
              <TabsContent value="notes" className="flex-1 flex flex-col min-h-0 px-4 py-3">
                <div className="space-y-2 mb-3">
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder={t('notesTab.placeholder')}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground min-h-[60px] text-sm resize-none"
                  />
                  <Button
                    onClick={addNote}
                    disabled={!newNote.trim() || savingNote}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    size="sm"
                  >
                    {savingNote ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    {t('notesTab.save')}
                  </Button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                  {loadingNotes ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : notes.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      {t('notesTab.noNotes')}
                    </p>
                  ) : (
                    notes.map((note) => (
                      <div
                        key={note.id}
                        className="rounded-lg bg-muted/50 border border-border/50 p-3 group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap flex-1">
                            {note.note_text}
                          </p>
                          <button
                            onClick={() => deleteNote(note.id)}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all cursor-pointer shrink-0"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1.5">
                          {new Date(note.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              {/* Custom Fields Tab */}
              <TabsContent value="custom" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingCustom ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : customFields.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {t('noCustomFields')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {customFields.map((field) => (
                      <div key={field.id} className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs capitalize">
                          {field.field_name}
                        </Label>
                        <Input
                          value={customValues[field.id] ?? ''}
                          onChange={(e) =>
                            setCustomValues((prev) => ({
                              ...prev,
                              [field.id]: e.target.value,
                            }))
                          }
                          placeholder={t('enterCustomField', { name: field.field_name })}
                          className="bg-muted border-border text-foreground h-8 text-sm placeholder:text-muted-foreground"
                        />
                      </div>
                    ))}
                    <Button
                      onClick={saveCustomFields}
                      disabled={savingCustom}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                      size="sm"
                    >
                      {savingCustom ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      {t('saveCustomFieldsBtn')}
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* Deals Tab */}
              <TabsContent value="deals" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingDeals ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-primary" />
                  </div>
                ) : deals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('dealsTab.noDeals')}</p>
                ) : (
                  <div className="space-y-2">
                    {deals.map((deal) => (
                      <div
                        key={deal.id}
                        className="rounded-lg border border-border bg-muted/50 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {deal.title}
                          </p>
                          {deal.stage && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${deal.stage.color}20`,
                                color: deal.stage.color,
                              }}
                            >
                              {deal.stage.name}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <DollarSign className="size-3" />
                            {formatCurrency(
                              deal.value ?? 0,
                              deal.currency || defaultCurrency,
                            )}
                          </span>
                          {deal.status && deal.status !== 'open' && (
                            <span
                              className={
                                deal.status === 'won'
                                  ? 'text-primary'
                                  : 'text-red-400'
                              }
                            >
                              {deal.status}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
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
}

/** "Chat tag: <chip>", read-only — tags are set on the chat itself. */
function ChatTagLine({
  label,
  empty,
  chip,
  children,
}: {
  label: string;
  empty: string;
  chip: { label: string; color: string } | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      {chip ? (
        <span
          title={chip.label}
          style={chatTagChipStyle(chip.color)}
          className="text-foreground inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium"
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: chatTagColor(chip.color) }}
          />
          <span className="truncate">{chip.label}</span>
        </span>
      ) : (
        <span className="text-muted-foreground italic">{empty}</span>
      )}
      {children}
    </div>
  );
}
