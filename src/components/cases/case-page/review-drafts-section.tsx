'use client';

/**
 * The case file reviewer's drafts on the Documents tab (migration 225).
 * Hidden while the reviewer is off for the workspace. A model narrative
 * is labelled "AI-written, not verified". Approve / reject only record a
 * decision: nothing on the case changes. The server decides who may.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { asObj, TabStatus, useCaseResource } from './tab-kit';

interface Draft {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  narrativeSource: 'model' | 'deterministic';
  body: {
    narrative: string;
    checklist_text?: string;
    flags: Array<{ code: string; detail: string }>;
  };
  createdAt: string;
}

function parseDrafts(json: unknown): { enabled: boolean; drafts: Draft[] } {
  const d = asObj(json);
  if (!Array.isArray(d?.drafts)) throw new Error('review drafts');
  return { enabled: d.enabled === true, drafts: d.drafts as Draft[] };
}

export function ReviewDraftsSection({
  caseId,
  canWrite,
}: {
  caseId: string;
  canWrite: boolean;
}) {
  const t = useTranslations('CaseReview');
  const {
    data: state,
    failed,
    reload,
  } = useCaseResource(`/api/cases/${caseId}/review-drafts`, parseDrafts);
  const [busy, setBusy] = useState(false);

  if (!state)
    return failed ? (
      <section className="space-y-3">
        <h3 className="text-foreground text-sm font-semibold">{t('title')}</h3>
        <TabStatus
          failed
          loading=""
          error={t('loadFailed')}
          onRetry={() => void reload()}
        />
      </section>
    ) : null;
  if (!state.enabled && state.drafts.length === 0) return null;
  const current =
    state.drafts.find((d) => d.status === 'pending') ?? state.drafts[0];

  const decide = async (approve: boolean) => {
    if (!current) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/cases/${caseId}/review-drafts/${current.id}/decide`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approve }),
        }
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? t('decideFailed'));
      }
    } catch {
      toast.error(t('decideFailed'));
    } finally {
      setBusy(false);
    }
    await reload();
  };

  return (
    <section className="space-y-3">
      <h3 className="text-foreground text-sm font-semibold">{t('title')}</h3>
      {!current ? (
        <p className="text-muted-foreground text-sm">{t('none')}</p>
      ) : (
        <div className="bg-card-2 space-y-3 rounded-md p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{t(`status.${current.status}`)}</Badge>
            {current.narrativeSource === 'model' && (
              <Badge className="bg-warning-soft text-warning">
                {t('aiWritten')}
              </Badge>
            )}
            <span className="text-muted-foreground">
              {new Date(current.createdAt).toLocaleString()}
            </span>
          </div>
          <p className="whitespace-pre-wrap">{current.body.narrative}</p>
          {current.narrativeSource === 'model' &&
            current.body.checklist_text && (
              <details>
                <summary className="cursor-pointer">{t('checklist')}</summary>
                <p className="text-muted-foreground mt-2 whitespace-pre-wrap">
                  {current.body.checklist_text}
                </p>
              </details>
            )}
          {current.status === 'pending' && canWrite && (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => decide(true)}>
                {t('approve')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => decide(false)}
              >
                {t('reject')}
              </Button>
            </div>
          )}
          <p className="text-muted-foreground text-xs">{t('advice')}</p>
        </div>
      )}
    </section>
  );
}

/** Settings → Cases: the reviewer's two switches (owners and admins). */
export function ReviewSettingsCard() {
  const t = useTranslations('CaseReview.settings');
  const [s, setS] = useState<{ enabled: boolean; sendToModel: boolean } | null>(
    null
  );
  useEffect(() => {
    void fetch('/api/cases/review-settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) =>
        setS(d as { enabled: boolean; sendToModel: boolean } | null)
      );
  }, []);
  if (!s) return null;
  const save = async (next: { enabled: boolean; sendToModel: boolean }) => {
    const res = await fetch('/api/cases/review-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    const b = (await res.json().catch(() => ({}))) as {
      error?: string;
      enabled?: boolean;
      sendToModel?: boolean;
    };
    if (!res.ok) return void toast.error(b.error ?? 'Something went wrong');
    setS({ enabled: b.enabled === true, sendToModel: b.sendToModel === true });
    toast.success(t('saved'));
  };
  return (
    <div className="space-y-3 rounded-md border p-4 text-sm">
      <div className="font-medium">{t('title')}</div>
      <p className="text-muted-foreground">{t('description')}</p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={(e) =>
            save({
              enabled: e.target.checked,
              sendToModel: e.target.checked && s.sendToModel,
            })
          }
        />
        {t('enabled')}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={s.sendToModel}
          disabled={!s.enabled}
          onChange={(e) =>
            save({ enabled: s.enabled, sendToModel: e.target.checked })
          }
        />
        {t('sendToModel')}
      </label>
      <p className="text-muted-foreground text-xs">{t('modelNote')}</p>
    </div>
  );
}
