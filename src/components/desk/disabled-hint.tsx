'use client';

import { Info } from 'lucide-react';

/**
 * Plain-English reason a button next to it cannot be pressed yet. Give
 * the button `aria-describedby={id}` while this shows, so a screen reader
 * hears it with the button.
 */
export function DisabledHint({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <p
      id={id}
      className="text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs"
    >
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
