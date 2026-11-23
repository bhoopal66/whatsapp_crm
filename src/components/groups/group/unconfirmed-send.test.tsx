import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';

import { GroupMessageLog, type GroupChatMessage } from './message-log';
import { UnconfirmedSendFooter } from './unconfirmed-send';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const message = (id: string): GroupChatMessage => ({
  id,
  direction: 'out',
  sender_wa_id: null,
  sender_name: 'Aya',
  type: 'text',
  body: `words of ${id}`,
  status: 'pending',
  created_at: '2026-11-23T09:00:00.000Z',
});

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );

describe('a group send that may have gone out', () => {
  it('can be copied and discarded, never sent again', () => {
    const html = render(
      <UnconfirmedSendFooter onCopy={() => {}} onDiscard={() => {}} />
    );
    expect(html).toContain('May have been sent');
    expect(html).toContain('Copy');
    expect(html).toContain('Discard');
    expect(html).not.toContain('Retry');
  });

  it('has no Copy without words', () => {
    expect(
      render(<UnconfirmedSendFooter onDiscard={() => {}} />)
    ).not.toContain('Copy');
  });

  it('is marked under its own bubble only', () => {
    const html = render(
      <GroupMessageLog
        messages={[message('a'), message('b')]}
        currentUserId={null}
        footer={(m) => (m.id === 'b' ? <i>unconfirmed</i> : null)}
      />
    );
    expect(html.match(/unconfirmed/g)).toHaveLength(1);
    expect(html.indexOf('unconfirmed')).toBeGreaterThan(
      html.indexOf('words of b')
    );
  });
});
