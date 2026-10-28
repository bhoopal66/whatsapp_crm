'use client';

import type { Task } from '@/lib/tasks/types';
import type { WidgetData } from './use-widget-data';

// Placeholder: the real widget replaces this file.
export interface TasksPanelProps {
  /** The person's open tasks; `update` patches the list after a tick. */
  tasks: WidgetData<Task[]>;
  className?: string;
}

export function TasksPanel(props: TasksPanelProps) {
  void props;
  return null;
}
