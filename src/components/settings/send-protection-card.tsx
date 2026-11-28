'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import {
  knownReason,
  microsToUnits,
  parseCountCap,
  unitsToMicros,
  type DecisionRow,
} from '@/lib/whatsapp/meta-health/protection';

/**
 * Number protection (188's enforce switch and count cap, 334's spend
 * caps and decision log), under the Meta number health card. Owners and
 * admins see it, like the tables' RLS; only the owner flips enforce
 * (the route and 188's setter refuse anyone else).
 */

export interface ProtectionData {
  enforce: boolean;
  can_set_enforce: boolean;
  daily_marketing_cap: number | null;
  marketing_spend_micros: number | null;
  ai_spend_micros: number | null;
  decisions: DecisionRow[];
}

export interface LimitsForm {
  count: string;
  marketingSpend: string;
  aiSpend: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'invalid';

const CHECKS = [
  'optOut',
  'block',
  'paused',
  'template',
  'suppression',
  'ramp',
  'spend',
] as const;

export function SendProtectionView({
  data,
  currency,
  form,
  saveState,
  enforceBusy,
  onEnforce,
  onForm,
  onSave,
}: {
  data: ProtectionData;
  currency: string;
  form: LimitsForm;
  saveState: SaveState;
  enforceBusy: boolean;
  onEnforce: (on: boolean) => void;
  onForm: (form: LimitsForm) => void;
  onSave: () => void;
}) {
  const t = useTranslations('Settings.sendProtection');
  const format = useFormatter();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <>
      <section className="bg-card-2 space-y-3 rounded-lg p-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="send-protection-enforce" className="font-medium">
            {t('enforceLabel')}
          </Label>
          <Switch
            id="send-protection-enforce"
            checked={data.enforce}
            disabled={!data.can_set_enforce || enforceBusy}
            onCheckedChange={(on) => onEnforce(on)}
          />
        </div>
        <p
          className={`text-sm ${data.enforce ? 'text-success' : 'text-muted-foreground'}`}
        >
          {data.enforce ? t('enforceOn') : t('enforceOff')}
        </p>
        {!data.can_set_enforce && (
          <p className="text-muted-foreground text-xs">{t('ownerOnly')}</p>
        )}
        <div className="bg-warning-soft text-warning space-y-1 rounded-md p-3 text-sm">
          <p>{t('warning')}</p>
          <ul className="list-disc space-y-0.5 ps-5">
            {CHECKS.map((c) => (
              <li key={c}>{t(`checks.${c}`)}</li>
            ))}
          </ul>
          <p>{t('otherProviders')}</p>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('limits')}</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="send-protection-count">{t('marketingCap')}</Label>
            <Input
              id="send-protection-count"
              inputMode="numeric"
              value={form.count}
              onChange={(e) => onForm({ ...form, count: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              {t('marketingCapHint')}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="send-protection-marketing-spend">
              {t('marketingSpend', { currency })}
            </Label>
            <Input
              id="send-protection-marketing-spend"
              inputMode="decimal"
              value={form.marketingSpend}
              onChange={(e) =>
                onForm({ ...form, marketingSpend: e.target.value })
              }
            />
            <p className="text-muted-foreground text-xs">{t('noCapHint')}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="send-protection-ai-spend">
              {t('aiSpend', { currency })}
            </Label>
            <Input
              id="send-protection-ai-spend"
              inputMode="decimal"
              value={form.aiSpend}
              onChange={(e) => onForm({ ...form, aiSpend: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">{t('noCapHint')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={onSave} disabled={saveState === 'saving'}>
            {saveState === 'saving' ? t('saving') : t('save')}
          </Button>
          {saveState === 'saved' && (
            <span className="text-success text-sm">{t('saved')}</span>
          )}
          {saveState === 'failed' && (
            <span className="text-destructive text-sm">{t('saveFailed')}</span>
          )}
          {saveState === 'invalid' && (
            <span className="text-destructive text-sm">{t('invalid')}</span>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('decisions')}</h3>
        {data.decisions.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noDecisions')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colTime')}</TableHead>
                <TableHead>{t('colDecision')}</TableHead>
                <TableHead>{t('colReason')}</TableHead>
                <TableHead>{t('colTemplate')}</TableHead>
                <TableHead>{t('colMode')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.decisions.map((d) => {
                const reason = knownReason(d.reason);
                return (
                  <TableRow key={d.id}>
                    <TableCell>{when(d.at)}</TableCell>
                    <TableCell
                      className={
                        d.decision === 'ALLOW'
                          ? 'text-success'
                          : d.decision === 'DENY'
                            ? 'text-destructive'
                            : 'text-warning'
                      }
                    >
                      {t(`decision.${d.decision}`)}
                    </TableCell>
                    <TableCell>
                      {reason
                        ? t(`reasons.${reason}`)
                        : t('unknownReason', { code: d.reason })}
                    </TableCell>
                    <TableCell>{d.template ?? '—'}</TableCell>
                    <TableCell>
                      {d.enforced ? t('enforced') : t('watched')}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}

function formFrom(d: ProtectionData): LimitsForm {
  return {
    count: d.daily_marketing_cap === null ? '' : String(d.daily_marketing_cap),
    marketingSpend: microsToUnits(d.marketing_spend_micros),
    aiSpend: microsToUnits(d.ai_spend_micros),
  };
}

export function SendProtectionCard() {
  const canView = useCan('edit-settings');
  const { account } = useAuth();
  const t = useTranslations('Settings.sendProtection');
  const [data, setData] = useState<ProtectionData | null>(null);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<LimitsForm>({
    count: '',
    marketingSpend: '',
    aiSpend: '',
  });
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [enforceBusy, setEnforceBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/whatsapp/meta/protection');
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as ProtectionData;
  }, []);

  useEffect(() => {
    if (!canView) return;
    let live = true;
    load()
      .then((body) => {
        if (!live) return;
        setData(body);
        setForm(formFrom(body));
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [canView, load]);

  if (!canView) return null;

  const patch = (body: unknown) =>
    fetch('/api/whatsapp/meta/protection', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const onEnforce = async (on: boolean) => {
    if (!data?.can_set_enforce) return;
    setEnforceBusy(true);
    try {
      const res = await patch({ enforce: on });
      if (res.ok) setData({ ...data, enforce: on });
    } finally {
      setEnforceBusy(false);
    }
  };

  const onSave = async () => {
    const count = parseCountCap(form.count);
    const marketing = unitsToMicros(form.marketingSpend);
    const ai = unitsToMicros(form.aiSpend);
    if (!count.ok || !marketing.ok || !ai.ok) {
      setSaveState('invalid');
      return;
    }
    setSaveState('saving');
    try {
      const res = await patch({
        limits: {
          daily_marketing_cap: count.cap,
          marketing_spend_micros: marketing.micros,
          ai_spend_micros: ai.micros,
        },
      });
      setSaveState(res.ok ? 'saved' : 'failed');
    } catch {
      setSaveState('failed');
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <ShieldCheck className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {failed ? (
          <p className="text-destructive text-sm">{t('loadFailed')}</p>
        ) : !data ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </div>
        ) : (
          <SendProtectionView
            data={data}
            currency={account?.default_currency ?? 'USD'}
            form={form}
            saveState={saveState}
            enforceBusy={enforceBusy}
            onEnforce={onEnforce}
            onForm={(f) => {
              setForm(f);
              setSaveState('idle');
            }}
            onSave={onSave}
          />
        )}
      </CardContent>
    </Card>
  );
}
