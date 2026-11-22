import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  LEAD_SOURCES,
  adLeadSourceToCapture,
  isLeadSource,
  referralLeadSource,
  setLeadSourceIfEmpty,
} from './lead-source';

const MIGRATION = readFileSync(
  join(__dirname, '../../../supabase/migrations/249_lead_source_web_form.sql'),
  'utf8'
);

describe('LEAD_SOURCES', () => {
  it('equals the CHECK list of migration 249', () => {
    const check =
      /contacts_lead_source_check\s+CHECK \(lead_source IS NULL OR lead_source IN \(([^)]*)\)/.exec(
        MIGRATION
      );
    expect(check).not.toBeNull();
    const sql = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(sql).toEqual([...LEAD_SOURCES]);
  });

  it('isLeadSource accepts only the list', () => {
    expect(isLeadSource('ad')).toBe(true);
    expect(isLeadSource('web_form')).toBe(true);
    expect(isLeadSource('Ad')).toBe(false);
    expect(isLeadSource(null)).toBe(false);
  });
});

describe('referralLeadSource', () => {
  it('maps a Click-to-WhatsApp ad, trimmed', () => {
    expect(
      referralLeadSource({
        sourceType: ' ad ',
        sourceId: '120200000',
        headline: '  Get a loan\n today ',
        sourceUrl: 'https://fb.me/abc',
        ctwaClid: 'clid-1',
        body: 'not stored',
      })
    ).toEqual({
      source: 'ad',
      detail: {
        via: 'whatsapp_referral',
        source_type: 'ad',
        source_id: '120200000',
        headline: 'Get a loan  today',
        source_url: 'https://fb.me/abc',
        ctwa_clid: 'clid-1',
      },
    });
  });

  it('files a post as other', () => {
    expect(referralLeadSource({ sourceType: 'post' })).toEqual({
      source: 'other',
      detail: { via: 'whatsapp_referral', source_type: 'post' },
    });
  });

  it('caps long strings and drops a non-http url', () => {
    const out = referralLeadSource({
      sourceType: 'ad',
      headline: 'x'.repeat(1000),
      sourceUrl: 'javascript:alert(1)',
    });
    expect((out!.detail.headline as string).length).toBe(300);
    expect(out!.detail.source_url).toBeUndefined();
  });

  it('answers null for nothing usable and never throws', () => {
    expect(referralLeadSource(undefined)).toBeNull();
    expect(referralLeadSource({ sourceType: '   ' })).toBeNull();
    expect(
      referralLeadSource({ sourceType: 42 } as unknown as {
        sourceType: string;
      })
    ).toBeNull();
  });
});

describe('adLeadSourceToCapture', () => {
  const referral = { sourceType: 'ad', sourceId: '1' };
  it('captures on the first inbound of a company chat', () => {
    expect(
      adLeadSourceToCapture({
        referral,
        isFirstInbound: true,
        isPersonal: false,
      })?.source
    ).toBe('ad');
  });
  it('skips a later message, a personal number and no referral', () => {
    expect(
      adLeadSourceToCapture({
        referral,
        isFirstInbound: false,
        isPersonal: false,
      })
    ).toBeNull();
    expect(
      adLeadSourceToCapture({
        referral,
        isFirstInbound: true,
        isPersonal: true,
      })
    ).toBeNull();
    expect(
      adLeadSourceToCapture({
        referral: undefined,
        isFirstInbound: true,
        isPersonal: false,
      })
    ).toBeNull();
  });
});

describe('setLeadSourceIfEmpty', () => {
  const capture = { source: 'ad' as const, detail: { via: 'x' } };
  it('calls the 249 setter and reports whether it wrote', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const db = { rpc } as never;
    await expect(
      setLeadSourceIfEmpty(db, { accountId: 'a', contactId: 'c', capture })
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('contact_set_lead_source_if_empty', {
      p_account: 'a',
      p_contact: 'c',
      p_source: 'ad',
      p_detail: { via: 'x' },
    });
  });
  it('never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = { rpc: vi.fn().mockRejectedValue(new Error('down')) } as never;
    await expect(
      setLeadSourceIfEmpty(db, { accountId: 'a', contactId: 'c', capture })
    ).resolves.toBe(false);
    const db2 = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'x' } }),
    } as never;
    await expect(
      setLeadSourceIfEmpty(db2, { accountId: 'a', contactId: 'c', capture })
    ).resolves.toBe(false);
    warn.mockRestore();
  });
});
