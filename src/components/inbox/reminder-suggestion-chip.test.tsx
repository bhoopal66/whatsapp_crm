import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import type { Message } from '@/types';
import {
  chipWhenLabel,
  type ReminderChip,
} from '@/lib/reminders/suggestion-view';
import { ReminderSuggestionChip } from './reminder-suggestion-chip';
import { MessageBubble } from './message-bubble';

// The reminder suggestion pill (migration 197), rendered server-side.

const noop = () => {};

const chip = (over: Partial<ReminderChip> = {}): ReminderChip => ({
  state: 'open',
  dueAt: new Date(2026, 10, 13, 15, 0),
  dateOnly: false,
  suggestionId: 's1',
  kind: 'call',
  ...over,
});

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );
}

describe('ReminderSuggestionChip', () => {
  it('offers Add reminder with its time and a Not a reminder ×', () => {
    const html = wrap(
      <ReminderSuggestionChip
        chip={chip()}
        label="Tomorrow 15:00"
        onAdd={noop}
        onDismiss={noop}
      />
    );
    expect(html).toContain('Add reminder · Tomorrow 15:00');
    expect(html).toContain('title="Add a reminder for Tomorrow 15:00"');
    expect(html).toContain('aria-label="Not a reminder"');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('bg-warning-soft');
    expect(html).not.toContain('Reminder set');
  });

  it('shows Reminder set, with no buttons, once added', () => {
    const html = wrap(
      <ReminderSuggestionChip
        chip={chip({ state: 'added' })}
        label="Tomorrow 15:00"
        onAdd={noop}
        onDismiss={noop}
      />
    );
    expect(html).toContain('Reminder set · Tomorrow 15:00');
    expect(html).toContain('title="Reminder set for Tomorrow 15:00"');
    expect(html).toContain('bg-success-soft');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Add reminder');
  });

  it('takes its when-words from chipWhenLabel', () => {
    const now = new Date(2026, 10, 12, 10, 0);
    const label = chipWhenLabel(chip().dueAt, now, 'en', {
      today: en.Inbox.reminderSuggestion.today,
      tomorrow: en.Inbox.reminderSuggestion.tomorrow,
    });
    expect(label).toBe('Tomorrow 15:00');
    const html = wrap(
      <ReminderSuggestionChip
        chip={chip()}
        label={label}
        onAdd={noop}
        onDismiss={noop}
      />
    );
    expect(html).toContain('Add reminder · Tomorrow 15:00');
  });
});

describe('MessageBubble with a reminder suggestion', () => {
  const ARABIC = 'اتصل بي غدا الساعة الثالثة';
  const message = {
    id: 'm1',
    conversation_id: 'conv-1',
    sender_type: 'customer',
    content_type: 'text',
    content_text: ARABIC,
    status: 'delivered',
    created_at: '2026-11-12T10:00:00.000Z',
  } as Message;

  it('puts the chip after the translate control', () => {
    const html = wrap(
      <MessageBubble
        message={message}
        reminder={{
          chip: chip(),
          label: 'Tomorrow 15:00',
          onAdd: noop,
          onDismiss: noop,
        }}
      />
    );
    const translate = html.indexOf('>Translate</button>');
    const reminder = html.indexOf('Add reminder · Tomorrow 15:00');
    expect(translate).toBeGreaterThan(-1);
    expect(reminder).toBeGreaterThan(translate);
  });

  it('shows no chip without the prop', () => {
    const html = wrap(<MessageBubble message={message} />);
    expect(html).not.toContain('Add reminder');
    expect(html).not.toContain('Not a reminder');
  });
});
