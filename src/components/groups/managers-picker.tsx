'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Staff multi-select shared by the create wizard and the Managers tab. */
export function ManagersPicker({
  staff,
  selected,
  onChange,
}: {
  staff: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useTranslations('Groups.create');
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const shown = staff.filter((p) => !q || p.name.toLowerCase().includes(q));
  return (
    <div className="space-y-1.5">
      <Label htmlFor="group-manager-search">{t('managers')}</Label>
      <p className="text-muted-foreground text-xs">{t('managersHint')}</p>
      <Input
        id="group-manager-search"
        type="search"
        value={search}
        placeholder={t('managersSearch')}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="border-border max-h-40 overflow-y-auto rounded-lg border">
        {shown.length === 0 ? (
          <li className="text-muted-foreground px-3 py-2 text-xs">
            {t('managersNone')}
          </li>
        ) : (
          shown.map((p) => (
            <li key={p.id}>
              <label className="hover:bg-muted flex cursor-pointer items-center gap-2 px-3 py-1.5">
                <Checkbox
                  checked={selected.includes(p.id)}
                  onCheckedChange={(v) =>
                    onChange(
                      v
                        ? [...selected, p.id]
                        : selected.filter((id) => id !== p.id)
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </label>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
