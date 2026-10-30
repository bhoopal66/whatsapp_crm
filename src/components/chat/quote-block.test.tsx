import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ChatMessage } from '@/lib/chat';
import { quoteTint } from '@/lib/chat/view';

import {
  ForwardedLine,
  forwardedText,
  QuoteBlock,
  type QuoteLabel,
} from './quote-block';

const ANA = '11111111-1111-4111-8111-111111111111';
const people = [{ userId: ANA, fullName: 'Ana Haddad' }];

const msg = (o: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  channelId: 'c1',
  accountId: 'a1',
  threadRootId: null,
  authorKind: 'user',
  authorId: ANA,
  body: 'see you at nine',
  meta: {},
  createdAt: '2026-10-30T09:00:00Z',
  editedAt: null,
  deletedAt: null,
  erasedAt: null,
  replyToId: null,
  forwarded: null,
  attachments: [],
  reactions: [],
  thread: null,
  ...o,
});

const label: QuoteLabel = (key, values) =>
  values ? `[${key} ${JSON.stringify(values)}]` : `[${key}]`;

const html = (target: ChatMessage | null | undefined, onJump?: () => void) =>
  renderToStaticMarkup(
    React.createElement(QuoteBlock, {
      target,
      people,
      unknownName: 'Unknown',
      systemName: 'System',
      label,
      onJump,
    })
  );

describe('QuoteBlock', () => {
  it('shows the author and the text, tinted, as a jump button', () => {
    const out = html(msg(), () => {});
    expect(out).toMatch(/^<button type="button"/);
    expect(out).toContain('Ana Haddad');
    expect(out).toContain('see you at nine');
    for (const c of quoteTint(ANA).split(' ')) expect(out).toContain(c);
    expect(out).toContain(
      'title="[jumpLabel {&quot;name&quot;:&quot;Ana Haddad&quot;}]"'
    );
  });

  it('is not a button where the view cannot jump', () => {
    const out = html(msg());
    expect(out).toMatch(/^<div/);
    expect(out).not.toContain('<button');
    expect(out).toContain('see you at nine');
  });

  it('shows a loading state while the quote is read', () => {
    const out = html(undefined, () => {});
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('[loading]');
    expect(out).not.toContain('<button');
  });

  it('shows an unavailable quote without author or button', () => {
    const out = html(null, () => {});
    expect(out).toContain('[unavailable]');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('Ana Haddad');
  });

  it('shows a deleted or erased quote by its author', () => {
    const del = html(msg({ deletedAt: '2026-10-30T10:00:00Z' }), () => {});
    expect(del).toContain('[deleted]');
    expect(del).toContain('Ana Haddad');
    expect(del).not.toContain('see you at nine');
    const era = html(
      msg({ erasedAt: '2026-10-30T10:00:00Z', body: '[erased]' })
    );
    expect(era).toContain('[erased]');
  });

  it('names a system post and an unknown author', () => {
    expect(html(msg({ authorKind: 'system', authorId: null }))).toContain(
      'System'
    );
    expect(
      html(msg({ authorId: '22222222-2222-4222-8222-222222222222' }))
    ).toContain('Unknown');
  });

  it('escapes the quoted text', () => {
    const out = html(msg({ body: '<img src=x onerror=alert(1)>' }));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('calls onJump only through the button', () => {
    const onJump = vi.fn();
    const el = QuoteBlock({
      target: msg(),
      people,
      unknownName: 'Unknown',
      systemName: 'System',
      label,
      onJump,
    }) as React.ReactElement<{ onClick: () => void }>;
    el.props.onClick();
    expect(onJump).toHaveBeenCalledTimes(1);
  });
});

describe('ForwardedLine', () => {
  const fwd = (o: Partial<NonNullable<ChatMessage['forwarded']>> = {}) => ({
    messageId: 'src',
    authorId: ANA,
    authorKind: 'user' as const,
    createdAt: '2026-10-01T09:00:00Z',
    ...o,
  });
  const text = (f: NonNullable<ChatMessage['forwarded']>) =>
    forwardedText(
      f,
      people,
      '1 Oct 2026',
      (key, values) => `${key}|${values.name ?? ''}|${values.date}`
    );

  it('names a known author with the date', () => {
    expect(text(fwd())).toBe('forwardedFrom|Ana Haddad|1 Oct 2026');
  });

  it('says only "Forwarded" for a system post or an unknown author', () => {
    expect(text(fwd({ authorKind: 'system', authorId: null }))).toBe(
      'forwarded||1 Oct 2026'
    );
    expect(
      text(fwd({ authorId: '22222222-2222-4222-8222-222222222222' }))
    ).toBe('forwarded||1 Oct 2026');
  });

  it('renders the text beside the Forward icon', () => {
    const out = renderToStaticMarkup(
      React.createElement(ForwardedLine, { text: 'Forwarded · 1 Oct 2026' })
    );
    expect(out).toContain('lucide-forward');
    expect(out).toContain('Forwarded · 1 Oct 2026');
  });
});
