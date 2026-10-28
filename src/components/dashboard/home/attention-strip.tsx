'use client';

import type { OpenCases } from '@/lib/dashboard/home/sources';
import type { Task } from '@/lib/tasks/types';
import type { WidgetData } from './use-widget-data';

// Placeholder: the real widget replaces this file.
export interface AttentionStripProps {
  refreshKey: number;
  /** The person's open tasks (the page's; the tasks panel shares it). Null: the role holds no tasks. */
  tasks: WidgetData<Task[]> | null;
  /** Open cases (the page's; the cases card shares it). Null: the role gets no cases. */
  cases: WidgetData<OpenCases> | null;
  /** Open missed-call tasks assigned to this person; null without a phone system. */
  missedCalls: number | null;
  className?: string;
}

export function AttentionStrip(props: AttentionStripProps) {
  void props;
  return null;
}
