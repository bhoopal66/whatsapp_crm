'use client';

import { useState } from 'react';
import { Languages } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import {
  isLocale,
  LOCALE_NAMES,
  LOCALES,
  workspaceDefaultLocale,
  type Locale,
} from '@/i18n/locales';

/** The picker's value for "no choice: follow the workspace". */
const WORKSPACE_DEFAULT = 'default';

/**
 * Settings → Appearance: the person's interface language (migration
 * 259). Unlike mode and accent it is saved to the profile, so it follows
 * them to every device; PUT /api/profile/language also sets this
 * device's cookie, and the page reloads to render in the new language
 * (direction included: Arabic is right to left).
 */
export function LanguagePicker() {
  const t = useTranslations('Settings.appearance');
  const { profile } = useAuth();
  const saved = profile?.preferred_language ?? null;
  const [saving, setSaving] = useState(false);
  const workspaceDefault = workspaceDefaultLocale();
  const value = saved ?? WORKSPACE_DEFAULT;

  const label = (v: string) =>
    isLocale(v)
      ? LOCALE_NAMES[v]
      : t('languageDefault', { language: LOCALE_NAMES[workspaceDefault] });

  async function choose(next: string) {
    if (next === value || saving) return;
    const locale: Locale | null = isLocale(next) ? next : null;
    setSaving(true);
    try {
      const res = await fetch('/api/profile/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Every server-rendered string, and <html dir>, comes from the
      // request's locale: a full reload renders them all in the new one.
      window.location.reload();
    } catch {
      toast.error(t('languageFailed'));
      setSaving(false);
    }
  }

  return (
    <div className="mt-8 space-y-4">
      <h3
        id="appearance-language-label"
        className="text-foreground flex items-center gap-2 text-sm font-semibold"
      >
        <Languages className="text-muted-foreground size-4" />
        {t('language')}
      </h3>
      <p className="text-muted-foreground text-sm">
        {t('languageDescription')}
      </p>
      <Select
        value={value}
        onValueChange={(v) => void choose(String(v))}
        disabled={!profile || saving}
      >
        <SelectTrigger
          aria-labelledby="appearance-language-label"
          className="w-full sm:max-w-xs"
        >
          {/* Base UI's SelectValue renders the raw value unless given
            children. */}
          <SelectValue>{label(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={WORKSPACE_DEFAULT}>
            {label(WORKSPACE_DEFAULT)}
          </SelectItem>
          {LOCALES.map((l) => (
            <SelectItem key={l} value={l}>
              {/* Each name in its own script and direction. */}
              <span lang={l} dir="auto">
                {LOCALE_NAMES[l]}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
