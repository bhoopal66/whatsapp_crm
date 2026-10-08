'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { Contact, Deal, ContactNote } from '@/types';
import {
  Phone,
  Mail,
  Copy,
  Check,
  DollarSign,
  StickyNote,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { format } from 'date-fns';
import { useTranslations } from 'next-intl';
import { ContactAvatar } from './contact-avatar';

interface ContactSidebarProps {
  contact: Contact | null;
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const tSidebar = useTranslations('Inbox.sidebar');
  const tThread = useTranslations('Inbox.messageThread');

  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals and notes in parallel
    const [dealsRes, notesRes] = await Promise.all([
      supabase
        .from('deals')
        .select('*, stage:pipeline_stages(*)')
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('contact_notes')
        .select('*')
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: false }),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
  }, [contact]);

  // Load on contact change. setDeals/setNotes run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from('contact_notes')
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote('');
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="border-wa-divider bg-wa-panel flex h-full w-70 items-center justify-center border-l">
        <p className="text-wa-text-secondary text-sm">
          {tThread('selectConversation')}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;

  // WhatsApp's "Contact info" drawer: white sections on a grey ground,
  // the gaps between them doing the work of dividers.
  return (
    <div className="border-wa-divider bg-wa-section-gap flex h-full w-70 flex-col border-l">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 pb-4">
          {/* Contact Info */}
          <section className="bg-wa-panel flex flex-col items-center px-5 pt-6 pb-4 text-center">
            <ContactAvatar contact={contact} name={displayName} size={88} />
            <h3 className="text-wa-text mt-3 max-w-full truncate text-lg">
              {displayName}
            </h3>
            {contact.opted_out_at && (
              <span
                title={tSidebar('optedOutHint')}
                className="bg-destructive/10 text-destructive mt-1.5 inline-flex max-w-full items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium"
              >
                <span className="truncate">
                  {tSidebar('optedOut', {
                    date: format(new Date(contact.opted_out_at), 'MMM d, yyyy'),
                  })}
                </span>
              </span>
            )}
            {contact.company && (
              <p className="text-wa-text-secondary max-w-full truncate text-sm">
                {contact.company}
              </p>
            )}

            <div className="mt-3 w-full space-y-0.5">
              <button
                onClick={handleCopyPhone}
                className="text-wa-text hover:bg-wa-row-hover flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
              >
                <Phone className="text-wa-icon h-4 w-4 shrink-0" />
                <span className="flex-1 truncate text-left">
                  {contact.phone}
                </span>
                {copied ? (
                  <Check className="text-wa-green h-3.5 w-3.5" />
                ) : (
                  <Copy className="text-wa-icon h-3.5 w-3.5" />
                )}
              </button>

              {contact.email && (
                <div className="text-wa-text flex items-center gap-3 rounded-lg px-3 py-2 text-sm">
                  <Mail className="text-wa-icon h-4 w-4 shrink-0" />
                  <span className="truncate">{contact.email}</span>
                </div>
              )}
            </div>
          </section>

          {/* Active Deals */}
          <section className="bg-wa-panel px-5 py-4">
            <SectionTitle icon={DollarSign}>{tSidebar('deals')}</SectionTitle>
            <div className="mt-2.5 space-y-2">
              {deals.length === 0 ? (
                <p className="text-wa-text-secondary text-xs">
                  {tSidebar('noDeals')}
                </p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="bg-wa-search rounded-lg px-3 py-2"
                  >
                    <p className="text-wa-text text-sm font-medium">
                      {deal.title}
                    </p>
                    <div className="text-wa-text-secondary mt-1 flex items-center justify-between text-xs">
                      <span>
                        {deal.currency ?? '$'}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Notes */}
          <section className="bg-wa-panel px-5 py-4">
            <SectionTitle icon={StickyNote}>{tSidebar('notes')}</SectionTitle>
            <div className="mt-2.5">
              <div className="flex items-end gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar('addNotePlaceholder')}
                  rows={2}
                  className="bg-wa-search text-wa-text placeholder:text-wa-text-secondary focus-visible:ring-wa-teal/40 flex-1 resize-none rounded-lg border-0 px-3 py-2 text-xs outline-none focus-visible:ring-2"
                />
                <Button
                  size="sm"
                  className="bg-wa-green text-wa-green-fg hover:bg-wa-green/90 h-8 w-8 shrink-0 rounded-full p-0"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="bg-wa-search rounded-lg px-3 py-2"
                  >
                    <p className="text-wa-text text-xs whitespace-pre-wrap">
                      {note.note_text}
                    </p>
                    <p className="text-wa-text-secondary mt-1 text-[10px]">
                      {format(new Date(note.created_at), 'MMM d, yyyy HH:mm')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

/** A drawer section's heading, in WhatsApp's quiet grey. */
function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: typeof Phone;
  children: React.ReactNode;
}) {
  return (
    <div className="text-wa-text-secondary flex items-center gap-2 text-sm">
      <Icon className="h-3.5 w-3.5" />
      {children}
    </div>
  );
}
