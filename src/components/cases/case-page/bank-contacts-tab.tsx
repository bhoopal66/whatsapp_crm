'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Lock, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  fromLocalInput,
  toLocalInput,
  type CaseTabProps,
} from '@/lib/cases/case-page';
import { toolErrorKey } from '@/lib/cases/case-tools-ui';

import { sendCaseRequest } from './case-dialogs';
import {
  asList,
  asObj,
  asStr,
  TabStatus,
  useCaseResource,
  useWhen,
} from './tab-kit';

const NAME_MAX = 200;
const TEXT_MAX = 4000;

interface BankContact {
  id: string;
  contactName: string;
  contactedAt: string;
  summary: string;
  nextAction: string | null;
  nextActionAt: string | null;
  authorId: string | null;
  createdAt: string;
}

function parse(json: unknown): BankContact[] {
  return asList(asObj(json)?.contacts)
    .flatMap((v) => {
      const r = asObj(v);
      const id = asStr(r?.id);
      const contactName = asStr(r?.contactName);
      const summary = asStr(r?.summary);
      if (!r || !id || contactName === null || summary === null) return [];
      return [
        {
          id,
          contactName,
          contactedAt: asStr(r.contactedAt) ?? '',
          summary,
          nextAction: asStr(r.nextAction),
          nextActionAt: asStr(r.nextActionAt),
          authorId: asStr(r.authorId),
          createdAt: asStr(r.createdAt) ?? '',
        },
      ];
    })
    .sort((a, b) => b.contactedAt.localeCompare(a.contactedAt));
}

/** The bank contact log, newest first, with "Log a contact" and "Bank responded". */
export function BankContactsTab({ caseId, detail, onChanged }: CaseTabProps) {
  const t = useTranslations('CasePage');
  const when = useWhen();
  const { nameOf } = useWorkspaceMembers();
  const { data, failed, reload } = useCaseResource(
    `/api/cases/${caseId}/bank-contacts`,
    parse
  );
  const [defaultWhen, setDefaultWhen] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);

  const closed = detail.case.closedAt !== null;
  const canAct = detail.permissions.canWrite && !closed;
  const gate = !detail.permissions.canWrite
    ? t('gate.write')
    : closed
      ? t('gate.closed')
      : undefined;

  const respond = async () => {
    setResponding(true);
    const r = await sendCaseRequest(`/api/cases/${caseId}/sla`, 'POST', {
      event: 'bank_response',
    });
    setResponding(false);
    if (!r.ok) {
      const code = (r.json as { code?: unknown } | null)?.code;
      toast.error(t(toolErrorKey(r.status, code)));
      return;
    }
    toast.success(t('bankContacts.responded'));
    onChanged();
  };

  return (
    <section className="bg-card space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('bankContacts.title')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <GatedButton
            size="sm"
            variant="outline"
            disabled={!canAct || responding}
            title={gate ?? t('bankContacts.bankRespondedHint')}
            onClick={() => void respond()}
          >
            {responding && <Loader2 className="size-4 animate-spin" />}
            {t('bankContacts.bankResponded')}
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline"
            disabled={!canAct}
            title={gate}
            onClick={() =>
              setDefaultWhen(toLocalInput(new Date().toISOString()))
            }
          >
            <Plus className="size-4" aria-hidden />
            {t('bankContacts.add')}
          </GatedButton>
        </div>
      </div>
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Lock className="size-3.5 shrink-0" aria-hidden />
        {t('bankContacts.internal')}
      </p>

      {!data ? (
        <TabStatus
          failed={failed}
          loading={t('bankContacts.loading')}
          error={t('bankContacts.loadFailed')}
          onRetry={() => void reload()}
        />
      ) : data.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('bankContacts.empty')}
        </p>
      ) : (
        <ul className="divide-y">
          {data.map((c) => {
            const nextAt = when(c.nextActionAt);
            return (
              <li key={c.id} className="space-y-1 py-2">
                <p className="text-sm font-medium">{c.contactName}</p>
                <p className="text-muted-foreground text-xs">
                  {t('bankContacts.contactedAt', {
                    when: when(c.contactedAt) ?? '—',
                  })}
                  {' · '}
                  {t('bankContacts.by', {
                    name: c.authorId
                      ? (nameOf(c.authorId) ?? t('unknownPerson'))
                      : t('system'),
                  })}
                </p>
                <p className="text-sm break-words whitespace-pre-wrap">
                  {c.summary}
                </p>
                {c.nextAction && (
                  <p className="text-muted-foreground text-xs break-words">
                    {nextAt
                      ? t('bankContacts.nextAt', {
                          action: c.nextAction,
                          when: nextAt,
                        })
                      : t('bankContacts.next', { action: c.nextAction })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {defaultWhen !== null && (
        <LogContactDialog
          caseId={caseId}
          initialWhen={defaultWhen}
          onClose={() => setDefaultWhen(null)}
          onSaved={() => void reload()}
        />
      )}
    </section>
  );
}

function LogContactDialog({
  caseId,
  initialWhen,
  onClose,
  onSaved,
}: {
  caseId: string;
  initialWhen: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('CasePage');
  const [name, setName] = useState('');
  const [at, setAt] = useState(initialWhen);
  const [summary, setSummary] = useState('');
  const [next, setNext] = useState('');
  const [nextAt, setNextAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const cleanName = name.trim();
    const cleanSummary = summary.trim();
    const atIso = fromLocalInput(at);
    if (!cleanName || !cleanSummary || !atIso)
      return setError(t('bankContacts.required'));
    const nextIso = fromLocalInput(nextAt);
    if (
      cleanName.length > NAME_MAX ||
      cleanSummary.length > TEXT_MAX ||
      next.trim().length > TEXT_MAX
    )
      return setError(t('bankContacts.errors.tooLong'));
    setBusy(true);
    setError(null);
    const r = await sendCaseRequest(
      `/api/cases/${caseId}/bank-contacts`,
      'POST',
      {
        contact_name: cleanName,
        contacted_at: atIso,
        summary: cleanSummary,
        ...(next.trim() ? { next_action: next.trim() } : {}),
        ...(nextIso ? { next_action_at: nextIso } : {}),
      }
    );
    setBusy(false);
    if (!r.ok) {
      const code = (r.json as { code?: unknown } | null)?.code;
      return setError(t(toolErrorKey(r.status, code)));
    }
    toast.success(t('bankContacts.saved'));
    onSaved();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !busy && !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('bankContacts.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('bankContacts.dialogBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bank-contact-name">{t('bankContacts.name')}</Label>
            <Input
              id="bank-contact-name"
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bank-contact-when">{t('bankContacts.when')}</Label>
            <Input
              id="bank-contact-when"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bank-contact-summary">
              {t('bankContacts.summary')}
            </Label>
            <Textarea
              id="bank-contact-summary"
              rows={4}
              value={summary}
              maxLength={TEXT_MAX}
              onChange={(e) => setSummary(e.target.value)}
            />
            <p className="text-muted-foreground text-right text-xs tabular-nums">
              {t('notes.count', { count: summary.length, max: TEXT_MAX })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bank-contact-next">
              {t('bankContacts.nextAction')}
            </Label>
            <Textarea
              id="bank-contact-next"
              rows={2}
              value={next}
              maxLength={TEXT_MAX}
              onChange={(e) => setNext(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bank-contact-next-at">
              {t('bankContacts.nextActionAt')}
            </Label>
            <Input
              id="bank-contact-next-at"
              type="datetime-local"
              value={nextAt}
              onChange={(e) => setNextAt(e.target.value)}
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('bankContacts.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
