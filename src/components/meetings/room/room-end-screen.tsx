'use client';

import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A link, or a button that does something here. */
export type EndAction = { label: string; disabled?: boolean } & (
  { href: string } | { onClick: () => void }
);

const ACTION_CLASS = 'w-full sm:w-auto';

function ActionControl({
  action,
  primary,
}: {
  action: EndAction;
  primary: boolean;
}) {
  const variant = primary ? 'default' : 'outline';
  if ('href' in action) {
    return (
      <Link
        href={action.href}
        className={cn(buttonVariants({ variant }), ACTION_CLASS)}
      >
        {action.label}
      </Link>
    );
  }
  return (
    <Button
      type="button"
      variant={variant}
      className={ACTION_CLASS}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {action.label}
    </Button>
  );
}

/**
 * Whatever is not the call or the lobby: one card saying what happened
 * and what to do next. The first action is the primary one.
 */
export function RoomEndScreen({
  icon: Icon,
  tone = 'calm',
  title,
  body,
  actions,
}: {
  icon: LucideIcon;
  /** `warning` is for something that went wrong, not for a normal end. */
  tone?: 'calm' | 'warning';
  title: string;
  body?: string;
  actions: readonly EndAction[];
}) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-4 sm:p-6">
        <div className="bg-card flex w-full max-w-md flex-col items-center rounded-2xl border p-8 text-center shadow-sm">
          <div
            className={cn(
              'flex size-14 items-center justify-center rounded-full',
              tone === 'warning'
                ? 'bg-warning-soft text-warning'
                : 'bg-primary-soft text-primary'
            )}
          >
            <Icon className="size-6" aria-hidden />
          </div>
          <h1 className="mt-5 text-xl font-semibold tracking-tight text-balance">
            {title}
          </h1>
          {body && (
            <p className="text-muted-foreground mt-2 text-sm break-words">
              {body}
            </p>
          )}
          <div className="mt-6 flex w-full flex-col justify-center gap-2 sm:flex-row sm:flex-wrap">
            {actions.map((action, i) => (
              <ActionControl
                key={action.label}
                action={action}
                primary={i === 0}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
