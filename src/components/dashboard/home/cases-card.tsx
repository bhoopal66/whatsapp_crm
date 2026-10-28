'use client';

import type { AccountRole } from '@/lib/auth/roles';
import type { OpenCases } from '@/lib/dashboard/home/sources';
import type { WidgetData } from './use-widget-data';

// Placeholder: the real widget replaces this file.
export interface CasesCardProps {
  cases: WidgetData<OpenCases>;
  /** Whose cases these are: an agent's own, a leader's team's, or all. */
  role: AccountRole;
  className?: string;
}

export function CasesCard(props: CasesCardProps) {
  void props;
  return null;
}
