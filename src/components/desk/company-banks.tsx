'use client';

/**
 * A company's banks and documents (migration 231, design 035 D5/D11/
 * D13): every case with its stage, the reuse consent per bank, and the
 * files of the cases the viewer can open, each linkable into another of
 * the company's cases. Linking never copies: the other case gets its own
 * row with its own status.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { DeskCompany } from '@/lib/desk/companies';
import {
  linkTargets,
  type ApplicationChecklist,
  type CompanyOverview,
  type OverviewFile,
} from '@/lib/desk/shared-docs';

import { deskApi } from './desk-api';
import { NATIVE_FIELD } from './tag-fields';

export function CompanyBanks({ company }: { company: DeskCompany }) {
  const t = useTranslations('Desk');
  const [o, setO] = useState<CompanyOverview | null>(null);
  const [list, setList] = useState<ApplicationChecklist | null>(null);
  const load = useCallback(
    () =>
      Promise.all([
        deskApi.companyOverview(company.customerId),
        deskApi.checklist(company.customerId),
      ]).then(([r, c]) => {
        if (r.ok) setO(r.data);
        else toast.error(r.error);
        if (c.ok) setList(c.data);
      }),
    [company.customerId]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const banks = useMemo(
    () => [...new Set((o?.cases ?? []).map((c) => c.bankCode))].sort(),
    [o]
  );
  if (!o) return null;
  const caseNumber = (id: string) =>
    o.cases.find((c) => c.caseId === id)?.caseNumber ?? id;

  return (
    <Card>
      <CardContent className="space-y-4 text-sm">
        <div>
          <h2 className="text-foreground text-base font-semibold">
            {t('banks.title')}
          </h2>
          <p className="text-muted-foreground">{t('banks.intro')}</p>
        </div>
        {o.cases.length === 0 && (
          <p className="text-muted-foreground">{t('banks.noCases')}</p>
        )}
        <ul className="divide-border divide-y rounded-md border">
          {o.cases.map((c) => (
            <li
              key={c.caseId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
            >
              <span className="font-mono text-xs">{c.caseNumber}</span>
              <span className="text-foreground">{c.bankCode}</span>
              {c.product && (
                <span className="text-muted-foreground text-xs">
                  {c.product}
                </span>
              )}
              <span className="text-muted-foreground ml-auto text-xs">
                {c.closed
                  ? t('banks.closed')
                  : t('banks.stage', { stage: c.stage })}
              </span>
            </li>
          ))}
        </ul>

        {banks.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">
              {t('banks.consents')}
            </h3>
            {banks.map((b) => (
              <ConsentRow
                key={b}
                bank={b}
                company={company}
                overview={o}
                onChanged={load}
              />
            ))}
          </div>
        )}

        {list && list.items.length > 0 && <Checklist list={list} />}

        {o.files.length === 0 ? (
          <p className="text-muted-foreground">{t('banks.noFiles')}</p>
        ) : (
          [...new Set(o.files.map((f) => f.caseId))].map((caseId) => (
            <div key={caseId} className="space-y-2">
              <h3 className="text-foreground font-medium">
                {t('banks.files', { caseNumber: caseNumber(caseId) })}
              </h3>
              <ul className="divide-border divide-y rounded-md border">
                {o.files
                  .filter((f) => f.caseId === caseId)
                  .map((f) => (
                    <FileRow
                      key={f.fileId}
                      file={f}
                      overview={o}
                      onLinked={load}
                    />
                  ))}
              </ul>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ConsentRow({
  bank,
  company,
  overview,
  onChanged,
}: {
  bank: string;
  company: DeskCompany;
  overview: CompanyOverview;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations('Desk');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const live = overview.consents.find(
    (c) => c.bankCode === bank && !c.revokedAt
  );
  const act = async () => {
    setBusy(true);
    const r = live
      ? await deskApi.revokeConsent(company.customerId, bank, text)
      : await deskApi.grantConsent(company.customerId, bank, text);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(t('banks.saved'));
    setText('');
    await onChanged();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 font-medium">{bank}</span>
      <span className="text-muted-foreground min-w-0 flex-1 text-xs break-words">
        {live
          ? t('banks.consented', {
              date: live.grantedAt.slice(0, 10),
              evidence: live.evidence,
            })
          : t('banks.noConsent')}
      </span>
      {company.canManage && (
        <span className="flex flex-wrap items-center gap-2">
          <Input
            className="w-56"
            value={text}
            maxLength={500}
            placeholder={live ? t('banks.revokeReason') : t('banks.evidence')}
            aria-label={live ? t('banks.revokeReason') : t('banks.evidence')}
            onChange={(e) => setText(e.target.value)}
          />
          <Button
            size="sm"
            variant={live ? 'ghost' : 'outline'}
            disabled={busy || text.trim().length < 3}
            onClick={act}
          >
            {live ? t('banks.revoke') : t('banks.record')}
          </Button>
        </span>
      )}
    </div>
  );
}

function FileRow({
  file,
  overview,
  onLinked,
}: {
  file: OverviewFile;
  overview: CompanyOverview;
  onLinked: () => Promise<unknown>;
}) {
  const t = useTranslations('Desk');
  const targets = linkTargets(overview, file);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const link = async () => {
    const picked = targets.find((x) => x.target.caseId === target);
    if (!picked) return;
    setBusy(true);
    const r = await deskApi.linkDocument(file.fileId, picked.target.caseId);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    const n = picked.target.caseNumber ?? picked.target.caseId;
    toast.success(
      r.data.created
        ? t('banks.linked', { caseNumber: n })
        : t('banks.alreadyLinked', { caseNumber: n })
    );
    setTarget('');
    await onLinked();
  };
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="text-foreground min-w-0 break-words">
        {file.originalName ?? file.docKey ?? file.fileId}
      </span>
      {file.docKey && (
        <span className="text-muted-foreground font-mono text-xs">
          {file.docKey}
        </span>
      )}
      <Badge variant="outline">{file.status}</Badge>
      {file.shared && <Badge variant="secondary">{t('banks.shared')}</Badge>}
      {targets.length > 0 && (
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <select
            className={`${NATIVE_FIELD} w-auto`}
            value={target}
            aria-label={t('banks.linkTo')}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">{t('banks.linkTo')}</option>
            {targets.map(({ target: c, needsConsent }) => (
              <option key={c.caseId} value={c.caseId} disabled={needsConsent}>
                {needsConsent
                  ? t('banks.needsConsent', {
                      caseNumber: c.caseNumber ?? c.caseId,
                    })
                  : (c.caseNumber ?? c.caseId)}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !target}
            onClick={link}
          >
            {t('banks.link')}
          </Button>
        </span>
      )}
    </li>
  );
}

const CELL_CLASS: Record<string, string> = {
  passed: 'text-success',
  failed: 'text-destructive',
  missing: 'text-warning',
};

function Checklist({ list }: { list: ApplicationChecklist }) {
  const t = useTranslations('Desk');
  const status = (s: string) =>
    [
      'missing',
      'unclassified',
      'pending_checks',
      'passed',
      'failed',
      'superseded',
    ].includes(s)
      ? t(`banks.statuses.${s}`)
      : s;
  return (
    <div className="space-y-2">
      <h3 className="text-foreground font-medium">{t('banks.checklist')}</h3>
      <p className="text-muted-foreground text-xs">
        {t('banks.checklistIntro')}
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-left text-xs">
          <thead className="bg-card-2">
            <tr>
              <th className="px-3 py-2 font-medium">{t('banks.document')}</th>
              {list.cases.map((c) => (
                <th
                  key={c.caseId}
                  className="px-3 py-2 font-medium whitespace-nowrap"
                >
                  {c.bankCode}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {list.items.map((i) => (
              <tr key={i.docKey}>
                <td className="px-3 py-2">
                  <span className="text-foreground">
                    {i.label ?? i.docKey.replace(/_/g, ' ')}
                  </span>
                  {i.minValidDays !== null && (
                    <span className="text-muted-foreground block">
                      {t('banks.validDays', { days: i.minValidDays })}
                    </span>
                  )}
                </td>
                {list.cases.map((c) => {
                  const cell = i.cells[c.caseId];
                  return (
                    <td key={c.caseId} className="px-3 py-2 whitespace-nowrap">
                      {cell ? (
                        <span
                          className={
                            CELL_CLASS[cell.status] ?? 'text-foreground'
                          }
                        >
                          {status(cell.status)}
                          {cell.expiresOn ? ` · ${cell.expiresOn}` : ''}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {t('banks.notNeeded')}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
