'use client';

/**
 * The tag fields of a desk upload, shared by Upload and the uploader's
 * retag. Which fields show follows the kind: a new case asks for bank,
 * company, licence, product and the customer contact; a pending document
 * or information asks for the case number or caption code.
 */
import { useTranslations } from 'next-intl';

import {
  ContactPicker,
  type ContactOption,
} from '@/components/pipelines/contact-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { DeskBank, ItemKind } from '@/lib/desk/store';

export interface TagDraft {
  kind: ItemKind | '';
  bankCode: string;
  caseRef: string;
  companyName: string;
  tradeLicence: string;
  product: string;
  contact: ContactOption | null;
  docKey: string;
  note: string;
}

export const EMPTY_DRAFT: TagDraft = {
  kind: '',
  bankCode: '',
  caseRef: '',
  companyName: '',
  tradeLicence: '',
  product: '',
  contact: null,
  docKey: '',
  note: '',
};

export const NATIVE_FIELD =
  'border-input bg-card dark:bg-input/30 h-9 w-full rounded-md border px-3 text-sm';

const KINDS: ItemKind[] = ['pending_doc', 'new_case', 'info'];

export function TagFields({
  draft,
  onChange,
  banks,
}: {
  draft: TagDraft;
  onChange: (next: TagDraft) => void;
  banks: readonly DeskBank[];
}) {
  const t = useTranslations('Desk');
  const set = <K extends keyof TagDraft>(k: K, v: TagDraft[K]) =>
    onChange({ ...draft, [k]: v });
  const id = (s: string) => `desk-${s}`;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label>{t('fields.kind')}</Label>
        <div className="flex flex-wrap gap-2" role="radiogroup">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={draft.kind === k}
              onClick={() => set('kind', draft.kind === k ? '' : k)}
              className={
                draft.kind === k
                  ? 'bg-primary text-primary-foreground rounded-full px-3 py-1 text-sm'
                  : 'border-input bg-card hover:bg-muted rounded-full border px-3 py-1 text-sm'
              }
            >
              {t(`kind.${k}`)}
            </button>
          ))}
        </div>
      </div>

      {draft.kind !== 'new_case' && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={id('ref')}>{t('fields.caseRef')}</Label>
          <Input
            id={id('ref')}
            value={draft.caseRef}
            placeholder="4271RAKD / TC-26-04271-RAK"
            onChange={(e) => set('caseRef', e.target.value)}
            autoComplete="off"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={id('bank')}>{t('fields.bank')}</Label>
        <select
          id={id('bank')}
          className={NATIVE_FIELD}
          value={draft.bankCode}
          onChange={(e) => set('bankCode', e.target.value)}
        >
          <option value="">{t('fields.bankNone')}</option>
          {banks.map((b) => (
            <option key={b.bankCode} value={b.bankCode}>
              {b.bankName}
              {b.shortCode ? ` (${b.shortCode})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={id('doc')}>{t('fields.docKey')}</Label>
        <Input
          id={id('doc')}
          value={draft.docKey}
          placeholder="trade_licence"
          onChange={(e) =>
            set('docKey', e.target.value.toLowerCase().replace(/[\s-]+/g, '_'))
          }
        />
      </div>

      {draft.kind === 'new_case' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={id('company')}>{t('fields.company')}</Label>
            <Input
              id={id('company')}
              value={draft.companyName}
              onChange={(e) => set('companyName', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id('licence')}>{t('fields.licence')}</Label>
            <Input
              id={id('licence')}
              value={draft.tradeLicence}
              onChange={(e) => set('tradeLicence', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id('product')}>{t('fields.product')}</Label>
            <Input
              id={id('product')}
              value={draft.product}
              onChange={(e) => set('product', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fields.contact')}</Label>
            <ContactPicker
              selected={draft.contact}
              onChange={(c) => set('contact', c)}
              placeholder={t('fields.contactPlaceholder')}
            />
          </div>
        </>
      )}

      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={id('note')}>{t('fields.note')}</Label>
        <Textarea
          id={id('note')}
          rows={2}
          value={draft.note}
          onChange={(e) => set('note', e.target.value)}
        />
      </div>
    </div>
  );
}

/** The draft as API tag fields (blank -> null). */
export function draftToTags(d: TagDraft) {
  const v = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    kind: d.kind === '' ? null : d.kind,
    bankCode: v(d.bankCode),
    caseRef: d.kind === 'new_case' ? null : v(d.caseRef),
    companyName: d.kind === 'new_case' ? v(d.companyName) : null,
    tradeLicence: d.kind === 'new_case' ? v(d.tradeLicence) : null,
    product: d.kind === 'new_case' ? v(d.product) : null,
    contactId: d.kind === 'new_case' ? (d.contact?.id ?? null) : null,
    docKey: v(d.docKey),
    note: v(d.note),
  };
}
