import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';

// The dialog is portalled, which a server render drops: its boundary is
// captured instead, to pin what is asked for the assignee on screen now.

const mocks = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));
vi.mock('@/components/ui-ext/confirm-dialog', () => ({
  ConfirmDialog: (props: Record<string, unknown>) => {
    mocks.props = props;
    return null;
  },
}));

import { AssignConfirmDialog } from './assign-confirm-dialog';

function asked(
  currentId: string | null,
  nextId: string | null,
  meanwhile = false
) {
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{
        Inbox: { messageThread: en.Inbox.messageThread },
        InboxRows: en.InboxRows,
      }}
    >
      <AssignConfirmDialog
        open
        customer="Acme"
        currentId={currentId}
        currentName={currentId ? 'Sara' : ''}
        nextId={nextId}
        nextName={nextId ? 'Omar' : ''}
        meanwhile={meanwhile}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </NextIntlClientProvider>
  );
  return mocks.props as unknown as {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
  };
}

describe('AssignConfirmDialog', () => {
  beforeEach(() => {
    mocks.props = null;
  });

  it('words the question from the assignee on screen now', () => {
    expect(asked(null, 'omar').title).toBe('Assign this chat?');
    const re = asked('sara', 'omar');
    expect(re.title).toBe('Reassign this chat?');
    expect(re.description).toContain('from Sara to Omar');
    expect(re.confirmLabel).toBe('Reassign');
    expect(asked('sara', null).title).toBe('Unassign this chat?');
  });

  it('names who was assigned meanwhile when asking again', () => {
    expect(asked('sara', 'omar', true)).toMatchObject({
      open: true,
      title: 'Reassign this chat?',
      description: 'Sara was assigned to Acme meanwhile. Assign Omar instead?',
    });
    expect(asked(null, 'omar', true).description).toBe(
      'The chat with Acme was unassigned meanwhile. Assign it to Omar?'
    );
    expect(asked('sara', null, true).description).toBe(
      'Sara was assigned to Acme meanwhile. Unassign the chat anyway?'
    );
  });

  it('is not shown once the change has been made by someone else', () => {
    expect(asked('omar', 'omar').open).toBe(false);
  });
});
