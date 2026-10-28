'use client';

import type { AccountNumber } from '@/hooks/use-whatsapp-numbers';

// Placeholder: the real widget replaces this file.
export interface NumbersCardProps {
  /** The account's numbers (the page's `useAccountNumbers`); null until loaded. */
  numbers: AccountNumber[] | null;
  className?: string;
}

export function NumbersCard(props: NumbersCardProps) {
  void props;
  return null;
}
