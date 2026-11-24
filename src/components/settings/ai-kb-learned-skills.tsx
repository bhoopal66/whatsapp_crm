'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  parseSkillList,
  sortSkills,
  type SkillView,
} from '@/lib/kb/skills-view';
import { cn } from '@/lib/utils';

/**
 * "What it has learned" (migration 290 §5): the rules the learner
 * distilled from how admins reviewed its drafts. An admin retires a rule
 * that is wrong (it stops shaping drafts and is never added again) or
 * restores it. Rendered under the switch, for admins only.
 */
export function AiKbLearnedSkills({ accountId }: { accountId: string | null }) {
  const t = useTranslations('KbLearn.skills');
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const loadedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/kb/learn/skills', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (res.ok) setSkills(parseSkillList(data?.skills));
      else toast.error(data?.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedRef.current === accountId) return;
    loadedRef.current = accountId;
    void load();
  }, [accountId, load]);

  const setStatus = async (skill: SkillView, status: SkillView['status']) => {
    setBusy(skill.id);
    try {
      const res = await fetch(`/api/ai/kb/learn/skills/${skill.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? t('saveFailed'));
        return;
      }
      setSkills((list) =>
        sortSkills(list.map((s) => (s.id === skill.id ? { ...s, status } : s)))
      );
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const active = skills.filter((s) => s.status === 'active').length;

  return (
    <details className="group border-border bg-card rounded-md border">
      <summary className="text-foreground flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium select-none">
        <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90 rtl:rotate-180 rtl:group-open:rotate-90" />
        {t('title', { count: active })}
      </summary>
      <div className="space-y-2 border-t px-3 py-3">
        <p className="text-muted-foreground text-xs">{t('description')}</p>
        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" /> {t('loading')}
          </p>
        ) : skills.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('empty')}</p>
        ) : (
          <ul className="divide-border divide-y">
            {skills.map((s) => (
              <li
                key={s.id}
                className={cn(
                  'flex items-start justify-between gap-3 py-2',
                  s.status === 'retired' && 'opacity-60'
                )}
              >
                <div className="min-w-0">
                  <p className="text-foreground text-sm font-medium">
                    <span className="bg-card-2 text-muted-foreground me-2 rounded px-1.5 py-0.5 text-[11px] font-normal">
                      {s.kind === 'category' && s.category
                        ? t('kind.categoryNamed', {
                            category: s.category.replace(/_/g, ' '),
                          })
                        : t(`kind.${s.kind}`)}
                    </span>
                    {s.title}
                  </p>
                  <p className="text-muted-foreground text-xs">{s.principle}</p>
                  {s.whenToApply ? (
                    <p className="text-muted-foreground text-xs italic">
                      {t('when', { when: s.whenToApply })}
                    </p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === s.id}
                  onClick={() =>
                    void setStatus(
                      s,
                      s.status === 'active' ? 'retired' : 'active'
                    )
                  }
                >
                  {s.status === 'active' ? t('retire') : t('restore')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
