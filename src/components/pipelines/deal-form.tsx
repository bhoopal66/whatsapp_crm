'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { CURRENCIES } from '@/lib/currency';
import { useCan } from '@/hooks/use-can';
import { assignableOwners } from '@/lib/pipelines/owner';
import { useDealPeople } from './use-deal-people';
import { ContactPicker, type ContactOption } from './contact-picker';
import { DealRoomLinks } from '@/components/deal-rooms/room-links';
import { prefillFromDeal } from '@/lib/deal-rooms/entry';
import type { Conversation, Deal, DealStatus, PipelineStage } from '@/types';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Check,
  X,
  Trash2,
  MessageSquare,
  DollarSign,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  onSaved: () => void;
}

export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  onSaved,
}: DealFormProps) {
  const t = useTranslations('Pipelines.form');
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [contactId, setContactId] = useState('');
  // What the picker displays for `contactId` — the deal's embedded
  // contact when editing, the picked row otherwise.
  const [selectedContact, setSelectedContact] = useState<ContactOption | null>(
    null
  );
  const [stageId, setStageId] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [expectedCloseDate, setExpectedCloseDate] = useState('');
  const [notes, setNotes] = useState('');

  // Members are read once the sheet is open (cached, shared with the
  // inbox's assign dropdown). Only people this member may own deals
  // for are offered (migration 080): an admin anyone, a team leader
  // themselves and their teammates, anyone else only themselves.
  const people = useDealPeople(open);
  const myProfileId = useAuth().profile?.id ?? '';
  const owners = assignableOwners(people);
  const canWrite = useCan('send-messages');
  const [linkedConversation, setLinkedConversation] =
    useState<Conversation | null>(null);

  const [saving, setSaving] = useState(false);
  const [statusAction, setStatusAction] = useState<DealStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the form fields every time the sheet opens or its input
  // props change. This is a legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    if (deal) {
      setTitle(deal.title);
      setValue(String(deal.value ?? ''));
      setCurrency(deal.currency || defaultCurrency);
      // contact_id is nullable when the contact has been deleted
      // (migration 004: ON DELETE SET NULL). "" means "no selection".
      setContactId(deal.contact_id ?? '');
      setSelectedContact(
        deal.contact_id && deal.contact
          ? {
              id: deal.contact.id,
              name: deal.contact.name ?? null,
              phone: deal.contact.phone,
            }
          : null
      );
      setStageId(deal.stage_id);
      setAssignedTo(deal.assigned_to ?? '');
      setExpectedCloseDate(deal.expected_close_date ?? '');
      setNotes(deal.notes ?? '');
    } else {
      setTitle('');
      setValue('');
      setCurrency(defaultCurrency);
      setContactId('');
      setSelectedContact(null);
      setStageId(defaultStageId || stages[0]?.id || '');
      // A new deal is the creator's own unless they hand it on.
      setAssignedTo(myProfileId);
      setExpectedCloseDate('');
      setNotes('');
    }
  }, [open, deal, defaultStageId, stages, defaultCurrency, myProfileId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Fetch linked conversation for the selected contact (newest open one).
  // Clearing on no-selection is sync with prop state; the populated
  // case runs setLinkedConversation inside the async fetch callback.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinkedConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('conversations')
        .select('*')
        .eq('contact_id', contactId)
        .order('last_message_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setLinkedConversation((data as Conversation | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);

  async function handleSave() {
    if (!title.trim() || !contactId || !stageId) {
      toast.error(t('toastRequired'));
      return;
    }
    setSaving(true);

    const payload = {
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
    };

    if (deal) {
      const { error } = await supabase
        .from('deals')
        .update(payload)
        .eq('id', deal.id);
      if (error) {
        toast.error(t('toastFailedSave'));
        setSaving(false);
        return;
      }
    } else {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(t('toastNotSignedIn'));
        setSaving(false);
        return;
      }
      if (!accountId) {
        toast.error(t('toastNotLinked'));
        setSaving(false);
        return;
      }
      const { error } = await supabase.from('deals').insert({
        ...payload,
        user_id: user.id,
        account_id: accountId,
        status: 'open',
      });
      if (error) {
        toast.error(t('toastFailedCreate'));
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(deal ? t('toastUpdated') : t('toastCreated'));
    onOpenChange(false);
    onSaved();
  }

  async function handleStatusChange(status: DealStatus) {
    if (!deal) return;
    setStatusAction(status);
    const { error } = await supabase
      .from('deals')
      .update({ status })
      .eq('id', deal.id);
    setStatusAction(null);
    if (error) {
      toast.error(t('toastFailedStatus'));
      return;
    }
    toast.success(
      status === 'won'
        ? t('toastMarkedWon')
        : status === 'lost'
          ? t('toastMarkedLost')
          : t('toastReopened')
    );
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    const { error } = await supabase.from('deals').delete().eq('id', deal.id);
    setDeleting(false);
    if (error) {
      toast.error(t('toastFailedDelete'));
      return;
    }
    toast.success(t('toastDeleted'));
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground w-full p-0 sm:max-w-lg"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-border/50 border-b p-4">
            <SheetTitle className="text-popover-foreground">
              {deal ? t('editDeal') : t('newDeal')}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t('title')}</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('titlePlaceholder')}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t('contact')}</Label>
              <ContactPicker
                selected={selectedContact}
                onChange={(c) => {
                  setSelectedContact(c);
                  setContactId(c?.id ?? '');
                }}
                placeholder={t('selectContact')}
              />

              {linkedConversation && (
                <Link
                  href="/inbox"
                  className="bg-primary/10 text-primary hover:bg-primary/20 mt-1 inline-flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs"
                >
                  <MessageSquare className="h-3 w-3" />
                  {t('linkToConversation')}
                </Link>
              )}
            </div>

            <div className="grid grid-cols-[1fr_110px] gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t('value')}</Label>
                <div className="relative">
                  <DollarSign className="text-muted-foreground absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2" />
                  <Input
                    type="number"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="0"
                    className="border-border bg-muted text-foreground pl-7"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t('currency')}</Label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="border-border bg-muted text-foreground focus:border-primary h-9 w-full rounded-lg border px-2.5 text-sm outline-none"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">
                {t('expectedCloseDate')}
              </Label>
              <Input
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t('stage')}</Label>
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                className="border-border bg-muted text-foreground focus:border-primary h-9 w-full rounded-lg border px-2.5 text-sm outline-none"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t('assignedTo')}</Label>
              <select
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                disabled={
                  !canWrite ||
                  (owners.length <= 1 && owners[0]?.id === assignedTo)
                }
                className="border-border bg-muted text-foreground focus:border-primary h-9 w-full rounded-lg border px-2.5 text-sm outline-none disabled:opacity-70"
              >
                {/* Only a deal that already has no assignee (it belongs
                    to its creator) keeps the empty choice. */}
                {!assignedTo && <option value="">{t('unassigned')}</option>}
                {/* Deactivated members (migration 069) aren't offered,
                    except the one this deal already names — who is
                    also kept when it is not someone this member could
                    pick, so the select still shows the truth. */}
                {[
                  ...owners,
                  ...people.members.filter(
                    (p) =>
                      p.id === assignedTo && !owners.some((o) => o.id === p.id)
                  ),
                ]
                  .filter((p) => !p.deactivated_at || p.id === assignedTo)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name || p.email}
                    </option>
                  ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t('notes')}</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('notesPlaceholder')}
                className="border-border bg-muted text-foreground min-h-[100px]"
              />
            </div>

            {deal && (
              <DealRoomLinks
                contact={prefillFromDeal(deal)?.contact ?? null}
                deal={{ id: deal.id, title: deal.title }}
                frame={(roomsTitle, body) => (
                  <div className="grid gap-2">
                    <Label className="text-muted-foreground">
                      {roomsTitle}
                    </Label>
                    {body}
                  </div>
                )}
              />
            )}

            {deal && (
              <div className="border-border bg-muted/50 space-y-2 rounded-lg border p-3">
                <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                  {t('status')}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => handleStatusChange('won')}
                    disabled={
                      !canWrite || !!statusAction || deal.status === 'won'
                    }
                    className="bg-primary text-primary-foreground hover:bg-primary/90 flex-1 disabled:opacity-50"
                  >
                    {statusAction === 'won' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Check className="mr-1 h-4 w-4" />
                        {t('markAsWon')}
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => handleStatusChange('lost')}
                    disabled={
                      !canWrite || !!statusAction || deal.status === 'lost'
                    }
                    className="flex-1 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {statusAction === 'lost' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <X className="mr-1 h-4 w-4" />
                        {t('markAsLost')}
                      </>
                    )}
                  </Button>
                </div>
                {deal.status && deal.status !== 'open' && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleStatusChange('open')}
                    disabled={!canWrite || !!statusAction}
                    className="text-muted-foreground hover:text-foreground w-full"
                  >
                    {t('reopenDeal')}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="border-border/50 bg-popover/80 border-t p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-border text-muted-foreground hover:bg-muted flex-1 bg-transparent"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={handleSave}
                disabled={
                  !canWrite || saving || !title.trim() || !contactId || !stageId
                }
                className="bg-primary text-primary-foreground hover:bg-primary/90 flex-1"
              >
                {saving
                  ? t('saving')
                  : deal
                    ? t('saveChanges')
                    : t('createDeal')}
              </Button>
            </div>

            {deal &&
              canWrite &&
              (confirmDelete ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-xs">
                  <span className="text-destructive">{t('deletePrompt')}</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="text-muted-foreground hover:bg-muted rounded px-2 py-1"
                    >
                      {t('cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? t('deleting') : t('confirm')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-destructive hover:text-destructive/80"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('deleteDeal')}
                </button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
