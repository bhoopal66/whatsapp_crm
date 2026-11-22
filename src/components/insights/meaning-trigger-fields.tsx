'use client';

// ============================================================
// The "Customer means…" trigger form, shared by the Flow builder
// (`intent`) and the Automation builder (`intent_match`): description,
// up to five examples, sensitivity, field errors from the same
// validator the save routes run, a warning when the feature is off,
// and "Test a message" (POST /api/insights/meaning-test).
//
// Client-only imports: meaning-config is pure. Never import
// lib/insights/meaning, lib/insights/settings or lib/typesafe here:
// they reach node: modules and break the production client bundle.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, TriangleAlert, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useInsightSettings } from '@/hooks/use-insight-settings';
import {
  MEANING_DESCRIPTION_MAX_CHARS,
  MEANING_DESCRIPTION_MIN_CHARS,
  MEANING_EXAMPLE_MAX_CHARS,
  MEANING_MAX_EXAMPLES,
  validateIntentTriggerConfig,
  type MeaningSensitivity,
} from '@/lib/insights/meaning-config';
import { cn } from '@/lib/utils';

type Config = Record<string, unknown>;

const SENSITIVITIES: MeaningSensitivity[] = ['strict', 'balanced', 'loose'];

/** Only the trigger's own keys, so a config left over from another
 *  trigger type (keywords, match_type) is not saved with it. */
function clean(cfg: Config): Config {
  return {
    description: typeof cfg.description === 'string' ? cfg.description : '',
    examples: Array.isArray(cfg.examples)
      ? cfg.examples.filter((e): e is string => typeof e === 'string')
      : [],
    sensitivity:
      cfg.sensitivity === 'strict' || cfg.sensitivity === 'loose'
        ? cfg.sensitivity
        : 'balanced',
  };
}

type TestResult =
  | { kind: 'verdict'; matches: boolean; percent: number }
  | { kind: 'error'; key: string };

export function MeaningTriggerFields({
  config,
  onChange,
}: {
  config: Config;
  onChange: (next: Config) => void;
}) {
  const t = useTranslations('MeaningTriggers');
  const { settings, available, loading } = useInsightSettings();
  const cfg = clean(config);
  const description = cfg.description as string;
  const examples = cfg.examples as string[];
  const sensitivity = cfg.sensitivity as MeaningSensitivity;

  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const touch = (field: string) =>
    setTouched((s) => (s.has(field) ? s : new Set(s).add(field)));

  // Persist the cleaned shape (and the Balanced default the select shows)
  // once on mount; the builders remount this when the trigger type changes.
  useEffect(() => {
    const c = clean(config);
    if (
      config.sensitivity !== c.sensitivity ||
      Object.keys(config).some((k) => !(k in c))
    ) {
      onChange(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (p: Config) => onChange({ ...cfg, ...p });

  const issues = validateIntentTriggerConfig(cfg);
  const errorFor = (field: string): string | null => {
    if (!touched.has(field)) return null;
    const issue = issues.find((i) => i.field === field);
    if (!issue) return null;
    if (field === 'description')
      return t('descriptionError', {
        min: MEANING_DESCRIPTION_MIN_CHARS,
        max: MEANING_DESCRIPTION_MAX_CHARS,
      });
    if (field === 'examples')
      return t('examplesError', { max: MEANING_MAX_EXAMPLES });
    return t('exampleError', { max: MEANING_EXAMPLE_MAX_CHARS });
  };

  const [sample, setSample] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  async function runTest() {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch('/api/insights/meaning-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          examples,
          sensitivity,
          message: sample,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        p?: number;
        matches?: boolean;
        reason?: string;
      };
      if (res.ok && typeof body.p === 'number') {
        setResult({
          kind: 'verdict',
          matches: body.matches === true,
          percent: Math.round(body.p * 100),
        });
      } else if (res.status === 409) {
        setResult({
          kind: 'error',
          key: body.reason === 'off' ? 'testOff' : 'testUnavailable',
        });
      } else if (res.status === 429) {
        setResult({ kind: 'error', key: 'testRateLimited' });
      } else if (res.status === 400) {
        setResult({ kind: 'error', key: 'testFixConfig' });
      } else {
        setResult({ kind: 'error', key: 'testFailed' });
      }
    } catch {
      setResult({ kind: 'error', key: 'testFailed' });
    } finally {
      setTesting(false);
    }
  }

  const off = !loading && (!settings.meaningTriggersEnabled || !available);
  const configValid = issues.length === 0;
  const descriptionError = errorFor('description');
  const examplesError = errorFor('examples');

  return (
    <div className="space-y-3">
      {off && (
        <p className="bg-warning-soft text-warning flex items-start gap-1.5 rounded-md px-2 py-1.5 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{t('offWarning')}</span>
        </p>
      )}

      <div>
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          {t('descriptionLabel')}
        </label>
        <Textarea
          value={description}
          onChange={(e) => patch({ description: e.target.value })}
          onBlur={() => touch('description')}
          placeholder={t('descriptionPlaceholder')}
          maxLength={MEANING_DESCRIPTION_MAX_CHARS}
          rows={3}
          aria-invalid={descriptionError ? true : undefined}
        />
        <div className="mt-1 flex items-start justify-between gap-2 text-xs">
          <span className="text-destructive">{descriptionError}</span>
          <span className="text-muted-foreground tabular-nums">
            {description.trim().length}/{MEANING_DESCRIPTION_MAX_CHARS}
          </span>
        </div>
      </div>

      <div>
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          {t('examplesLabel')}
        </label>
        <div className="space-y-1.5">
          {examples.map((ex, i) => {
            const err = errorFor(`examples.${i}`);
            return (
              <div key={i}>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={ex}
                    onChange={(e) =>
                      patch({
                        examples: examples.map((x, j) =>
                          j === i ? e.target.value : x
                        ),
                      })
                    }
                    onBlur={() => touch(`examples.${i}`)}
                    placeholder={t('examplePlaceholder')}
                    maxLength={MEANING_EXAMPLE_MAX_CHARS}
                    aria-invalid={err ? true : undefined}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('removeExample')}
                    onClick={() =>
                      patch({ examples: examples.filter((_, j) => j !== i) })
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {err && (
                  <p className="text-destructive mt-0.5 text-xs">{err}</p>
                )}
              </div>
            );
          })}
        </div>
        {examples.length < MEANING_MAX_EXAMPLES && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1.5"
            onClick={() => {
              touch('examples');
              patch({ examples: [...examples, ''] });
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('addExample')}
          </Button>
        )}
        {examplesError && (
          <p className="text-destructive mt-0.5 text-xs">{examplesError}</p>
        )}
      </div>

      <div>
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          {t('sensitivityLabel')}
        </label>
        <select
          value={sensitivity}
          onChange={(e) =>
            patch({ sensitivity: e.target.value as MeaningSensitivity })
          }
          className="border-input bg-card text-foreground dark:bg-input/30 w-full rounded-md border px-2 py-1.5 text-sm focus:outline-none"
        >
          {SENSITIVITIES.map((s) => (
            <option key={s} value={s}>
              {t(`sensitivity.${s}`)}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground mt-1 text-xs">
          {t(`sensitivityHint.${sensitivity}`)}
        </p>
      </div>

      <div className="border-border bg-card-2 rounded-md border p-2.5">
        <div className="text-foreground mb-1.5 text-xs font-medium">
          {t('testTitle')}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={sample}
            onChange={(e) => {
              setSample(e.target.value);
              setResult(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && sample.trim() && configValid) {
                e.preventDefault();
                void runTest();
              }
            }}
            placeholder={t('testPlaceholder')}
            maxLength={1000}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testing || !sample.trim() || !configValid}
            onClick={() => void runTest()}
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('testButton')}
          </Button>
        </div>
        {!configValid && (
          <p className="text-muted-foreground mt-1 text-xs">
            {t('testFixConfig')}
          </p>
        )}
        {result && (
          <p
            role="status"
            className={cn(
              'mt-1.5 text-xs font-medium',
              result.kind === 'verdict' && result.matches && 'text-success',
              result.kind === 'verdict' &&
                !result.matches &&
                'text-muted-foreground',
              result.kind === 'error' && 'text-destructive'
            )}
          >
            {result.kind === 'verdict'
              ? t(result.matches ? 'testMatches' : 'testNoMatch', {
                  percent: result.percent,
                })
              : t(result.key)}
          </p>
        )}
      </div>
    </div>
  );
}
