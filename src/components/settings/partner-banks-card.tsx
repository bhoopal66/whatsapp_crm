'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  PARTNER_BANKS_LIMITS,
  type BankCatalogueEntry,
  type KnowledgeBankMention,
} from '@/lib/typesafe/admin-types';
import {
  addCustomBank,
  effectiveCodes,
  removeCustomBank,
  samePartnerBanks,
  setCode,
  untickedMentions,
  type PartnerBanksDraft,
} from '@/lib/typesafe/partner-banks-draft';

import { SettingsChip } from './settings-chip';

/**
 * Settings → AI safety checks → Partner banks (migration 078): the banks
 * the reply guardrail lets the bot name. Edits stay a local draft until
 * Save, which goes through the panel's version-checked save; a 409
 * comes back as the panel's conflict message, and the draft follows the
 * server whenever the saved list changes underneath it.
 */
export function PartnerBanksCard({
  catalogue,
  saved,
  saving,
  onSave,
}: {
  catalogue: BankCatalogueEntry[];
  saved: PartnerBanksDraft;
  saving: boolean;
  onSave: (value: PartnerBanksDraft) => void;
}) {
  const t = useTranslations('Settings.aiSafety.partners');
  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState(saved);
  // A new saved value (this save, or another admin's seen on a 409)
  // replaces the draft.
  if (!samePartnerBanks(base, saved)) {
    setBase(saved);
    setDraft(saved);
  }
  const [name, setName] = useState('');
  const [others, setOthers] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [mentions, setMentions] = useState<KnowledgeBankMention[]>([]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/typesafe/knowledge-banks', {
          cache: 'no-store',
        });
        const json: unknown = await res.json().catch(() => null);
        const banks = (json as { banks?: unknown } | null)?.banks;
        // A suggestion only: any failure just leaves the row out.
        if (live && res.ok && Array.isArray(banks))
          setMentions(banks as KnowledgeBankMention[]);
      } catch {
        /* no suggestions */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const ticked = new Set(effectiveCodes(draft, catalogue));
  const found = untickedMentions(mentions, draft, catalogue);
  const dirty = !samePartnerBanks(draft, saved);

  const add = () => {
    const r = addCustomBank(draft, catalogue, name, others);
    if (!r.ok) {
      setAddError(
        r.reason === 'duplicate'
          ? t('duplicate', { name: name.trim() })
          : r.reason === 'limit'
            ? t('limit', { max: PARTNER_BANKS_LIMITS.customBanks })
            : null
      );
      return;
    }
    setDraft(r.value);
    setName('');
    setOthers('');
    setAddError(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {draft === null ? t('usingBuiltIn') : t('usingOwn')}
          </p>
          {draft !== null ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              {t('reset')}
            </Button>
          ) : null}
        </div>

        <div className="grid gap-1 sm:grid-cols-2">
          {catalogue.map((b) => (
            <label
              key={b.code}
              className="text-foreground hover:bg-muted flex items-center gap-2 rounded px-1.5 py-1"
            >
              <Checkbox
                checked={ticked.has(b.code)}
                disabled={saving}
                onCheckedChange={(next) =>
                  setDraft(setCode(draft, catalogue, b.code, next === true))
                }
              />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
              {b.defaultPartner ? (
                <SettingsChip className="shrink-0">
                  {t('builtInPartner')}
                </SettingsChip>
              ) : null}
            </label>
          ))}
        </div>

        {draft?.custom.length ? (
          <div className="space-y-1.5">
            <p className="text-foreground font-medium">{t('others')}</p>
            <ul className="space-y-1">
              {draft.custom.map((c) => (
                <li
                  key={c.name}
                  className="border-border flex items-center gap-2 rounded-md border px-2 py-1"
                >
                  <span className="text-foreground min-w-0 flex-1 truncate">
                    {c.name}
                    {c.aliases.length ? (
                      <span className="text-muted-foreground">
                        {' '}
                        ({c.aliases.join(', ')})
                      </span>
                    ) : null}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={saving}
                    aria-label={t('remove', { name: c.name })}
                    onClick={() =>
                      setDraft(removeCustomBank(draft, catalogue, c.name))
                    }
                  >
                    <X className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <p className="text-foreground font-medium">{t('addTitle')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={name}
              maxLength={PARTNER_BANKS_LIMITS.chars}
              placeholder={t('namePlaceholder')}
              aria-label={t('namePlaceholder')}
              disabled={saving}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
            />
            <Input
              value={others}
              placeholder={t('aliasesPlaceholder')}
              aria-label={t('aliasesPlaceholder')}
              disabled={saving}
              onChange={(e) => setOthers(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
            />
            <Button
              variant="outline"
              disabled={saving || !name.trim()}
              onClick={add}
            >
              <Plus className="mr-1 size-4" /> {t('add')}
            </Button>
          </div>
          {addError ? (
            <p className="text-destructive text-xs">{addError}</p>
          ) : null}
        </div>

        {found.length ? (
          <div className="bg-muted/40 border-border space-y-1.5 rounded-md border p-3">
            <p className="text-foreground font-medium">{t('found')}</p>
            <p className="text-muted-foreground text-xs">{t('foundHint')}</p>
            <ul className="space-y-1">
              {found.map((m) => (
                <li key={m.code} className="flex items-center gap-2">
                  <span className="text-foreground min-w-0 flex-1">
                    {t('foundBank', { name: m.name, count: m.documents })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() =>
                      setDraft(setCode(draft, catalogue, m.code, true))
                    }
                  >
                    {t('addFound')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-3">
          {dirty ? (
            <span className="text-muted-foreground text-xs">
              {t('unsaved')}
            </span>
          ) : null}
          <Button disabled={!dirty || saving} onClick={() => onSave(draft)}>
            {saving ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
