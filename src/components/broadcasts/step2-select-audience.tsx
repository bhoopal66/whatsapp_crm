'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  cachedQuery,
  REFERENCE_CACHE_TTL_MS,
  TAGS_CACHE_KEY,
} from '@/lib/client-cache';
import { parseContactCsv } from '@/lib/contacts/parse-contact-csv';
import {
  partitionRowsByPhone,
  summarizeRejectedPhones,
} from '@/lib/contacts/phone-validation';
import type { CsvContactRow } from '@/lib/broadcasts/variables';
import {
  COMPASS_ORDERS,
  compassColumns,
  compassRowToCsvRow,
  compassSelectionKey,
  compassWindowPage,
  compassWindowSize,
  DEFAULT_COMPASS_SELECTION,
  normalizeCompassSelection,
  parseCompassLimit,
  parseCompassStart,
  type CompassAudienceRow,
  type CompassOrder,
  type CompassSelection,
} from '@/lib/broadcasts/compass-audience';
import { compassAudienceQuery } from '@/hooks/use-broadcast-sending';
import { useAuth } from '@/hooks/use-auth';
import { CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Users,
  Tags,
  Filter,
  Upload,
  Building2,
  Loader2,
  ArrowRight,
  ArrowLeft,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv' | 'compass';

/** Pause after the last audience change before re-counting. */
const ESTIMATE_DEBOUNCE_MS = 300;

/**
 * Rows of a Compass slice read for the personalize step: enough to list
 * the ERP fields the slice carries and preview its first recipient,
 * without downloading the whole slice on every keystroke.
 */
const COMPASS_SAMPLE_SIZE = 200;
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: CsvContactRow[];
  /** Lower-cased CSV headers — the personalize step offers them as variable sources. */
  csvColumns?: string[];
  /** Which slice of the Compass customers a `compass` audience takes. */
  compass?: CompassSelection;
  /**
   * First row of the sample below — the personalize preview only. The
   * send re-reads the whole slice; it never treats this as the audience.
   */
  compassSample?: CsvContactRow;
  /**
   * The whole sample (≤ COMPASS_SAMPLE_SIZE rows of the slice), so the
   * personalize step can count who a variable would leave blank.
   */
  compassSampleRows?: CsvContactRow[];
  /** `compassSelectionKey` of the selection `compassSample` was read for. */
  compassSampleKey?: string;
  excludeTagIds?: string[];
  /** Frequency cap — skip anyone sent a campaign in the last N days. */
  skipRecentDays?: number;
}

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const t = useTranslations('Broadcasts.wizard');

  const OPERATOR_OPTIONS = useMemo<
    { value: CustomFieldOperator; label: string }[]
  >(
    () => [
      { value: 'is', label: t('selectAudience.operatorIs') },
      { value: 'is_not', label: t('selectAudience.operatorIsNot') },
      { value: 'contains', label: t('selectAudience.operatorContains') },
    ],
    [t]
  );

  const audienceOptions = useMemo<
    {
      type: AudienceType;
      label: string;
      description: string;
      icon: typeof Users;
    }[]
  >(
    () => [
      {
        type: 'all',
        label: t('selectAudience.method.all'),
        description: t('selectAudience.allDescLoading'),
        icon: Users,
      },
      {
        type: 'tags',
        label: t('selectAudience.method.tags'),
        description: t('selectAudience.tagDesc'),
        icon: Tags,
      },
      {
        type: 'custom_field',
        label: t('selectAudience.method.customField'),
        description: t('selectAudience.customFieldDesc'),
        icon: Filter,
      },
      {
        type: 'csv',
        label: t('selectAudience.method.csv'),
        description: t('selectAudience.csvDesc'),
        icon: Upload,
      },
      {
        type: 'compass',
        label: t('selectAudience.method.compass'),
        description: t('selectAudience.compassDesc'),
        icon: Building2,
      },
    ],
    [t]
  );
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const { accountId } = useAuth();

  // Compass audience: how many customers have a phone (the list the
  // slice is cut from), and a sample of the slice for the personalize
  // step. Both are read with the send's own query
  // (`compassAudienceQuery`), so what is previewed is what is sent.
  const [compassTotal, setCompassTotal] = useState<number | null>(null);
  const [compassLoading, setCompassLoading] = useState(false);
  const [compassError, setCompassError] = useState<string | null>(null);
  const [compassPhoneWarning, setCompassPhoneWarning] = useState<string | null>(
    null
  );
  const compassSelection = useMemo(
    () => normalizeCompassSelection(audience.compass),
    [audience.compass]
  );
  // The sample lands after a debounce and a round trip; writing it into
  // the audience captured when the request started would undo anything
  // changed meanwhile (the frequency cap, say), so it merges into the
  // latest one.
  const audienceRef = useRef(audience);
  useEffect(() => {
    audienceRef.current = audience;
  }, [audience]);
  const compassSeq = useRef(0);
  useEffect(() => {
    if (audience.type !== 'compass' || !accountId) return;
    const seq = ++compassSeq.current;
    const selection = compassSelection;
    const timer = setTimeout(async () => {
      setCompassLoading(true);
      const mergeSample = (patch: Partial<AudienceConfig>) => {
        const latest = audienceRef.current;
        if (latest.type === 'compass') onUpdate({ ...latest, ...patch });
      };
      try {
        const supabase = createClient();
        const page = compassWindowPage(selection, 0, COMPASS_SAMPLE_SIZE);
        const [countRes, sampleRes] = await Promise.all([
          supabase
            .from('compass_contacts')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', accountId)
            .not('phone_normalized', 'is', null),
          page
            ? compassAudienceQuery(supabase, accountId, selection.order).range(
                page.from,
                page.to
              )
            : null,
        ]);
        if (seq !== compassSeq.current) return;
        if (countRes.error) throw new Error(countRes.error.message);
        const total = countRes.count ?? 0;
        // A start past the end has nothing to sample; whatever the
        // range read answered there is not worth an error.
        if (sampleRes?.error && compassWindowSize(selection, total) > 0) {
          throw new Error(sampleRes.error.message);
        }
        const rows = (
          sampleRes?.error ? [] : (sampleRes?.data ?? [])
        ) as CompassAudienceRow[];
        // Same rule the send applies: a number the contact rules refuse
        // is skipped. Only the sample is checked here, so say so.
        const { valid, rejected } = partitionRowsByPhone(
          rows.map(compassRowToCsvRow)
        );
        setCompassTotal(total);
        setCompassError(null);
        setCompassPhoneWarning(
          rejected.length > 0 ? summarizeRejectedPhones(rejected) : null
        );
        mergeSample({
          csvColumns: compassColumns(valid),
          compassSample: valid[0],
          compassSampleRows: valid,
          compassSampleKey: compassSelectionKey(selection),
        });
      } catch (err) {
        if (seq !== compassSeq.current) return;
        setCompassTotal(null);
        setCompassPhoneWarning(null);
        setCompassError(err instanceof Error ? err.message : String(err));
        mergeSample({
          csvColumns: undefined,
          compassSample: undefined,
          compassSampleRows: undefined,
          compassSampleKey: undefined,
        });
      } finally {
        if (seq === compassSeq.current) setCompassLoading(false);
      }
    }, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [audience.type, accountId, compassSelection, onUpdate]);

  function updateCompass(patch: Partial<CompassSelection>) {
    onUpdate({
      ...audience,
      compass: normalizeCompassSelection({ ...compassSelection, ...patch }),
    });
  }

  // The start and count fields hold what was typed, not the selection:
  // deriving them from it snapped a cleared start back to "1", so
  // clearing it and typing "500" read "1500". A valid entry is committed
  // to the selection as it is typed; an invalid one keeps Next disabled.
  // Seeded from the selection, since the wizard can come back here.
  const [compassStartText, setCompassStartText] = useState(() =>
    String(compassSelection.offset + 1)
  );
  const [compassLimitText, setCompassLimitText] = useState(() =>
    compassSelection.limit === null ? '' : String(compassSelection.limit)
  );
  const compassStartValid = parseCompassStart(compassStartText) !== null;
  const compassLimitValid = parseCompassLimit(compassLimitText) !== null;

  function onCompassStartChange(text: string) {
    setCompassStartText(text);
    const offset = parseCompassStart(text);
    if (offset !== null) updateCompass({ offset });
  }

  function onCompassLimitChange(text: string) {
    setCompassLimitText(text);
    const parsed = parseCompassLimit(text);
    if (parsed !== null) updateCompass({ limit: parsed.limit });
  }

  // Tags are used both by the primary "Filter by Tags" audience type
  // AND by the exclude-list below — so always load once on mount.
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        // Shared tag cache (same key and loader shape as the inbox and
        // contacts screens); tag writes invalidate it.
        const data = await cachedQuery(
          TAGS_CACHE_KEY,
          REFERENCE_CACHE_TTL_MS,
          async () => {
            const supabase = createClient();
            const { data } = await supabase
              .from('tags')
              .select('*')
              .order('name');
            return (data as Tag[] | null) ?? [];
          }
        ).catch(() => [] as Tag[]);
        setTags(data);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  // Lazy-load custom fields only when that audience type is active.
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  // Audience estimate, counted in the database. It used to download
  // the matching contact_id lists (and the exclude list) and count them
  // here: up to three sequential round trips per change, silently
  // capped at PostgREST's max-rows, re-run on every tag toggle. Now it
  // is at most two `head` counts fired together, debounced so a burst
  // of toggles asks once.
  //
  //   estimate = |base| − |base ∩ excluded|
  //
  // `base` uses the same filter shape the send resolves the audience
  // with (`use-broadcast-sending.ts` resolveAudience): contacts with an
  // `!inner` embed, so a contact matching several tags counts once.
  // "Excluded" = carries any exclude tag. The frequency cap is still
  // not reflected — see the note on that control below.
  const estimateSeq = useRef(0);
  const fetchEstimatedCount = useCallback(async () => {
    const seq = ++estimateSeq.current;
    const commit = (n: number | null) => {
      if (seq !== estimateSeq.current) return; // superseded
      setEstimatedCount(n);
      setLoadingCount(false);
    };

    if (audience.type === 'csv') {
      commit(
        audience.csvContacts && audience.csvContacts.length > 0
          ? audience.csvContacts.length
          : null
      );
      return;
    }

    // The slice size; exclude tags and the frequency cap apply at send
    // and can only lower it (noted under the estimate).
    if (audience.type === 'compass') {
      commit(
        compassTotal === null
          ? null
          : compassWindowSize(compassSelection, compassTotal)
      );
      return;
    }

    const tagIds = audience.tagIds ?? [];
    const field = audience.customField;
    const configured =
      audience.type === 'all' ||
      (audience.type === 'tags' && tagIds.length > 0) ||
      (audience.type === 'custom_field' && !!field?.fieldId && !!field.value);
    if (!configured) {
      // Partially-configured audience — wait for the user to finish.
      commit(null);
      return;
    }

    setLoadingCount(true);
    const supabase = createClient();
    const excludeTagIds = audience.excludeTagIds ?? [];

    // Builds the base count; `withExcluded` additionally requires an
    // exclude tag, giving |base ∩ excluded|.
    const countAudience = (withExcluded: boolean) => {
      const embeds: string[] = ['id'];
      if (audience.type === 'tags')
        embeds.push('inc:contact_tags!inner(tag_id)');
      if (audience.type === 'custom_field')
        embeds.push('cf:contact_custom_values!inner(value)');
      if (withExcluded) embeds.push('exc:contact_tags!inner(tag_id)');

      let q = supabase
        .from('contacts')
        .select(embeds.join(', '), { count: 'exact', head: true });
      if (audience.type === 'tags') q = q.in('inc.tag_id', tagIds);
      if (audience.type === 'custom_field' && field) {
        q = q.eq('cf.custom_field_id', field.fieldId);
        if (field.operator === 'is') q = q.eq('cf.value', field.value);
        else if (field.operator === 'is_not')
          q = q.neq('cf.value', field.value);
        else q = q.ilike('cf.value', `%${field.value}%`);
      }
      if (withExcluded) q = q.in('exc.tag_id', excludeTagIds);
      return q;
    };

    try {
      const [base, excluded] = await Promise.all([
        countAudience(false),
        excludeTagIds.length > 0 ? countAudience(true) : null,
      ]);
      if (base.error || excluded?.error) {
        console.error(
          '[broadcast] audience estimate failed:',
          base.error ?? excluded?.error
        );
        commit(null);
        return;
      }
      commit(Math.max(0, (base.count ?? 0) - (excluded?.count ?? 0)));
    } catch (err) {
      console.error('[broadcast] audience estimate failed:', err);
      commit(null);
    }
  }, [
    audience.type,
    audience.tagIds,
    audience.customField,
    audience.csvContacts,
    audience.excludeTagIds,
    compassSelection,
    compassTotal,
  ]);

  useEffect(() => {
    const timer = setTimeout(fetchEstimatedCount, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fetchEstimatedCount]);

  // CSV audience. Parsed in the browser with the same parser the
  // contacts importer uses (a `phone` column, optional `name`); the
  // rows ride along in `audience.csvContacts` and are upserted as
  // contacts at send time (`use-broadcast-sending.ts`). Every column
  // is kept (`values`) so the personalize step can map a template
  // variable to any of them, not just the ones the importer knows.
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvPhoneWarning, setCsvPhoneWarning] = useState<string | null>(null);

  async function handleCsvFile(file: File | undefined) {
    if (!file) return;
    setCsvError(null);
    setCsvPhoneWarning(null);
    try {
      const text = await file.text();
      const headerHasPhone = /(^|,)\s*["']?phone["']?\s*(,|$)/i.test(
        text.split(/\r?\n/)[0] ?? ''
      );
      if (!headerHasPhone) {
        setCsvError(t('selectAudience.errorCsvMissingPhone'));
        onUpdate({
          ...audience,
          csvContacts: undefined,
          csvColumns: undefined,
        });
        return;
      }
      const { rows, columns } = parseContactCsv(text);
      // Rows become contacts at send time. A number without its country
      // code (or an Excel "9.71505E+11") would be created and messaged,
      // reported 'sent', and reach nobody — so it is left out here and
      // named, while the rest of the file still goes.
      const { valid, rejected } = partitionRowsByPhone(rows);
      setCsvPhoneWarning(
        rejected.length > 0 ? summarizeRejectedPhones(rejected) : null
      );
      setCsvFileName(file.name);
      onUpdate({
        ...audience,
        csvContacts: valid.map((r) => ({
          phone: r.phone,
          name: r.name,
          company: r.company,
          values: r.values,
        })),
        csvColumns: columns,
      });
    } catch {
      setCsvError(t('selectAudience.errorCsvParse'));
      onUpdate({ ...audience, csvContacts: undefined, csvColumns: undefined });
    }
  }

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, tagIds: updated });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, excludeTagIds: updated });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  const isValid =
    audience.type === 'all' ||
    (audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0) ||
    (audience.type === 'custom_field' &&
      !!audience.customField?.fieldId &&
      audience.customField.value.length > 0) ||
    (audience.type === 'csv' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0) ||
    (audience.type === 'compass' &&
      compassStartValid &&
      compassLimitValid &&
      !compassLoading &&
      // Not a sample still standing in for the previous selection (Next
      // clicked inside the debounce): the preview must match the slice.
      audience.compassSampleKey === compassSelectionKey(compassSelection) &&
      compassTotal !== null &&
      compassWindowSize(compassSelection, compassTotal) > 0);

  const compassWindow =
    compassTotal === null
      ? 0
      : compassWindowSize(compassSelection, compassTotal);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('selectAudience.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('selectAudience.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map(
          (option: {
            type: AudienceType;
            label: string;
            description: string;
            icon: typeof Users;
          }) => {
            const isSelected = audience.type === option.type;
            const Icon = option.icon;
            return (
              <button
                key={option.type}
                onClick={() => {
                  // Switching to Compass starts from the default slice
                  // (see `compass` below), so the fields start from it too.
                  if (
                    option.type === 'compass' &&
                    audience.type !== 'compass'
                  ) {
                    const next = normalizeCompassSelection(
                      audience.compass ?? DEFAULT_COMPASS_SELECTION
                    );
                    setCompassStartText(String(next.offset + 1));
                    setCompassLimitText(
                      next.limit === null ? '' : String(next.limit)
                    );
                  }
                  onUpdate({
                    ...audience,
                    type: option.type,
                    // Wipe shape fields from other types to avoid stale
                    // config leaking across selections.
                    tagIds:
                      option.type === 'tags' ? audience.tagIds : undefined,
                    customField:
                      option.type === 'custom_field'
                        ? audience.customField
                        : undefined,
                    csvContacts:
                      option.type === 'csv' ? audience.csvContacts : undefined,
                    // A Compass audience fills csvColumns from its sample;
                    // keep them only while it stays a Compass audience.
                    csvColumns:
                      option.type === 'csv' ||
                      (option.type === 'compass' && audience.type === 'compass')
                        ? audience.csvColumns
                        : undefined,
                    compass:
                      option.type === 'compass'
                        ? (audience.compass ?? DEFAULT_COMPASS_SELECTION)
                        : undefined,
                    compassSample:
                      option.type === 'compass'
                        ? audience.compassSample
                        : undefined,
                    compassSampleRows:
                      option.type === 'compass'
                        ? audience.compassSampleRows
                        : undefined,
                    compassSampleKey:
                      option.type === 'compass'
                        ? audience.compassSampleKey
                        : undefined,
                  });
                }}
                className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                    : 'border-border bg-card/50 hover:border-border'
                }`}
              >
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    isSelected
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-foreground text-sm font-medium">
                    {option.label}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {option.description}
                  </p>
                </div>
              </button>
            );
          }
        )}
      </div>

      {audience.type === 'tags' && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <p className="text-foreground mb-3 text-sm font-medium">
            {t('selectAudience.selectTags')}
          </p>
          {loadingTags ? (
            <Loader2 className="text-primary h-5 w-5 animate-spin" />
          ) : tags.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t('selectAudience.noTagsFound')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = audience.tagIds?.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                      isSelected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:border-border'
                    }`}
                  >
                    <span
                      className="mr-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {audience.type === 'custom_field' && (
        <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
          <p className="text-foreground text-sm font-medium">
            {t('selectAudience.method.customField')}
          </p>
          {loadingFields ? (
            <Loader2 className="text-primary h-5 w-5 animate-spin" />
          ) : customFields.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t('selectAudience.errorLoadFields')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
              >
                <option value="">{t('selectAudience.selectField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
              >
                {OPERATOR_OPTIONS.map(
                  (op: { value: CustomFieldOperator; label: string }) => (
                    <option key={op.value} value={op.value}>
                      {op.label}
                    </option>
                  )
                )}
              </select>
              <input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder={t('selectAudience.valuePlaceholder')}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
              />
            </div>
          )}
        </div>
      )}

      {audience.type === 'csv' && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <p className="text-foreground mb-1 text-sm font-medium">
            {t('selectAudience.uploadCsv')}
          </p>
          <p className="text-muted-foreground mb-3 text-xs">
            {t('selectAudience.csvFormatDesc')}{' '}
            <a
              href="/templates/broadcast-contacts.csv"
              download
              className="text-foreground underline underline-offset-2"
            >
              {t('selectAudience.downloadTemplate')}
            </a>
          </p>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              void handleCsvFile(e.target.files?.[0]);
              // Allow re-selecting the same file after a fix.
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => csvInputRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              {t('selectAudience.uploadCsv')}
            </Button>
            {csvFileName && (
              <span className="text-muted-foreground text-xs">
                {csvFileName}
              </span>
            )}
          </div>
          {csvError && <p className="mt-2 text-xs text-red-400">{csvError}</p>}
          {!csvError && audience.csvContacts && (
            <p className="text-foreground mt-2 text-xs">
              {t('selectAudience.csvContactsFound', {
                count: audience.csvContacts.length,
              })}
            </p>
          )}
          {!csvError && csvPhoneWarning && (
            <p className="mt-1 text-xs text-amber-400">{csvPhoneWarning}</p>
          )}
        </div>
      )}

      {audience.type === 'compass' && (
        <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
          <p className="text-foreground text-sm font-medium">
            {t('selectAudience.method.compass')}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_140px_140px]">
            <label className="space-y-1">
              <span className="text-muted-foreground block text-xs font-medium">
                {t('selectAudience.compassOrder')}
              </span>
              <select
                value={compassSelection.order}
                onChange={(e) =>
                  updateCompass({ order: e.target.value as CompassOrder })
                }
                className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 w-full rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
              >
                {COMPASS_ORDERS.map((order) => (
                  <option key={order} value={order}>
                    {t(`selectAudience.compassOrders.${order}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-muted-foreground block text-xs font-medium">
                {t('selectAudience.compassStart')}
              </span>
              {/* Positions are 1-based on screen; the offset is 0-based.
                  Text, not type="number": a number input reports a
                  half-typed "5e" as "", which the count would read as
                  "all". */}
              <Input
                type="text"
                inputMode="numeric"
                value={compassStartText}
                aria-invalid={!compassStartValid}
                onChange={(e) => onCompassStartChange(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
              {!compassStartValid && (
                <span className="block text-xs text-red-400">
                  {t('selectAudience.compassStartInvalid')}
                </span>
              )}
            </label>
            <label className="space-y-1">
              <span className="text-muted-foreground block text-xs font-medium">
                {t('selectAudience.compassLimit')}
              </span>
              <Input
                type="text"
                inputMode="numeric"
                value={compassLimitText}
                aria-invalid={!compassLimitValid}
                placeholder={t('selectAudience.compassLimitAll')}
                onChange={(e) => onCompassLimitChange(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
              {!compassLimitValid && (
                <span className="block text-xs text-red-400">
                  {t('selectAudience.compassLimitInvalid')}
                </span>
              )}
            </label>
          </div>
          <p className="text-muted-foreground text-xs">
            {t('selectAudience.compassHint')}
          </p>
          {/* With a field that does not parse, the selection still holds
              the last valid one — showing its range beside the red hint
              would describe a slice that is not the one on screen. */}
          {!compassStartValid || !compassLimitValid ? null : compassLoading ? (
            <Loader2 className="text-primary h-4 w-4 animate-spin" />
          ) : compassError ? (
            <p className="text-xs text-red-400">
              {t('selectAudience.compassError', { error: compassError })}
            </p>
          ) : compassTotal === 0 ? (
            <p className="text-xs text-amber-400">
              {t('selectAudience.compassNone')}
            </p>
          ) : compassTotal !== null && compassWindow === 0 ? (
            <p className="text-xs text-amber-400">
              {t('selectAudience.compassWindowEmpty', { total: compassTotal })}
            </p>
          ) : compassTotal !== null ? (
            <p className="text-foreground text-xs">
              {t('selectAudience.compassWindow', {
                from: compassSelection.offset + 1,
                to: compassSelection.offset + compassWindow,
                total: compassTotal,
              })}
            </p>
          ) : null}
          {!compassLoading && !compassError && compassPhoneWarning && (
            <p className="text-xs text-amber-400">
              {t('selectAudience.compassPhoneWarning', {
                summary: compassPhoneWarning,
              })}
            </p>
          )}
        </div>
      )}

      {/* Exclude list — applies regardless of audience type */}
      <div className="border-border bg-card/50 rounded-xl border p-4">
        <div className="mb-3 flex items-center gap-2">
          <X className="h-4 w-4 text-red-400" />
          <p className="text-foreground text-sm font-medium">
            {t('selectAudience.excludeTags')}
          </p>
        </div>
        {tags.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            {t('selectAudience.noTagsFound')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isExcluded = audience.excludeTagIds?.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleExcludeTag(tag.id)}
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    isExcluded
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-border bg-muted text-muted-foreground hover:border-border'
                  }`}
                >
                  <span
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Frequency cap — applies regardless of audience type. Not
          reflected in the estimate below: that would cost a second
          recipients query per keystroke, and the exact count shows on
          the campaign once created. */}
      <div className="border-border bg-card/50 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-foreground text-sm font-medium">
              {t('selectAudience.frequencyCap')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t('selectAudience.frequencyCapDesc')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={365}
              value={audience.skipRecentDays ?? 0}
              onChange={(e) =>
                onUpdate({
                  ...audience,
                  skipRecentDays: Math.max(
                    0,
                    Math.min(365, Math.floor(Number(e.target.value) || 0))
                  ),
                })
              }
              className="border-border bg-muted text-foreground w-20"
            />
            <span className="text-muted-foreground text-xs">
              {t('selectAudience.frequencyCapDays')}
            </span>
          </div>
        </div>
      </div>

      {/* Audience Summary */}
      <div className="border-border bg-card/50 rounded-xl border p-4">
        <p className="text-foreground mb-2 text-sm font-medium">
          Audience Summary
        </p>
        {loadingCount || (audience.type === 'compass' && compassLoading) ? (
          <div className="flex items-center gap-2">
            <Loader2 className="text-primary h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-xs">Calculating…</span>
          </div>
        ) : estimatedCount !== null ? (
          <div className="flex items-center gap-2">
            <Users className="text-primary h-4 w-4" />
            <span className="text-foreground text-sm">
              {estimatedCount.toLocaleString()}
            </span>
            <span className="text-muted-foreground text-xs">
              estimated recipients
            </span>
            {audience.type === 'compass' && (
              <span className="text-muted-foreground text-xs">
                · {t('selectAudience.compassEstimateNote')}
              </span>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            Select an audience type to see the estimate.
          </p>
        )}
      </div>

      <div className="border-border flex items-center justify-between border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!isValid}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
