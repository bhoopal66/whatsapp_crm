'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { LEAD_SOURCES } from '@/lib/contacts/lead-source';
import {
  hasNarrowing,
  normalizeNarrowing,
} from '@/lib/broadcasts/audience-narrow';
import type { AudienceConfig } from '@/hooks/use-broadcast-sending';

/**
 * Track D U14: "Narrow this audience" — bank and lead-source filters,
 * collapsed by default. (The match-all switch for chat tags sits with
 * the tag picker in step 2.) Not offered for CSV / Compass lists, whose
 * rows are not CRM contacts yet.
 */

interface BankRow {
  code: string;
  name: string | null;
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        selected
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-card text-muted-foreground hover:text-foreground'
      }`}
    >
      {selected && <Check className="h-3 w-3" aria-hidden />}
      {children}
    </button>
  );
}

function toggle(list: readonly string[] | undefined, value: string): string[] {
  const cur = list ?? [];
  return cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
}

export function AudienceNarrowSection({
  audience,
  onUpdate,
}: {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
}) {
  const t = useTranslations('Broadcasts.audienceNarrow');
  const n = normalizeNarrowing(audience);
  const active = hasNarrowing(n);
  const [open, setOpen] = useState(active);
  const [banks, setBanks] = useState<BankRow[]>([]);
  const [banksLoaded, setBanksLoaded] = useState(false);

  useEffect(() => {
    if (!open || banksLoaded) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from('case_banks')
        .select('code, name')
        .order('name');
      if (cancelled) return;
      setBanks((data ?? []) as BankRow[]);
      setBanksLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, banksLoaded]);

  return (
    <div className="border-border bg-card/50 rounded-xl border p-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden />
        )}
        <span className="text-foreground text-sm font-medium">
          {t('title')}
        </span>
        {active && (
          <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium">
            {t('active')}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          <div>
            <p className="text-foreground text-sm font-medium">
              {t('bank.title')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t('bank.help')}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip
                selected={n.bankSource === 'case'}
                onClick={() => onUpdate({ ...audience, bankSource: 'case' })}
              >
                {t('bank.fromCase')}
              </Chip>
              <Chip
                selected={n.bankSource === 'chat_tag'}
                onClick={() =>
                  onUpdate({ ...audience, bankSource: 'chat_tag' })
                }
              >
                {t('bank.fromChatTag')}
              </Chip>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {banksLoaded && banks.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {t('bank.none')}
                </p>
              ) : (
                banks.map((b) => (
                  <Chip
                    key={b.code}
                    selected={n.bankCodes.includes(b.code)}
                    onClick={() =>
                      onUpdate({
                        ...audience,
                        bankCodes: toggle(audience.bankCodes, b.code),
                        bankSource: n.bankSource,
                      })
                    }
                  >
                    {b.name || b.code}
                  </Chip>
                ))
              )}
            </div>
          </div>

          <div>
            <p className="text-foreground text-sm font-medium">
              {t('source.title')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t('source.help')}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {LEAD_SOURCES.map((s) => (
                <Chip
                  key={s}
                  selected={n.leadSources.includes(s)}
                  onClick={() =>
                    onUpdate({
                      ...audience,
                      leadSources: toggle(audience.leadSources, s),
                    })
                  }
                >
                  {t(`source.values.${s}`)}
                </Chip>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
