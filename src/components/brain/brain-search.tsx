'use client';

/**
 * The second brain's Search page (package 022e). Search is read-only;
 * a hit shows its redacted snippet, its source kind, an AI-generated
 * chip and a link to its case, never its score. "Remember this" writes,
 * and the page is agent and up (its layout), so every reader is staff.
 * Only `@/lib/brain/ui` may be imported from here: the rest of lib/brain
 * is server code.
 */

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  BRAIN_QUERY_MAX,
  BRAIN_REMEMBER_MAX,
  type BrainUiHit,
  hitHref,
  isBrainDisabled,
  parseSearchHits,
  queryProblem,
  rememberCaseOptions,
} from '@/lib/brain/ui';

async function post(
  url: string,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

type Saved = 'saved' | 'skipped' | 'refused' | 'failed';

export function BrainSearch({ caseId }: { caseId: string | null }) {
  const t = useTranslations('Brain');
  const [query, setQuery] = useState('');
  const [touched, setTouched] = useState(false);
  const [hits, setHits] = useState<BrainUiHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [text, setText] = useState('');
  const [remCase, setRemCase] = useState(caseId ?? '');
  const [saved, setSaved] = useState<Saved | null>(null);
  const [busy, setBusy] = useState(false);
  const req = useRef(0);
  const problem = queryProblem(query);

  async function search() {
    setTouched(true);
    if (problem !== null) return;
    const id = ++req.current;
    setLoading(true);
    setFailed(false);
    try {
      const answer = await post('/api/brain/search', {
        query: query.trim(),
        ...(caseId ? { caseId } : {}),
      });
      if (id !== req.current) return;
      if (isBrainDisabled(answer.status, answer.body)) {
        setDisabled(true);
        return;
      }
      const parsed =
        answer.status === 200 ? parseSearchHits(answer.body) : null;
      if (parsed === null) setFailed(true);
      else setHits(parsed);
    } catch {
      if (id === req.current) setFailed(true);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }

  async function remember() {
    const body = text.trim();
    if (body === '' || busy) return;
    setBusy(true);
    setSaved(null);
    try {
      const answer = await post('/api/brain/remember', {
        text: body,
        ...(remCase ? { caseId: remCase } : {}),
      });
      if (isBrainDisabled(answer.status, answer.body)) {
        setDisabled(true);
        return;
      }
      if (answer.status === 201) {
        const duplicate =
          (answer.body as { duplicate?: unknown } | null)?.duplicate === true;
        setSaved(duplicate ? 'skipped' : 'saved');
        if (!duplicate) setText('');
      } else if (answer.status === 422) {
        setSaved('refused');
      } else {
        setSaved('failed');
      }
    } catch {
      setSaved('failed');
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div className="space-y-1">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground text-sm">{t('notice')}</p>
    </div>
  );

  if (disabled) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
        {header}
        <Card>
          <CardContent>
            <p className="text-muted-foreground text-sm" role="status">
              {t('disabled')}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const options = rememberCaseOptions(hits ?? [], caseId);
  const optionLabel = (id: string) => {
    if (id === caseId) return t('remember.scopedCase');
    const n = (hits ?? []).findIndex((h) => h.caseId === id) + 1;
    return t('remember.hitCase', { n });
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
      {header}
      {caseId ? (
        <p className="text-sm">
          {t('scope')}{' '}
          <Link href="/brain" className="text-primary underline">
            {t('scopeClear')}
          </Link>
        </p>
      ) : null}

      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Input
          type="search"
          aria-label={t('query')}
          placeholder={t('placeholder')}
          value={query}
          maxLength={BRAIN_QUERY_MAX + 100}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" disabled={loading}>
          <Search className="size-4" aria-hidden />
          {t('search')}
        </Button>
      </form>
      {touched && problem !== null ? (
        <p className="text-destructive text-sm" role="alert">
          {problem === 'short' ? t('tooShort') : t('tooLong')}
        </p>
      ) : null}
      {loading ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t('loading')}
        </p>
      ) : null}
      {!loading && failed ? (
        <p className="text-destructive text-sm" role="alert">
          {t('failed')}
        </p>
      ) : null}
      {!loading && !failed && hits !== null && hits.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : null}
      {!loading && !failed && hits !== null && hits.length > 0 ? (
        <ul className="space-y-2" aria-label={t('results')}>
          {hits.map((h) => {
            const href = hitHref(h);
            return (
              <li key={h.itemId}>
                <Card size="sm">
                  <CardContent className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary">
                          {t(`kind.${h.sourceKind}`)}
                        </Badge>
                        {h.aiGenerated ? (
                          <Badge variant="outline">{t('ai')}</Badge>
                        ) : null}
                      </span>
                      {href !== null ? (
                        <Link href={href} className="text-primary underline">
                          {t('openCase')}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">
                          {t('noCase')}
                        </span>
                      )}
                    </div>
                    <p className="text-sm break-words whitespace-pre-wrap">
                      {h.snippet}
                    </p>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('remember.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void remember();
            }}
          >
            <label className="block space-y-1 text-sm">
              <span>{t('remember.text')}</span>
              <Textarea
                rows={3}
                maxLength={BRAIN_REMEMBER_MAX}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t('remember.case')}</span>
              <select
                className="border-input bg-card dark:bg-input/30 block h-9 w-full rounded-md border px-2 text-sm"
                value={remCase}
                onChange={(e) => setRemCase(e.target.value)}
              >
                <option value="">{t('remember.noCase')}</option>
                {options.map((id) => (
                  <option key={id} value={id}>
                    {optionLabel(id)}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-muted-foreground text-xs">
              {t('remember.hint')}
            </p>
            <Button type="submit" disabled={busy || text.trim() === ''}>
              {busy ? t('remember.saving') : t('remember.save')}
            </Button>
            {saved !== null ? (
              <p
                role="status"
                className={
                  saved === 'saved'
                    ? 'text-success text-sm'
                    : saved === 'skipped'
                      ? 'text-muted-foreground text-sm'
                      : 'text-destructive text-sm'
                }
              >
                {t(`remember.${saved}`)}
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
