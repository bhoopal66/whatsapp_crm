'use client';

// The customer page's own cards: Details (with custom fields, editable
// in place for those who may edit), Deals, and the note composer. Every
// read and write is the viewer's RLS client, as in the side sheet.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import {
  dealRows,
  type DealRow,
  type DealRowInput,
} from '@/lib/contacts/customer-layout';
import { createClient } from '@/lib/supabase/client';

export function SideCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-card rounded-xl border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

interface Field {
  id: string;
  field_name: string;
}

export function DetailsCard({
  contact,
  canEdit,
}: {
  contact: {
    id: string;
    email: string | null;
    company: string | null;
    created_at: string | null;
  };
  canEdit: boolean;
}) {
  const t = useTranslations('Contacts.detailView');
  const locale = useLocale();
  const [fields, setFields] = useState<Field[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    const sb = createClient();
    void Promise.all([
      sb.from('custom_fields').select('id, field_name').order('field_name'),
      sb
        .from('contact_custom_values')
        .select('custom_field_id, value')
        .eq('contact_id', contact.id),
    ]).then(([f, v]) => {
      if (!live) return;
      setFields((f.data ?? []) as Field[]);
      setValues(
        Object.fromEntries(
          (
            (v.data ?? []) as {
              custom_field_id: string;
              value: string | null;
            }[]
          ).map((r) => [r.custom_field_id, r.value ?? ''])
        )
      );
    });
    return () => {
      live = false;
    };
  }, [contact.id]);

  // Delete-then-insert, as the side sheet saves them.
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const sb = createClient();
    const rows = Object.entries(draft)
      .filter(([, v]) => v.trim())
      .map(([id, v]) => ({
        contact_id: contact.id,
        custom_field_id: id,
        value: v.trim(),
      }));
    const del = await sb
      .from('contact_custom_values')
      .delete()
      .eq('contact_id', contact.id);
    const ins =
      !del.error && rows.length
        ? await sb.from('contact_custom_values').insert(rows)
        : { error: del.error };
    setSaving(false);
    if (ins.error) return void toast.error(t('toastCustomFieldsFailed'));
    setValues(
      Object.fromEntries(rows.map((r) => [r.custom_field_id, r.value]))
    );
    setDraft(null);
    toast.success(t('toastCustomFieldsSaved'));
  };

  const row = (label: string, value: React.ReactNode) => (
    <div
      key={label}
      className="flex items-baseline justify-between gap-3 text-sm"
    >
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value || '—'}</dd>
    </div>
  );
  return (
    <SideCard
      title={t('tabs.details')}
      action={
        canEdit && fields.length > 0 && !draft ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setDraft({ ...values })}
          >
            <Pencil className="size-3" />
            {t('actions.edit')}
          </Button>
        ) : null
      }
    >
      <dl className="space-y-2">
        {row(t('email'), contact.email)}
        {row(t('company'), contact.company)}
        {row(
          t('createdAt'),
          contact.created_at &&
            new Date(contact.created_at).toLocaleDateString(locale, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
        )}
        {!draft && fields.map((f) => row(f.field_name, values[f.id]))}
      </dl>
      {draft && (
        <div className="mt-3 space-y-2 border-t pt-3">
          {fields.map((f) => (
            <label key={f.id} className="block space-y-1 text-xs">
              <span className="text-muted-foreground">{f.field_name}</span>
              <Input
                value={draft[f.id] ?? ''}
                placeholder={t('enterCustomField', { name: f.field_name })}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [f.id]: e.target.value }))
                }
                className="h-8 text-sm"
              />
            </label>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              {t('messageDialog.cancel')}
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {t('saveCustomFieldsBtn')}
            </Button>
          </div>
        </div>
      )}
    </SideCard>
  );
}

export function DealsCard({ contactId }: { contactId: string }) {
  const t = useTranslations('Contacts.detailView');
  const tl = useTranslations('CustomerTimeline');
  const { defaultCurrency } = useAuth();
  const [deals, setDeals] = useState<DealRowInput[] | null>(null);
  useEffect(() => {
    let live = true;
    void createClient()
      .from('deals')
      .select(
        'id, title, value, currency, status, stage:pipeline_stages(name, color)'
      )
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .then(
        ({ data }) =>
          live && setDeals((data ?? []) as unknown as DealRowInput[])
      );
    return () => {
      live = false;
    };
  }, [contactId]);
  const rows: DealRow[] = deals ? dealRows(deals, defaultCurrency) : [];
  return (
    <SideCard
      title={t('tabs.deals')}
      action={
        <Link
          href="/pipelines"
          className={buttonVariants({ variant: 'ghost', size: 'xs' })}
        >
          {tl('openPipelines')}
        </Link>
      }
    >
      {!deals ? (
        <div className="bg-muted h-10 animate-pulse rounded" aria-hidden />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('dealsTab.noDeals')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((d) => (
            <li
              key={d.id}
              className="border-border bg-muted/40 rounded-lg border p-2.5 text-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 font-medium break-words">
                  {d.title}
                </span>
                {d.stage && (
                  <span
                    className="bg-muted shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={
                      d.color
                        ? { backgroundColor: `${d.color}20`, color: d.color }
                        : undefined
                    }
                  >
                    {d.stage}
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-1 flex justify-between text-xs">
                <span>{d.value}</span>
                {d.outcome && (
                  <span
                    className={
                      d.outcome === 'won' ? 'text-primary' : 'text-destructive'
                    }
                  >
                    {tl(d.outcome === 'won' ? 'dealWon' : 'dealLost')}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SideCard>
  );
}

export interface SavedNote {
  id: string;
  note_text: string;
  user_id: string | null;
  created_at: string;
}

export function NoteComposer({
  contactId,
  onAdded,
}: {
  contactId: string;
  onAdded: (n: SavedNote) => void;
}) {
  const t = useTranslations('Contacts.detailView');
  const { accountId, user } = useAuth();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const add = async () => {
    if (!text.trim()) return;
    if (!user || !accountId)
      return void toast.error(t('toastNotAuthenticated'));
    setSaving(true);
    const { data, error } = await createClient()
      .from('contact_notes')
      .insert({
        contact_id: contactId,
        account_id: accountId,
        user_id: user.id,
        note_text: text.trim(),
      })
      .select('id, note_text, user_id, created_at')
      .single();
    setSaving(false);
    if (error || !data) return void toast.error(t('toastNoteAddFailed'));
    setText('');
    onAdded(data as SavedNote);
    toast.success(t('toastNoteAdded'));
  };
  return (
    <div className="border-border bg-card space-y-2 rounded-xl border p-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('notesTab.placeholder')}
        className="min-h-[60px] resize-none text-sm"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!text.trim() || saving}
          onClick={() => void add()}
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          {t('notesTab.save')}
        </Button>
      </div>
    </div>
  );
}
