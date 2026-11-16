import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import type { AutoMsgOutboxRow } from '@/lib/hr/automsg/api';
import { editorSlots } from '@/lib/hr/automsg/editor-view';
import { historyRowView } from '@/lib/hr/automsg/history-view';
import type { AutomsgRole } from '@/lib/hr/automsg/view';

import { AutomsgHistoryList } from './automsg-history';
import { TemplateCard } from './automsg-templates';

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '|')
    .replace(/\|+/g, '|')
    .replace(/&quot;/g, '"');

describe('TemplateCard', () => {
  const slot = editorSlots([])[1]; // cv_ack, Arabic, seed text

  it('shows the package layout: title with language, counter, four controls', () => {
    const html = render(
      <TemplateCard slot={slot} role="admin" onSaved={() => {}} />
    );
    const kind = en.Hr.automsg.templateKinds.cv_ack;
    expect(html).toContain(`<legend`);
    expect(text(html)).toContain(`|${kind} (Arabic)|`);
    expect(text(html)).toContain(
      `|${slot.initial.body.length} / 1024 characters|`
    );
    expect(text(html)).toContain('|Message|');
    expect(html).toMatch(/<textarea[^>]*dir="rtl"/);
    expect(text(html)).toContain('|Meta template name|');
    expect(html).toMatch(/<input[^>]*value="[a-z0-9_]+"/);
    expect(text(html)).toContain('|Approval|');
    expect(html).toMatch(
      /<select[^>]*>[\s\S]*Draft[\s\S]*Approved[\s\S]*<\/select>/
    );
    expect(text(html)).toContain('|Save template|');
  });

  it('is read-only for a lead, with no save button', () => {
    const html = render(
      <TemplateCard slot={slot} role="lead" onSaved={() => {}} />
    );
    expect(html).toMatch(/<textarea[^>]*readOnly/i);
    expect(html).toMatch(/<select[^>]*disabled/);
    expect(text(html)).not.toContain('Save template');
  });
});

describe('AutomsgHistoryList', () => {
  const row: AutoMsgOutboxRow = {
    id: 'o1',
    conversationId: 'c 1',
    contactId: 'k1',
    contactName: 'Aashish',
    trigger: 'cv_received',
    templateKind: 'cv_ack',
    language: 'en',
    status: 'held',
    holdReason: 'kill_switch',
    attempts: 0,
    claimState: null,
    lastError: null,
    createdAt: '2026-11-14T16:32:53Z',
    sentAt: null,
  };

  function cells(r: AutoMsgOutboxRow, role: AutomsgRole) {
    const html = render(
      <AutomsgHistoryList
        items={[{ row: r, view: historyRowView(r, role) }]}
        busy={false}
        onCancel={() => {}}
      />
    );
    const table = html.slice(0, html.indexOf('<ul'));
    const head = [...table.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, '')
    );
    const body = [...table.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (m) => m[1]
    );
    return { html, head, body };
  }

  it('renders the seven columns of one row', () => {
    const { head, body } = cells(row, 'admin');
    expect(head).toEqual([
      'Time',
      'Contact',
      'Trigger',
      'Status',
      'Hold reason',
      'Attempts',
      '',
    ]);
    expect(body).toHaveLength(7);
    expect(body[0]).toMatch(/2026/);
    expect(body[1]).toContain('href="/hr/recruiter?c=c%201"');
    expect(body[1]).toContain('Aashish');
    expect(body[2]).toContain(en.Hr.automsg.triggers.cv_received);
    expect(body[3]).toMatch(/rounded-full[^>]*>Held</);
    expect(body[4]).toBe('Kill switch is on');
    expect(body[5]).toBe('0');
    expect(body[6]).toContain('>Cancel</button>');
  });

  it('shows a dash for no hold reason and no cancel on a sent row', () => {
    const { body } = cells(
      { ...row, status: 'sent', holdReason: null, attempts: 1 },
      'admin'
    );
    expect(body[3]).toMatch(/>Sent</);
    expect(body[4]).toBe('-');
    expect(body[5]).toBe('1');
    expect(body[6]).not.toContain('Cancel');
  });
});
