import type { ReactElement } from 'react';
import { expect, it, vi } from 'vitest';

// One dialog over its renders: no DOM here, so React's hooks are stood in
// for, with the one state kept.
let state: unknown;
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (init: unknown) => [
    (state ??= init),
    (next: unknown) => void (state = next),
  ],
  useEffect: () => {},
}));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
vi.mock('@/components/ui-ext/confirm-dialog', () => ({ ConfirmDialog: 'p' }));

import { AssignConfirmDialog } from './assign-confirm-dialog';

const render = (p: { open: boolean; currentId: string | null }) =>
  (
    AssignConfirmDialog({
      customer: 'Acme',
      currentName: '',
      nextId: p.open ? 'omar' : null,
      nextName: '',
      meanwhile: false,
      onCancel: () => {},
      onConfirm: () => {},
      ...p,
    }) as ReactElement<{ open: boolean; title: string; confirmLabel: string }>
  ).props;

it('keeps its wording while it closes', () => {
  expect(render({ open: false, currentId: null }).open).toBe(false);
  const asked = {
    title: 'confirmReassignTitle',
    description: 'confirmReassignBody',
    confirmLabel: 'confirmReassignAction',
  };
  expect(render({ open: true, currentId: 'sara' })).toMatchObject(asked);
  // Answered: the screen asks nothing now, and the chat is Omar's.
  expect(render({ open: false, currentId: 'omar' })).toMatchObject({
    ...asked,
    open: false,
  });
});
