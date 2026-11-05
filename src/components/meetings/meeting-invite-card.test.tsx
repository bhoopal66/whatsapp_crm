import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';

import {
  MeetingInviteCardView,
  type MeetingInviteCardViewProps,
} from './meeting-invite-card';

// The view is the only part a node render can reach: which words it shows
// and that it announces itself. When it rings is invite-ring.test.ts.

function render(over: Partial<MeetingInviteCardViewProps> = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <MeetingInviteCardView
        title="Weekly sync"
        inviter="Sara"
        workspace={null}
        onJoin={vi.fn()}
        onDismiss={vi.fn()}
        {...over}
      />
    </NextIntlClientProvider>
  );
}

describe('MeetingInviteCardView', () => {
  it('announces itself as an alert dialog', () => {
    const html = render();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-label="Meeting invite"');
    expect(html).toContain('data-meeting-invite');
  });

  it('shows the meeting and who is inviting', () => {
    const html = render();
    expect(html).toContain('Weekly sync');
    expect(html).toContain('Sara is inviting you to join now');
  });

  it('falls back to the generic line with no inviter', () => {
    const html = render({ inviter: null });
    expect(html).toContain('You&#x27;re invited to join now');
    expect(html).not.toContain('is inviting you');
  });

  it('names another workspace, and only then', () => {
    expect(render({ workspace: 'Taamul Bank' })).toContain(
      'Meeting invite · Taamul Bank'
    );
    expect(render()).not.toContain(' · ');
  });

  it('offers Join and Not now', () => {
    const html = render();
    expect(html).toContain('>Not now<');
    expect(html).toContain('Join</button>');
  });
});
