'use client';

// ============================================================
// Taamul Compass → WhatsApp templates: the Meta-approved templates a
// status update goes as when the customer's 24-hour window is closed,
// one per Compass message (`COMPASS_TEMPLATES`), and where Meta's
// review of each stands. Read-only: the wording is fixed in code to
// match what Compass sends.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import {
  COMPASS_TEMPLATES,
  compassTemplateProblem,
  type CompassTemplateProblem,
} from '@/lib/compass/meta-template';
import { pickTemplateRow } from '@/lib/whatsapp/template-body';
import { refusedByMeta } from '@/lib/whatsapp/template-offer';
import type { MessageTemplate } from '@/types';
import { Badge } from '@/components/ui/badge';

type Row = Pick<
  MessageTemplate,
  | 'id'
  | 'name'
  | 'language'
  | 'status'
  | 'body_text'
  | 'rejection_reason'
  | 'meta_template_id'
  | 'submission_error'
  | 'created_at'
>;

export function CompassTemplates({ accountId }: { accountId: string }) {
  const t = useTranslations('Compass.templates');
  const tPicker = useTranslations('Inbox.templatePicker');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: err } = await createClient()
        .from('message_templates')
        .select(
          'id, name, language, status, body_text, rejection_reason, meta_template_id, submission_error, created_at'
        )
        .eq('account_id', accountId)
        .in(
          'name',
          COMPASS_TEMPLATES.map((x) => x.name)
        );
      if (cancelled) return;
      setError(!!err);
      setRows((data ?? []) as Row[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (rows === null) {
    return (
      <Loader2 className="text-muted-foreground mx-auto h-6 w-6 animate-spin" />
    );
  }

  const state = (problem: CompassTemplateProblem | null) =>
    problem === null
      ? { label: t('state.approved'), cls: 'bg-success-soft text-success' }
      : problem === 'not_approved'
        ? { label: t('state.waiting'), cls: 'bg-warning-soft text-warning' }
        : problem === 'missing'
          ? {
              label: t('state.missing'),
              cls: 'bg-destructive-soft text-destructive',
            }
          : {
              label: t('state.changed'),
              cls: 'bg-destructive-soft text-destructive',
            };

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-muted-foreground text-sm">{t('explain')}</p>
      {error && <p className="text-destructive text-sm">{t('loadFailed')}</p>}
      {COMPASS_TEMPLATES.map((tpl) => {
        // The row the send uses (`compassTemplateSend`).
        const row =
          pickTemplateRow(
            rows.filter((r) => r.name === tpl.name),
            tpl.language
          ) ?? null;
        const refused = !!row && refusedByMeta(row);
        const reason = refused ? row.submission_error : row?.rejection_reason;
        const s = refused
          ? {
              label: tPicker('blocked.not_approved'),
              cls: 'bg-destructive-soft text-destructive',
            }
          : state(compassTemplateProblem(tpl, row));
        return (
          <div
            key={tpl.name}
            className="border-border bg-card space-y-3 rounded-xl border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-foreground text-sm font-semibold">
                  {t(
                    `event.${tpl.event === 'case.approved' ? 'approved' : 'submitted'}`
                  )}
                </p>
                <p className="text-muted-foreground font-mono text-xs">
                  {tpl.name} ({tpl.language})
                </p>
              </div>
              {!error && (
                <Badge className={s.cls}>
                  {row?.status && row.status !== 'APPROVED'
                    ? `${s.label} · ${row.status}`
                    : s.label}
                </Badge>
              )}
            </div>
            {reason && (
              <p className="text-destructive text-xs">
                {t('rejected', { reason })}
              </p>
            )}
            <div className="bg-card-2 rounded-lg p-3 text-sm whitespace-pre-wrap">
              {tpl.body}
            </div>
          </div>
        );
      })}
    </div>
  );
}
