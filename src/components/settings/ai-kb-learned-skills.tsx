'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronRight, Loader2 } from 'lucide-react';
import { ErrorState } from '@/components/dashboard/error-state';
import { Button } from '@/components/ui/button';
import {
  parseSkillList,
  skillSaveFailureKey,
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
  // A failed read is its own state: never drawn as an empty list.
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const loadedRef = useRef<string | null>(null);
  // Bumped by every read and every saved change: an older read answering
  // late (or after a change was saved) must not overwrite what is newer.
  const seqRef = useRef(0);
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setState('loading');
    let next: SkillView[] | null = null;
    try {
      const res = await fetch('/api/ai/kb/learn/skills', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (res.ok && Array.isArray(data?.skills))
        next = parseSkillList(data.skills);
    } catch {
      next = null;
    }
    if (seq !== seqRef.current) return;
    if (next) {
      setSkills(next);
      setState('ready');
    } else setState('failed');
  }, []);

  useEffect(() => {
    if (!accountId || loadedRef.current === accountId) return;
    loadedRef.current = accountId;
    setSkills([]);
    void load();
  }, [accountId, load]);

  const setStatus = async (skill: SkillView, status: SkillView['status']) => {
    // A ref, not `busy`: a second click can land before the re-render.
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(skill.id);
    let failedStatus: number | null = null;
    try {
      const res = await fetch(`/api/ai/kb/learn/skills/${skill.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        seqRef.current++;
        setSkills((list) =>
          sortSkills(
            list.map((s) => (s.id === skill.id ? { ...s, status } : s))
          )
        );
        return;
      }
      failedStatus = res.status;
    } catch {
      failedStatus = null;
    } finally {
      savingRef.current = false;
      setBusy(null);
    }
    // The list stays as it was; the reason is said.
    toast.error(t(skillSaveFailureKey(failedStatus)));
    if (failedStatus === 404) void load();
  };

  const active = skills.filter((s) => s.status === 'active').length;

  return (
    <details className="group border-border bg-card rounded-md border">
      <summary className="text-foreground flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-start text-sm font-medium select-none">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90 rtl:rotate-180 rtl:group-open:rotate-90" />
        {state === 'ready' ? t('title', { count: active }) : t('titlePlain')}
      </summary>
      <div className="border-border space-y-2 border-t px-3 py-3">
        <p className="text-muted-foreground text-start text-xs">
          {t('description')}
        </p>
        {state === 'loading' ? (
          <p
            role="status"
            className="text-muted-foreground flex items-center gap-2 text-xs"
          >
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />{' '}
            {t('loading')}
          </p>
        ) : state === 'failed' ? (
          <ErrorState message={t('loadFailed')} onRetry={() => void load()} />
        ) : skills.length === 0 ? (
          <p className="text-muted-foreground text-start text-xs">
            {t('empty')}
          </p>
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
                <div className="min-w-0 flex-1 text-start break-words">
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
                  className="shrink-0"
                  disabled={busy !== null}
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
