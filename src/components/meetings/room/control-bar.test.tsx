import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../../messages/en.json';
import type { MeetingCall } from '@/hooks/use-meeting-call';

import { ControlBar } from './control-bar';

// The node environment has no matchMedia, so the server render is the
// desktop bar (useMediaQuery answers false). This pins what that bar
// offers before anyone clicks: the moderator-only End, the unread badge
// and the always-present Leave.

function render(opts: { canModerate: boolean; chatUnread: number }) {
  const call = {
    micOn: true,
    cameraOn: true,
    handRaised: false,
    sharing: false,
    canSelectOutput: false,
    deviceOptions: { audioinput: [], videoinput: [], audiooutput: [] },
    selectedDevices: {},
    canModerate: opts.canModerate,
  } as unknown as MeetingCall;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ControlBar
        call={call}
        layout={'auto' as never}
        onLayout={vi.fn()}
        chatUnread={opts.chatUnread}
        onOpenPanel={vi.fn()}
        onOpenSettings={vi.fn()}
        pip={{ supported: false, active: false, available: false }}
        onPip={vi.fn()}
      />
    </NextIntlClientProvider>
  );
}

describe('ControlBar (desktop)', () => {
  it('offers End for everyone to a moderator', () => {
    expect(render({ canModerate: true, chatUnread: 0 })).toContain(
      'End for everyone'
    );
  });

  it('hides End for everyone from anyone else', () => {
    expect(render({ canModerate: false, chatUnread: 0 })).not.toContain(
      'End for everyone'
    );
  });

  it('shows the unread count on the Chat button, capped at 99+', () => {
    const some = render({ canModerate: false, chatUnread: 5 });
    expect(some).toContain('Chat, 5 unread messages');
    expect(some).toContain('>5</span>');
    const many = render({ canModerate: false, chatUnread: 150 });
    expect(many).toContain('>99+</span>');
  });

  it('shows no badge at zero unread', () => {
    const html = render({ canModerate: false, chatUnread: 0 });
    expect(html).toContain('aria-label="Chat"');
    expect(html).not.toContain('unread');
    expect(html).not.toContain('rounded-full bg-red-500');
  });

  it('always renders Leave', () => {
    for (const canModerate of [true, false]) {
      expect(render({ canModerate, chatUnread: 0 })).toContain(
        'aria-label="Leave"'
      );
    }
  });
});
