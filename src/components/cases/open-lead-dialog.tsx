'use client';

// The "Open lead" dialog (migration 130), shared by the customer page's Cases
// card (fixed customer) and the Cases page's "New lead" button (a customer
// picker, searched on the caller's own client so RLS decides who they find).
// The database decides who may open a lead for whom (case_open_lead).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { sendCaseRequest } from '@/components/cases/case-page/case-dialogs';
import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { ContactPicker } from '@/components/pipelines/contact-picker';
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
  LEAD_PRODUCT_MAX,
  LEAD_SOURCE_MAX,
  leadErrorKey,
} from '@/lib/cases/lead-form';
import type { CaseBankOption } from '@/lib/cases/ui';
import type { ContactOption } from '@/lib/contacts/search';

export function OpenLeadDialog({
  open,
  onOpenChange,
  contactId: fixedContactId,
  banks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fixed customer (the customer page); omit to pick one. */
  contactId?: string;
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
  const [customer, setCustomer] = useState<ContactOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contactId = fixedContactId ?? customer?.id ?? '';
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
    if (!contactId) return setError(t('errors.customerRequired'));
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
          {!fixedContactId && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('dialog.customer')}</Label>
              <ContactPicker
                selected={customer}
                onChange={setCustomer}
                placeholder={t('dialog.pickCustomer')}
              />
            </div>
          )}
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
            disabled={busy || !contactId || !bank || !product.trim()}
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
