import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../../messages/en.json';
import ko from '../../../../messages/ko.json';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import type { DockMode } from '@/lib/meetings/room-ui/controls';
import { SHORTCUT_KEYS } from '@/lib/meetings/room-ui/keys';

import {
  ControlBar,
  Dock,
  moreItems,
  type ControlBarProps,
} from './control-bar';
import { SHORTCUT_ROWS } from './shortcuts-dialog';

// The node environment has no ResizeObserver or layout, so the server
// render of ControlBar is the full dock and Dock takes each form by prop.
// This pins what each form offers before anyone clicks: the moderator's
// caret (End for everyone lives behind it), the unread badge and the
// always-present Leave.

function props(
  opts: { canModerate?: boolean; chatUnread?: number } = {}
): ControlBarProps {
  const call = {
    micOn: true,
    cameraOn: true,
    handRaised: false,
    sharing: false,
    canSelectOutput: false,
    background: { kind: 'none' },
    backgroundBusy: false,
    backgroundsSupported: false,
    deviceOptions: { audioinput: [], videoinput: [], audiooutput: [] },
    selectedDevices: {},
    canModerate: opts.canModerate ?? false,
    participants: [],
    participantId: 'me',
    locked: false,
    recording: null,
  } as unknown as MeetingCall;
  return {
    call,
    layout: 'auto',
    onLayout: vi.fn(),
    hideSelf: false,
    onHideSelf: vi.fn(),
    chatUnread: opts.chatUnread ?? 0,
    panel: null,
    onTogglePanel: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onFullscreen: vi.fn(),
    pip: { supported: false, active: false, available: false },
    onPip: vi.fn(),
  };
}

function withIntl(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );
}

const render = (opts: { canModerate: boolean; chatUnread: number }) =>
  withIntl(<ControlBar {...props(opts)} />);

const renderDock = (
  mode: DockMode,
  over: Partial<ControlBarProps> = {},
  canModerate = false
) => withIntl(<Dock {...props({ canModerate })} {...over} mode={mode} />);

describe('ControlBar (the full dock)', () => {
  it('offers a moderator the caret holding End for everyone', () => {
    expect(render({ canModerate: true, chatUnread: 0 })).toContain(
      'aria-label="Leave options"'
    );
  });

  it('hides that caret from anyone else', () => {
    expect(render({ canModerate: false, chatUnread: 0 })).not.toContain(
      'aria-label="Leave options"'
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
    expect(html).not.toContain('bg-destructive absolute');
  });

  it('always renders Leave', () => {
    for (const canModerate of [true, false]) {
      expect(render({ canModerate, chatUnread: 0 })).toContain(
        'aria-label="Leave"'
      );
    }
  });
});

describe('Dock forms', () => {
  const caption = '<span aria-hidden="true" class="text-muted-foreground h-3.5';

  it('captions the buttons only in the full form', () => {
    expect(renderDock('full')).toContain(caption);
    expect(renderDock('icons')).not.toContain(caption);
    expect(renderDock('compact')).not.toContain(caption);
  });

  it('shows the clock only in the full form', () => {
    expect(renderDock('full')).toContain('aria-label="Local time"');
    expect(renderDock('icons')).not.toContain('aria-label="Local time"');
  });

  it('counts raised hands, ours included, in the full form', () => {
    const base = props();
    const call = {
      ...base.call,
      handRaised: true,
      participants: [
        { id: 'me', hand_raised_at: null },
        { id: 'a', hand_raised_at: '2026-11-05T10:00:00Z' },
        { id: 'b', hand_raised_at: null },
      ],
    } as unknown as MeetingCall;
    expect(renderDock('full', { call })).toContain('2 hands raised');
    expect(renderDock('full')).not.toContain('raised<');
  });

  it('moves Share, Reactions and Hand off the compact bar', () => {
    for (const label of ['Share screen', 'Send a reaction', 'Raise hand']) {
      expect(renderDock('icons')).toContain(`aria-label="${label}"`);
      expect(renderDock('compact')).not.toContain(`aria-label="${label}"`);
    }
  });

  it('keeps the essentials on the compact bar', () => {
    const html = renderDock('compact', {}, true);
    for (const label of [
      'Mute',
      'Turn camera off',
      'More options',
      'Chat',
      'People',
      'Leave',
      'Leave options',
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it('marks the open panel on its button', () => {
    const html = renderDock('icons', { panel: 'people' });
    expect(html).toMatch(/aria-label="People"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Chat"[^>]*aria-pressed="false"/);
  });
});

describe('moreItems', () => {
  const t = (key: string) => key;
  const noFullscreen = { supported: false, active: false };
  const ids = (
    p: ControlBarProps,
    compact = false,
    fullscreen = noFullscreen
  ) =>
    moreItems(p, { t, compact, fullscreen })
      .filter((i) => i.kind !== 'separator')
      .map((i) => i.id);

  it('lists the view options, then settings and the shortcuts', () => {
    expect(ids(props())).toEqual([
      'layout',
      'hideSelf',
      'settings',
      'shortcuts',
    ]);
  });

  it('offers full screen and picture-in-picture only where they work', () => {
    const p = {
      ...props(),
      pip: { supported: true, active: false, available: true },
    };
    expect(ids(p, false, { supported: true, active: false })).toEqual([
      'layout',
      'hideSelf',
      'fullscreen',
      'pip',
      'settings',
      'shortcuts',
    ]);
  });

  it('offers the pop-out in place of picture-in-picture where it exists', () => {
    const popout = {
      supported: true,
      active: false,
      open: vi.fn(),
      close: vi.fn(),
    };
    const items = (p: ControlBarProps['popout']) =>
      moreItems(
        {
          ...props(),
          pip: { supported: true, active: false, available: true },
          popout: p,
        },
        {
          t: (key) => key,
          compact: false,
          fullscreen: { supported: false, active: false },
          popoutLabels: { open: 'Pop out', close: 'Bring back' },
        }
      );
    const entry = (p: ControlBarProps['popout']) =>
      items(p).find((i) => i.id === 'popout') as
        { label: string; onClick: () => void } | undefined;

    expect(items(popout).some((i) => i.id === 'pip')).toBe(false);
    expect(entry(popout)?.label).toBe('Pop out');
    entry(popout)?.onClick();
    expect(popout.open).toHaveBeenCalledOnce();

    const open = { ...popout, active: true };
    expect(entry(open)?.label).toBe('Bring back');
    entry(open)?.onClick();
    expect(popout.close).toHaveBeenCalledOnce();

    // A phone or Firefox: the browser's own video window stays.
    for (const p of [null, { ...popout, supported: false }]) {
      expect(entry(p)).toBeUndefined();
      expect(items(p).some((i) => i.id === 'pip')).toBe(true);
    }
  });

  it('disables picture-in-picture with nothing to show, unless it is on', () => {
    const pipItem = (pip: ControlBarProps['pip']) =>
      moreItems(
        { ...props(), pip },
        {
          t,
          compact: false,
          fullscreen: noFullscreen,
        }
      ).find((i) => i.id === 'pip');
    expect(
      pipItem({ supported: true, active: false, available: false })
    ).toMatchObject({ disabled: true });
    expect(
      pipItem({ supported: true, active: true, available: false })
    ).toMatchObject({ disabled: false });
  });

  it('takes what left the bar in the compact form', () => {
    expect(ids(props(), true).slice(0, 3)).toEqual([
      'reactions',
      'share',
      'hand',
    ]);
  });

  it('offers the three layouts and reports the choice', () => {
    const p = props();
    const layout = moreItems(p, {
      t,
      compact: false,
      fullscreen: noFullscreen,
    }).find((i) => i.kind === 'radio');
    if (layout?.kind !== 'radio') throw new Error('no layout entry');
    expect(layout.options.map((o) => o.value)).toEqual([
      'auto',
      'speaker',
      'focus',
    ]);
    layout.onChange('focus');
    expect(p.onLayout).toHaveBeenCalledWith('focus');
  });
});

describe('shortcuts dialog', () => {
  it('lists every shortcut, plus Esc and hold-to-talk', () => {
    const ids = SHORTCUT_ROWS.map((r) => r.id);
    for (const key of Object.keys(SHORTCUT_KEYS)) {
      expect(ids).toContain(key);
    }
    expect(ids).toEqual(expect.arrayContaining(['closePanel', 'talk']));
  });

  it('has a line for every row in both languages', () => {
    for (const row of SHORTCUT_ROWS) {
      expect(en.MeetingRoom.shortcuts).toHaveProperty(row.id);
      expect(ko.MeetingRoom.shortcuts).toHaveProperty(row.id);
    }
  });
});
