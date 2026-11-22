'use client';

/**
 * "Agent drafts" in the HR panel of a Recruiter chat (package 024a, laid
 * out like the package's 024c-3 section). Drafts only: approving one
 * sends nothing; a recruiter copies it into the chat.
 * `lib/hr/agents/panel.ts` decides what to offer. `useRealtime` covers
 * only messages and conversations, so the list refreshes after every
 * action, on a chat switch and when the window regains focus.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Copy, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createClient } from '@/lib/supabase/client';
import {
  decideDraft,
  listDrafts,
  runAgents,
  type DraftDecision,
  type HrAgentDraftRow,
} from '@/lib/hr/agents/api';
import {
  agentKindKey,
  canRunAgents,
  decideErrorKey,
  draftActions,
  draftStatusKey,
  handoffKey,
  intentKey,
  parseSlots,
  REJECT_REASON_MAX,
  runMessage,
} from '@/lib/hr/agents/panel';
import type { DraftStatus } from '@/lib/hr/agents/types';

const PILL =
  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';

const STATUS_PILL: Record<DraftStatus, string> = {
  pending: 'border-warning/40 bg-warning-soft text-warning',
  approved: 'border-success/40 bg-success-soft text-success',
  rejected: 'border-input bg-muted text-muted-foreground',
  expired: 'border-input bg-muted text-muted-foreground',
  superseded: 'border-input bg-muted text-muted-foreground',
};

/** next-intl's `t`, narrowed so the list can render without a provider. */
export type DraftsT = (key: string, values?: Record<string, string>) => string;

export interface HrAgentDraftListProps {
  t: DraftsT;
  drafts: HrAgentDraftRow[];
  canAct: boolean;
  busy: boolean;
  /** The reject reason typed under each draft, by draft id. */
  reasons: Record<string, string>;
  onReasonChange: (draftId: string, reason: string) => void;
  onApprove: (draft: HrAgentDraftRow) => void;
  /** Reject with the reason typed for that draft (may be empty). */
  onReject: (draft: HrAgentDraftRow, reason: string) => void;
  onDismiss: (draft: HrAgentDraftRow) => void;
  onCopy: (body: string) => void;
}

/**
 * The drafts themselves: "<kind> - <intent>" and a status pill, the text,
 * then one action row (Approve, a reason, Reject). No hooks, so it renders
 * in node tests; `draftActions` decides which controls appear.
 */
export function HrAgentDraftList({
  t,
  drafts,
  canAct,
  busy,
  reasons,
  onReasonChange,
  onApprove,
  onReject,
  onDismiss,
  onCopy,
}: HrAgentDraftListProps) {
  if (drafts.length === 0) {
    return <p className="text-muted-foreground text-xs">{t('agents.empty')}</p>;
  }
  return (
    <ul className="marker:text-muted-foreground list-disc space-y-3 pl-5">
      {drafts.map((d) => {
        const a = draftActions(d, canAct);
        const reason = reasons[d.id] ?? '';
        return (
          <li key={d.id} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="text-xs">
                <span className="font-semibold">
                  {t(agentKindKey(d.agent_kind))}
                </span>
                {' - '}
                {t(intentKey(d.intent))}
              </span>
              <span className={`${PILL} ${STATUS_PILL[d.status]}`}>
                {t(draftStatusKey(d.status))}
              </span>
              <span className="text-muted-foreground ml-auto text-xs">
                {formatDistanceToNow(new Date(d.created_at), {
                  addSuffix: true,
                })}
              </span>
            </div>
            {d.body.trim() && (
              <p
                dir="auto"
                className="bg-card-2 rounded-md px-2 py-1.5 text-xs whitespace-pre-wrap"
              >
                {d.body}
              </p>
            )}
            {d.handoff_reason && (
              <span className={`${PILL} border-info/40 bg-info-soft text-info`}>
                {t('agents.handedOff', {
                  reason: t(handoffKey(d.handoff_reason)),
                })}
              </span>
            )}
            {d.requires_template && (
              <p className="text-warning text-xs">
                {t('agents.needsTemplate')}
              </p>
            )}
            {d.status === 'approved' && (
              <p className="text-success text-xs">
                {t('agents.approvedHint')}
              </p>
            )}
            {d.status === 'rejected' && d.reject_reason && (
              <p className="text-muted-foreground text-xs">
                {t('agents.rejectedWith', { reason: d.reject_reason })}
              </p>
            )}
            {(a.approve || a.reject || a.dismiss || a.copy) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {a.approve && (
                  <Button
                    size="xs"
                    variant="outline"
                    data-action="agent-approve"
                    disabled={busy}
                    onClick={() => onApprove(d)}
                  >
                    {t('agents.approve')}
                  </Button>
                )}
                {a.reject && (
                  <>
                    <label
                      htmlFor={`reject-reason-${d.id}`}
                      className="text-muted-foreground text-xs"
                    >
                      {t('agents.rejectReason')}
                    </label>
                    <Input
                      id={`reject-reason-${d.id}`}
                      value={reason}
                      maxLength={REJECT_REASON_MAX}
                      onChange={(e) => onReasonChange(d.id, e.target.value)}
                      className="h-7 w-auto min-w-32 flex-1 text-xs"
                    />
                    <Button
                      size="xs"
                      variant="outline"
                      data-action="agent-reject"
                      disabled={busy}
                      onClick={() => onReject(d, reason)}
                    >
                      {t('agents.reject')}
                    </Button>
                  </>
                )}
                {a.dismiss && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => onDismiss(d)}
                  >
                    {t('agents.dismiss')}
                  </Button>
                )}
                {a.copy && (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onCopy(d.body)}
                  >
                    <Copy aria-hidden />
                    {t('agents.copy')}
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function HrAgentDrafts({
  conversationId,
  canAct,
  closedAt,
}: {
  conversationId: string;
  /** Admin or recruiter team: may draft, approve and reject. */
  canAct: boolean;
  closedAt: string | null;
}) {
  const t = useTranslations('Hr');
  const tr: DraftsT = (key, values) => t(key, values);
  const [drafts, setDrafts] = useState<HrAgentDraftRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slotText, setSlotText] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  // The chat this component is showing; a late answer for another is dropped.
  const current = useRef(conversationId);

  const load = useCallback(
    (id: string) =>
      listDrafts(createClient(), id).then((res) => {
        if (current.current !== id) return;
        if ('error' in res) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setDrafts(res.data);
      }),
    []
  );

  useEffect(() => {
    current.current = conversationId;
    void load(conversationId);
    const onFocus = () => void load(conversationId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [conversationId, load]);

  const parsed = parseSlots(slotText);
  const slotError = 'error' in parsed ? parsed.error : null;

  async function draftReply() {
    if ('error' in parsed) return;
    const id = conversationId;
    setBusy(true);
    const res = await runAgents(id, parsed.slots);
    setBusy(false);
    const m = runMessage(res);
    if (m.tone === 'success') toast.success(t(m.key));
    else if (m.tone === 'info') toast.info(t(m.key));
    else toast.error(t(m.key));
    if ('data' in res) setSlotText('');
    await load(id);
  }

  async function decide(
    draft: HrAgentDraftRow,
    decision: DraftDecision,
    why?: string,
    doneKey?: string
  ): Promise<boolean> {
    const id = conversationId;
    setBusy(true);
    const res = await decideDraft(createClient(), draft.id, decision, why);
    setBusy(false);
    if ('error' in res) toast.error(t(decideErrorKey(res.error)));
    else
      toast.success(
        t(
          doneKey ??
            (decision === 'approve' ? 'agents.approved' : 'agents.rejected')
        )
      );
    await load(id);
    return !('error' in res);
  }

  async function copy(body: string) {
    try {
      await navigator.clipboard.writeText(body);
      toast.success(t('agents.copied'));
    } catch {
      toast.error(t('agents.copyFailed'));
    }
  }

  async function reject(draft: HrAgentDraftRow, reason: string) {
    if (await decide(draft, 'reject', reason)) {
      setReasons((r) => {
        const next = { ...r };
        delete next[draft.id];
        return next;
      });
    }
  }

  return (
    <section className="space-y-2">
      <div>
        <h5 className="text-sm font-semibold">{t('agents.title')}</h5>
        <p className="text-muted-foreground text-xs">{t('agents.note')}</p>
      </div>

      {failed && drafts === null ? (
        <p className="text-muted-foreground text-xs">
          {t('agents.loadFailed')}
        </p>
      ) : drafts === null ? (
        <Loader2
          className="text-muted-foreground size-3.5 animate-spin"
          aria-hidden
        />
      ) : (
        <HrAgentDraftList
          t={tr}
          drafts={drafts}
          canAct={canAct}
          busy={busy}
          reasons={reasons}
          onReasonChange={(draftId, reason) =>
            setReasons((r) => ({ ...r, [draftId]: reason }))
          }
          onApprove={(d) => void decide(d, 'approve')}
          onReject={(d, reason) => void reject(d, reason)}
          onDismiss={(d) =>
            void decide(d, 'reject', undefined, 'agents.dismissed')
          }
          onCopy={(body) => void copy(body)}
        />
      )}

      {canRunAgents(canAct, closedAt) && (
        <div className="space-y-1 pt-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              aria-label={t('agents.slots')}
              placeholder={t('agents.slots')}
              value={slotText}
              onChange={(e) => setSlotText(e.target.value)}
              aria-invalid={slotError !== null}
              className="h-7 w-auto min-w-32 flex-1 text-xs"
            />
            <Button
              size="xs"
              variant="outline"
              data-action="agent-run"
              disabled={busy || slotError !== null}
              onClick={() => void draftReply()}
            >
              {busy ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Sparkles aria-hidden />
              )}
              {t('agents.draft')}
            </Button>
          </div>
          <p
            className={
              slotError
                ? 'text-destructive text-xs'
                : 'text-muted-foreground text-xs'
            }
          >
            {slotError === 'tooMany'
              ? t('agents.slotsTooMany')
              : slotError === 'tooLong'
                ? t('agents.slotsTooLong')
                : slotError === 'sensitive'
                  ? t('agents.slotsSensitive')
                  : t('agents.slotsHint')}
          </p>
        </div>
      )}
    </section>
  );
}
