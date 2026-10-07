'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import {
  headerMediaAccept,
  isMediaHeaderKind,
  toMb,
  validateHeaderMediaFile,
} from '@/lib/whatsapp/header-media';
import { Contact, CustomField, MessageTemplate } from '@/types';
import {
  resolveVariable,
  type CsvContactRow,
  type VariableMapping,
  type VariableType,
} from '@/lib/broadcasts/variables';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  FileSpreadsheet,
  ImageIcon,
  Loader2,
  Upload,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Step3Audience {
  type: 'all' | 'tags' | 'custom_field' | 'csv' | 'compass';
  csvContacts?: CsvContactRow[];
  csvColumns?: string[];
  /** First row of a Compass slice's sample (step 2) — preview only. */
  compassSample?: CsvContactRow;
}

interface Step3Props {
  template: MessageTemplate;
  /**
   * Only the CSV parts are read: a `csv` audience adds "CSV column" as
   * a variable source and drives the preview from the file's first
   * row, so the admin sees exactly what row 1 will receive. A
   * `compass` audience works the same way through the same `csv_column`
   * mapping, labelled "Compass field", with the slice's first row.
   */
  audience: Step3Audience;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const contactFields = [
  { value: 'name', labelKey: 'name' },
  { value: 'phone', labelKey: 'phone' },
  { value: 'email', labelKey: 'email' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  audience,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  const isCompass = audience.type === 'compass';
  const csvColumns = useMemo(
    () =>
      audience.type === 'csv' || audience.type === 'compass'
        ? (audience.csvColumns ?? [])
        : [],
    [audience.type, audience.csvColumns]
  );
  const csvFirstRow =
    audience.type === 'csv'
      ? (audience.csvContacts?.[0] ?? null)
      : isCompass
        ? (audience.compassSample ?? null)
        : null;
  const csvAvailable = csvColumns.length > 0;

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)].sort();
  }, [template.body_text]);

  // Templates with an IMAGE/VIDEO/DOCUMENT header need a media URL at
  // send time — Meta requires the media component on every delivery and
  // rejects the broadcast without it. The field is hidden for text-only
  // headers.
  const mediaHeaderType = isMediaHeaderKind(template.header_type)
    ? template.header_type
    : null;

  // Upload the header media here rather than making the admin host it
  // somewhere: a template synced from Meta arrives with a video header
  // and no URL (Meta only exposes the review sample as a handle), and
  // without a URL the send is refused — see template-send-builder.
  const [uploadingHeader, setUploadingHeader] = useState(false);
  const headerFileRef = useRef<HTMLInputElement>(null);
  async function handleHeaderMediaFile(file: File) {
    if (!mediaHeaderType) return;
    const problem = validateHeaderMediaFile(mediaHeaderType, file);
    if (problem?.kind === 'type') {
      toast.error(
        t('personalize.toastInvalidMedia', {
          format: mediaHeaderType,
          types: problem.allowed.join(', '),
        })
      );
      return;
    }
    if (problem?.kind === 'size') {
      toast.error(
        t('personalize.toastMediaTooLarge', {
          size: toMb(problem.bytes),
          max: toMb(problem.maxBytes),
        })
      );
      return;
    }
    setUploadingHeader(true);
    try {
      const { publicUrl } = await uploadAccountMedia('chat-media', file);
      onHeaderMediaUrlChange(publicUrl);
      toast.success(t('personalize.toastUploadSuccess'));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('personalize.toastUploadFailed')
      );
    } finally {
      setUploadingHeader(false);
    }
  }

  // Seed the field with the template's stored sample URL the first time
  // we land on a media-header template, so the common "reuse the
  // approved media" case needs no typing. Only seeds when empty to avoid
  // clobbering a URL the user already edited.
  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    if (!mediaHeaderType) return null;
    const value = headerMediaUrl.trim();
    if (!value) return 'missing';
    if (!isValidHttpUrl(value)) return 'invalid';
    return null;
  }, [mediaHeaderType, headerMediaUrl]);

  /**
   * A placeholder is "unmapped" if the user hasn't picked either a
   * static value or a field/custom-field/CSV-column source. Blocks
   * Next until every placeholder has something — otherwise the
   * broadcast would ship with empty strings and confuse recipients. A
   * CSV column counts only while it exists in the current upload:
   * going back and choosing another audience, or another file, must
   * not leave a dangling column name that resolves to '' for everyone.
   */
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      } else if (
        mapping.type === 'csv_column' &&
        !csvColumns.includes(mapping.value)
      ) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables, csvColumns]);

  function updateVariable(
    key: string,
    patch: { type?: VariableType; value?: string }
  ) {
    const current = variables[key] ?? { type: 'static', value: '' };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch } as VariableMapping,
    });
  }

  /**
   * The recipient the preview is rendered for. A CSV audience previews
   * the file's first row — that is the only thing that has the CSV
   * columns — and otherwise the newest real contact, falling back to
   * sample data on an empty CRM.
   */
  const previewSubject = useMemo(() => {
    if (csvFirstRow) {
      return {
        contact: {
          name: csvFirstRow.name ?? csvFirstRow.values?.name ?? '',
          phone: csvFirstRow.phone,
          email: csvFirstRow.values?.email ?? '',
          company: csvFirstRow.company ?? csvFirstRow.values?.company ?? '',
        },
        customValues: new Map<string, string>(),
        csvValues: csvFirstRow.values ?? {},
      };
    }
    return {
      contact: firstContact ?? SAMPLE_CONTACT,
      customValues: firstContact
        ? firstContactCustomValues
        : new Map<string, string>(),
      csvValues: undefined,
    };
  }, [csvFirstRow, firstContact, firstContactCustomValues]);

  /**
   * Substitute placeholders for the preview subject, with the same
   * resolver the send path uses. Placeholders keyed by "{{N}}" map to
   * variable key "N"; anything unresolved stays as the placeholder so
   * the gap is visible.
   */
  const previewText = useMemo(() => {
    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      const resolved = mapping?.value
        ? resolveVariable(
            mapping,
            previewSubject.contact,
            previewSubject.customValues,
            previewSubject.csvValues
          )
        : undefined;
      text = text.replaceAll(placeholder, resolved || placeholder);
    }
    return text;
  }, [template.body_text, variables, placeholders, previewSubject]);

  const previewLabel = csvFirstRow
    ? t(
        isCompass
          ? 'personalize.previewCompassRow'
          : 'personalize.previewCsvRow',
        {
          who: previewSubject.contact.name || csvFirstRow.phone,
        }
      )
    : firstContact
      ? firstContact.name || firstContact.phone
      : t('personalize.previewSample');

  /** First-row value for a CSV column, shown next to each option. */
  function csvExample(column: string): string {
    return csvFirstRow?.values?.[column]?.trim() || '—';
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('personalize.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('personalize.subtitle')}
        </p>
      </div>

      {mediaHeaderType && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="text-primary h-4 w-4" />
            <p className="text-foreground text-sm font-medium">
              {t('personalize.headerImage')}
            </p>
            <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium uppercase">
              {mediaHeaderType}
            </span>
          </div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
            {t('personalize.imageUrl')}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="url"
              value={headerMediaUrl}
              onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
              placeholder={t('personalize.imageUrlPlaceholder')}
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground min-w-0 flex-1"
            />
            <input
              ref={headerFileRef}
              type="file"
              accept={headerMediaAccept(mediaHeaderType)}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleHeaderMediaFile(f);
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploadingHeader}
              onClick={() => headerFileRef.current?.click()}
            >
              {uploadingHeader ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {t(`personalize.uploadMedia.${mediaHeaderType}`)}
            </Button>
          </div>
          <p className="text-muted-foreground mt-1.5 text-xs">
            {t(`personalize.headerMediaDesc.${mediaHeaderType}`)}
          </p>
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt="Header preview"
                className="border-border mt-3 max-h-40 rounded-lg border object-contain"
              />
            )}
          {mediaHeaderType === 'video' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              <video
                src={headerMediaUrl.trim()}
                controls
                preload="metadata"
                className="border-border mt-3 max-h-48 rounded-lg border bg-black"
              />
            )}
          {headerMediaError && (
            <p className="mt-1.5 text-xs text-amber-300">
              {headerMediaError === 'missing'
                ? 'A media URL is required to send this template.'
                : 'Enter a valid http(s) URL.'}
            </p>
          )}
        </div>
      )}

      {placeholders.length === 0 && !mediaHeaderType ? (
        <div className="border-border bg-card/50 rounded-xl border p-6 text-center">
          <p className="text-muted-foreground text-sm">
            {t('personalize.noPreview')}
          </p>
        </div>
      ) : placeholders.length === 0 ? null : (
        <div className="space-y-4">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={placeholder}
                className="border-border bg-card/50 rounded-xl border p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <p className="text-foreground text-sm font-medium">
                    {t('personalize.variableLabel', { n: key })}
                  </p>
                  <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs font-medium">
                    {placeholder}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
                      {t('personalize.type')}
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="border-border bg-muted text-foreground w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        <SelectItem value="static">
                          {t('personalize.typeStatic')}
                        </SelectItem>
                        <SelectItem value="field">
                          {t('personalize.typeContact')}
                        </SelectItem>
                        <SelectItem value="custom_field">
                          {t('personalize.typeCustom')}
                        </SelectItem>
                        {csvAvailable && (
                          <SelectItem value="csv_column">
                            {isCompass
                              ? t('personalize.typeCompassField')
                              : t('personalize.typeCsvColumn')}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
                      {mapping.type === 'static'
                        ? t('personalize.staticValue')
                        : mapping.type === 'csv_column'
                          ? isCompass
                            ? t('personalize.compassField')
                            : t('personalize.csvColumn')
                          : t('personalize.contactField')}
                    </label>
                    {mapping.type === 'csv_column' ? (
                      <>
                        <Select
                          value={
                            csvColumns.includes(mapping.value)
                              ? mapping.value
                              : undefined
                          }
                          onValueChange={(val) =>
                            updateVariable(key, { value: val || '' })
                          }
                        >
                          <SelectTrigger className="border-border bg-muted text-foreground w-full">
                            <SelectValue
                              placeholder={
                                csvAvailable
                                  ? t('personalize.selectCsvColumn')
                                  : isCompass
                                    ? t('personalize.compassFieldUnavailable')
                                    : t('personalize.csvColumnUnavailable')
                              }
                            />
                          </SelectTrigger>
                          <SelectContent className="border-border bg-popover">
                            {csvColumns.map((column) => (
                              <SelectItem key={column} value={column}>
                                <span className="flex items-center gap-2">
                                  <FileSpreadsheet className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                                  <span className="font-mono">{column}</span>
                                  <span className="text-muted-foreground truncate text-xs">
                                    {t('personalize.csvExample', {
                                      value: csvExample(column),
                                    })}
                                  </span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {csvColumns.includes(mapping.value) && (
                          <p className="text-muted-foreground mt-1.5 text-xs">
                            {t(
                              isCompass
                                ? 'personalize.compassFieldHint'
                                : 'personalize.csvColumnHint',
                              {
                                placeholder,
                                column: mapping.value,
                                example: csvExample(mapping.value),
                              }
                            )}
                          </p>
                        )}
                      </>
                    ) : mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder="Enter value..."
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="border-border bg-muted text-foreground w-full">
                          <SelectValue
                            placeholder={t('personalize.selectContactField')}
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {t(`personalize.fieldMap.${field.labelKey}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="border-border bg-muted text-foreground w-full">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? 'Loading…'
                                : customFields.length === 0
                                  ? 'No custom fields'
                                  : 'Select custom field…'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview — rendered as a WhatsApp-style bubble so the user
          sees approximately what the recipient will see. */}
      <div className="border-border bg-card/50 rounded-xl border p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="text-primary h-4 w-4" />
          <p className="text-foreground text-sm font-medium">
            {t('personalize.preview')}
          </p>
          <span className="text-muted-foreground text-xs">
            ({previewLabel})
          </span>
          {loadingPreview && (
            <Loader2 className="text-primary h-3.5 w-3.5 animate-spin" />
          )}
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="bg-primary/30 ml-auto max-w-[85%] rounded-lg px-3 py-2 shadow-sm">
            <p className="text-primary text-sm whitespace-pre-wrap">
              {previewText}
            </p>
          </div>
        </div>
      </div>

      {unmappedKeys.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Map every placeholder before continuing — still missing{' '}
          <span className="font-mono font-semibold">
            {unmappedKeys.join(', ')}
          </span>
          . Otherwise those placeholders will ship to Meta as empty strings.
        </div>
      )}

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
          disabled={unmappedKeys.length > 0 || headerMediaError !== null}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
