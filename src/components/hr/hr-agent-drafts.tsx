'use client';

/**
 * "AI drafts" in the HR panel of a Recruiter chat (package 024a). Drafts
 * only: approving one sends nothing; a recruiter copies it into the chat.
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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

const CHIP =
  'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium';

const STATUS_CHIP: Record<DraftStatus, string> = {
  pending: 'bg-warning-soft text-warning',
  approved: 'bg-success-soft text-success',
  rejected: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
  superseded: 'bg-muted text-muted-foreground',
};

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
  const [drafts, setDrafts] = useState<HrAgentDraftRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slotText, setSlotText] = useState('');
  const [rejecting, setRejecting] = useState<HrAgentDraftRow | null>(null);
  const [reason, setReason] = useState('');
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

  async function confirmReject() {
    if (!rejecting) return;
    if (await decide(rejecting, 'reject', reason)) setRejecting(null);
  }

  return (
    <div className="space-y-2">
      <div>
        <h5 className="text-muted-foreground text-xs font-medium">
          {t('agents.title')}
        </h5>
        <p className="text-muted-foreground text-[11px]">{t('agents.note')}</p>
      </div>

      {canRunAgents(canAct, closedAt) && (
        <div className="space-y-1">
          <Input
            aria-label={t('agents.slots')}
            placeholder={t('agents.slots')}
            value={slotText}
            onChange={(e) => setSlotText(e.target.value)}
            aria-invalid={slotError !== null}
            className="h-7 text-xs"
          />
          <p
            className={
              slotError
                ? 'text-destructive text-[11px]'
                : 'text-muted-foreground text-[11px]'
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
          <Button
            size="xs"
            variant="outline"
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
      )}

      {failed && drafts === null ? (
        <p className="text-muted-foreground text-xs">
          {t('agents.loadFailed')}
        </p>
      ) : drafts === null ? (
        <Loader2
          className="text-muted-foreground size-3.5 animate-spin"
          aria-hidden
        />
      ) : drafts.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('agents.empty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {drafts.map((d) => {
            const a = draftActions(d, canAct);
            return (
              <li key={d.id} className="bg-card-2 space-y-1 rounded-md p-2">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs font-medium">
                    {t(agentKindKey(d.agent_kind))}
                  </span>
                  <span className="text-muted-foreground text-[11px]">
                    · {t(intentKey(d.intent))}
                  </span>
                  <span className={`${CHIP} ${STATUS_CHIP[d.status]} ml-auto`}>
                    {t(draftStatusKey(d.status))}
                  </span>
                </div>
                {d.body.trim() && (
                  <p dir="auto" className="text-xs whitespace-pre-wrap">
                    {d.body}
                  </p>
                )}
                {d.handoff_reason && (
                  <span className={`${CHIP} bg-info-soft text-info`}>
                    {t('agents.handedOff', {
                      reason: t(handoffKey(d.handoff_reason)),
                    })}
                  </span>
                )}
                {d.requires_template && (
                  <p className="text-warning text-[11px]">
                    {t('agents.needsTemplate')}
                  </p>
                )}
                {d.status === 'approved' && (
                  <p className="text-success text-[11px]">
                    {t('agents.approvedHint')}
                  </p>
                )}
                {d.status === 'rejected' && d.reject_reason && (
                  <p className="text-muted-foreground text-[11px]">
                    {t('agents.rejectedWith', { reason: d.reject_reason })}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground mr-auto text-[11px]">
                    {formatDistanceToNow(new Date(d.created_at), {
                      addSuffix: true,
                    })}
                  </span>
                  {a.approve && (
                    <Button
                      size="xs"
                      disabled={busy}
                      onClick={() => void decide(d, 'approve')}
                    >
                      {t('agents.approve')}
                    </Button>
                  )}
                  {a.reject && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setReason('');
                        setRejecting(d);
                      }}
                    >
                      {t('agents.reject')}
                    </Button>
                  )}
                  {a.dismiss && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void decide(d, 'reject', undefined, 'agents.dismissed')
                      }
                    >
                      {t('agents.dismiss')}
                    </Button>
                  )}
                  {a.copy && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void copy(d.body)}
                    >
                      <Copy aria-hidden />
                      {t('agents.copy')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={rejecting !== null}
        onOpenChange={(o) => !o && setRejecting(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('agents.rejectTitle')}</DialogTitle>
            <DialogDescription>{t('agents.rejectHint')}</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={t('agents.rejectReason')}
            placeholder={t('agents.rejectReason')}
            value={reason}
            maxLength={REJECT_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              {t('panel.cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void confirmReject()}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {t('agents.reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
