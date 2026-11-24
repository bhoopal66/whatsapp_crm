import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MessageTemplateStatus } from '@/types';
import {
  chatTemplateSendsFrom,
  contactTemplateSendsFrom,
  offerTemplates,
} from './template-offer';

const row = (id: string, status?: MessageTemplateStatus, metaId?: string) => ({
  id,
  status,
  meta_template_id: metaId,
});
const rows = [
  row('local', 'APPROVED'),
  row('approved', 'APPROVED', '1'),
  row('pending', 'PENDING', '2'),
  row('appeal', 'IN_APPEAL', '3'),
  row('rejected', 'REJECTED', '4'),
  row('paused', 'PAUSED', '5'),
  row('disabled', 'DISABLED', '6'),
  row('deleting', 'PENDING_DELETION', '7'),
  row('draft', 'DRAFT'),
  row('bare'),
];
const ids = (list: { id: string }[]) => list.map((r) => r.id);

describe('offerTemplates', () => {
  it('Meta: only what Meta took and approved, the rest with the reason', () => {
    const { offered, blocked } = offerTemplates(rows, 'meta');
    expect(ids(offered)).toEqual(['approved']);
    expect(blocked.map((b) => [b.template.id, b.reason])).toEqual([
      ['local', 'not_approved'],
      ['pending', 'waiting'],
      ['appeal', 'waiting'],
      ['rejected', 'not_approved'],
      ['paused', 'paused'],
    ]);
  });

  it('linked: whatever Meta says, except gone and draft rows', () => {
    const { offered, blocked } = offerTemplates(rows, 'linked');
    expect(ids(offered)).toEqual([
      'local',
      'approved',
      'pending',
      'appeal',
      'rejected',
      'paused',
    ]);
    expect(blocked).toEqual([]);
  });

  it('unknown: the approved ones, as before', () => {
    const { offered, blocked } = offerTemplates(rows, 'unknown');
    expect(ids(offered)).toEqual(['local', 'approved']);
    expect(blocked).toEqual([]);
  });
});

describe('chatTemplateSendsFrom', () => {
  const numbers = [
    { id: 'm', provider: 'meta', is_personal: false },
    { id: 'w', provider: 'whapi', is_personal: false },
    { id: 'p', provider: 'openwa', is_personal: true },
  ];
  const at = '2026-11-24T10:00:00Z';
  const from = (channel_id: string | null, provider: string | null) => ({
    created_at: at,
    channel_id,
    provider,
  });

  it('follows the pin', () => {
    const pinned = (id: string) => ({ channel_id: 'm', send_channel_id: id });
    expect(chatTemplateSendsFrom(numbers, pinned('m'), undefined)).toBe('meta');
    expect(chatTemplateSendsFrom(numbers, pinned('w'), undefined)).toBe(
      'linked'
    );
    expect(chatTemplateSendsFrom(numbers, pinned('gone'), undefined)).toBe(
      'unknown'
    );
  });

  it('else the number the customer last wrote to, then its provider', () => {
    const chat = { channel_id: 'w' };
    expect(chatTemplateSendsFrom(numbers, chat, from('m', 'meta'))).toBe(
      'meta'
    );
    expect(chatTemplateSendsFrom(numbers, chat, from('w', 'whapi'))).toBe(
      'linked'
    );
    expect(chatTemplateSendsFrom(numbers, chat, from(null, 'whapi'))).toBe(
      'linked'
    );
    // Only a colleague's own phone is OpenWA here: never a company chat's.
    expect(chatTemplateSendsFrom(numbers, chat, from('p', 'openwa'))).toBe(
      'unknown'
    );
    expect(chatTemplateSendsFrom(numbers, chat, undefined)).toBe('unknown');
  });

  it("else the chat's own number", () => {
    const own = (id: string | null) => ({ channel_id: id });
    expect(chatTemplateSendsFrom(numbers, own('m'), null)).toBe('meta');
    expect(chatTemplateSendsFrom(numbers, own('w'), null)).toBe('linked');
    expect(chatTemplateSendsFrom(numbers, own(null), null)).toBe('unknown');
    // An old row that names neither: Meta is not certain, nor linked.
    expect(chatTemplateSendsFrom(numbers, own('m'), from(null, null))).toBe(
      'unknown'
    );
  });

  it('no Meta number, or a personal chat: linked', () => {
    expect(chatTemplateSendsFrom([numbers[1]], {}, undefined)).toBe('linked');
    expect(
      chatTemplateSendsFrom(numbers, { personal_owner_id: 'u' }, undefined)
    ).toBe('linked');
  });

  it('numbers not loaded, or none: unknown', () => {
    expect(chatTemplateSendsFrom(null, { channel_id: 'm' }, null)).toBe(
      'unknown'
    );
    expect(chatTemplateSendsFrom([], {}, null)).toBe('unknown');
  });
});

it('the contact screens send over Meta when a Meta number is connected', () => {
  const channel = (provider: 'meta' | 'whapi') => ({
    templateChannel: { provider } as never,
  });
  expect(contactTemplateSendsFrom(channel('meta'))).toBe('meta');
  expect(contactTemplateSendsFrom(channel('whapi'))).toBe('linked');
  expect(contactTemplateSendsFrom({ templateChannel: null })).toBe('unknown');
});

// No DOM here to mount the dialog: its query and its callers are pinned.
describe('the picker', () => {
  const src = (p: string) =>
    readFileSync(join(process.cwd(), 'src/components', p), 'utf8');

  it('reads every status, bounded, and shows the offer', () => {
    const picker = src('inbox/template-picker.tsx');
    expect(picker).not.toMatch(/\.eq\(["']status["']/);
    expect(picker).toMatch(/\.limit\(MAX_TEMPLATES\)/);
    expect(picker).toMatch(/offerTemplates\(templates, sendsFrom\)/);
  });

  it('is told what the chat and the customer page send from', () => {
    expect(src('inbox/message-thread.tsx')).toMatch(
      /sendsFrom=\{\s*conversation\s*\? chatTemplateSendsFrom\(\s*accountNumbers,\s*conversation,\s*lastCustomer\s*\)/
    );
    expect(src('contacts/contact-outreach.tsx')).toContain(
      'sendsFrom={contactTemplateSendsFrom(prediction)}'
    );
  });
});
