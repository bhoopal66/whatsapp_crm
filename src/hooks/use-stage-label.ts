'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

import { stageLabel } from '@/lib/i18n/stage-label';

/**
 * `stageLabel` bound to the person's catalogue: a built-in stage name in
 * their language, any other name as typed. For display only; the stored
 * name is what goes to the API, filters and exports.
 */
export function useStageLabel(): (name: string) => string {
  const t = useTranslations('StageNames');
  return useCallback((name: string) => stageLabel(name, t), [t]);
}
