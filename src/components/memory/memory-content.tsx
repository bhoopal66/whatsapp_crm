'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';

import {
  memorySegments,
  type MemorySegment,
  type VaultTokenKind,
} from '@/lib/memory/ui';

import { RevealDialog } from './reveal-dialog';

const CHIP =
  'mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-px align-baseline text-xs';

/**
 * One memory's content as segments: text stays text (never HTML), a
 * vault token is a chip (a button for a vault role), a redaction marker
 * a muted chip.
 */
export function MemoryContent({
  content,
  canReveal,
}: {
  content: string;
  canReveal: boolean;
}) {
  const t = useTranslations('Memory');
  const [open, setOpen] = useState<{
    token: string;
    kind: VaultTokenKind;
  } | null>(null);

  const piece = (s: MemorySegment, i: number) => {
    if (s.type === 'text') return <span key={i}>{s.text}</span>;
    if (s.type === 'redaction') {
      const label =
        s.kind === 'PHONE' && s.last
          ? t('chips.redacted.phoneEnding', { digits: s.last })
          : t(`chips.redacted.${s.kind}`);
      return (
        <span
          key={i}
          className={`${CHIP} bg-muted text-muted-foreground border-transparent`}
        >
          {label}
        </span>
      );
    }
    const label = t(`chips.${s.kind}`);
    if (!canReveal)
      return (
        <span
          key={i}
          className={`${CHIP} bg-secondary text-secondary-foreground`}
          title={t('chips.vaulted', { label })}
        >
          <Lock className="size-3" aria-hidden />
          {label}
        </span>
      );
    return (
      <button
        key={i}
        type="button"
        className={`${CHIP} bg-secondary text-secondary-foreground hover:bg-secondary/80 focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:outline-none`}
        aria-label={t('chips.revealHint', { label })}
        onClick={() => setOpen({ token: s.token, kind: s.kind })}
      >
        <Lock className="size-3" aria-hidden />
        {label}
      </button>
    );
  };

  return (
    <>
      <p className="break-words whitespace-pre-wrap">
        {memorySegments(content).map(piece)}
      </p>
      {/* Mounted only while open: closing it drops the value with it. */}
      {open && (
        <RevealDialog
          token={open.token}
          label={t(`chips.${open.kind}`)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
