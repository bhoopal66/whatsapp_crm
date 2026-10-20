'use client';

// The customer page's Cases card (migration 130): the contact's cases the
// caller may read, and "Open lead". GET/POST /api/cases/leads are agent and
// up, so the page mounts this only for them; the database decides who may
// open a lead for whom (case_open_lead).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';

import { sendCaseRequest } from '@/components/cases/case-page/case-dialogs';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { canLeadTeam, canSendMessages } from '@/lib/auth/roles';
import {
  buildLeadRequest,
  createdLeadId,
  LEAD_CHIP,
  LEAD_PRODUCT_MAX,
  LEAD_SOURCE_MAX,
  leadErrorKey,
  parseContactCases,
  type ContactCase,
} from '@/lib/cases/lead-form';
import { formatAed, parseBanks, type CaseBankOption } from '@/lib/cases/ui';
import { cn } from '@/lib/utils';

import { SideCard } from './customer-cards';

const chip =
  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium';

function useCaseBanks(): CaseBankOption[] | null {
  const [banks, setBanks] = useState<CaseBankOption[] | null>(null);
  useEffect(() => {
    let live = true;
    void fetch('/api/cases/config/banks', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => live && setBanks(parseBanks(j)))
      .catch(() => live && setBanks([]));
    return () => {
      live = false;
    };
  }, []);
  return banks;
}

export function CasesCard({ contactId }: { contactId: string }) {
  const t = useTranslations('CustomerCases');
  const locale = useLocale();
  const banks = useCaseBanks();
  const [cases, setCases] = useState<ContactCase[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch(`/api/cases/leads?contactId=${encodeURIComponent(contactId)}`, {
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) return setFailed(true);
        setCases(parseContactCases(await r.json().catch(() => null)));
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [contactId]);

  const bankName = (code: string | null) =>
    code ? (banks?.find((b) => b.code === code)?.name ?? code) : t('noBank');

  return (
    <SideCard
      title={t('title')}
      action={
        <Button size="xs" variant="outline" onClick={() => setOpening(true)}>
          <Plus className="size-3.5" />
          {t('openLead')}
        </Button>
      }
    >
      {failed ? (
        <p className="text-muted-foreground text-sm">{t('loadFailed')}</p>
      ) : cases === null ? (
        <div className="bg-muted h-10 animate-pulse rounded" aria-hidden />
      ) : cases.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {cases.map((c) => {
            const amount = formatAed(c.amount, locale);
            return (
              <li key={c.id}>
                <Link
                  href={`/cases/${c.id}`}
                  className="hover:bg-muted/60 -mx-2 block space-y-1 rounded-md px-2 py-1.5 text-sm transition-colors"
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className={cn(chip, 'bg-muted text-foreground')}>
                      {c.stage}
                    </span>
                    {c.isLead && (
                      <span className={cn(chip, LEAD_CHIP)}>
                        {t('leadChip')}
                      </span>
                    )}
                    {c.closedAt && (
                      <span
                        className={cn(chip, 'bg-muted text-muted-foreground')}
                      >
                        {t('closed')}
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-medium">
                    {bankName(c.bankCode)}
                    {c.product ? ` · ${c.product}` : ''}
                  </span>
                  {amount && (
                    <span className="text-muted-foreground block text-xs">
                      {amount}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <OpenLeadDialog
        open={opening}
        onOpenChange={setOpening}
        contactId={contactId}
        banks={banks}
      />
    </SideCard>
  );
}

function OpenLeadDialog({
  open,
  onOpenChange,
  contactId,
  banks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  banks: CaseBankOption[] | null;
}) {
  const t = useTranslations('CustomerCases');
  const router = useRouter();
  const { user, accountRole } = useAuth();
  const canPickAgent = !!accountRole && canLeadTeam(accountRole);
  const { members } = useWorkspaceMembers();
  const [bank, setBank] = useState('');
  const [product, setProduct] = useState('');
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState('');
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const me = user?.id ?? '';
  const owner = agentId || me;
  // Staff who can work a customer (agent and up), live, the caller first.
  const agents = members.filter(
    (m) =>
      !m.deactivated_at &&
      !!m.account_role &&
      canSendMessages(m.account_role) &&
      m.user_id !== me
  );
  const nameOf = (id: string) => {
    if (id === me) return t('me');
    const m = members.find((p) => p.user_id === id);
    return m ? m.full_name || m.email : id;
  };
  const bankLabel = (code: string) =>
    banks?.find((b) => b.code === code)?.name ?? code;

  const submit = async () => {
    const built = buildLeadRequest({
      contactId,
      bankCode: bank,
      product,
      amount,
      leadSource: source,
      agentId: owner || null,
      canPickAgent,
    });
    if (!built.ok) return setError(t(`errors.${built.error}`));
    setBusy(true);
    setError(null);
    const r = await sendCaseRequest('/api/cases/leads', 'POST', built.body);
    const id = r.ok ? createdLeadId(r.json) : null;
    if (!id) {
      setBusy(false);
      const code = (r.json as { code?: unknown } | null)?.code;
      return setError(t(`errors.${leadErrorKey(r.status, code)}`));
    }
    router.push(`/cases/${id}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>{t('dialog.body')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="lead-bank">{t('dialog.bank')}</Label>
            <Select
              value={bank}
              onValueChange={(v) => setBank(String(v ?? ''))}
            >
              <SelectTrigger
                id="lead-bank"
                className="w-full"
                disabled={banks === null}
              >
                <SelectValue>
                  {bank ? bankLabel(bank) : t('dialog.pickBank')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(banks ?? []).map((b) => (
                  <SelectItem key={b.code} value={b.code}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {banks !== null && banks.length === 0 && (
              <p className="text-muted-foreground text-xs">
                {t('dialog.noBanks')}
              </p>
            )}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="lead-product">{t('dialog.product')}</Label>
            <Input
              id="lead-product"
              value={product}
              maxLength={LEAD_PRODUCT_MAX}
              onChange={(e) => setProduct(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-amount">{t('dialog.amount')}</Label>
            <Input
              id="lead-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-source">{t('dialog.source')}</Label>
            <Input
              id="lead-source"
              value={source}
              maxLength={LEAD_SOURCE_MAX}
              onChange={(e) => setSource(e.target.value)}
            />
          </div>
          {canPickAgent && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="lead-agent">{t('dialog.agent')}</Label>
              <Select
                value={owner}
                onValueChange={(v) => setAgentId(String(v ?? ''))}
              >
                <SelectTrigger id="lead-agent" className="w-full">
                  <SelectValue>{owner ? nameOf(owner) : ''}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {me && <SelectItem value={me}>{t('me')}</SelectItem>}
                  {agents.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name || m.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('dialog.cancel')}
          </Button>
          <Button
            disabled={busy || !bank || !product.trim()}
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('dialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
