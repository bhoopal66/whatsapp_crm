import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  guardrailFeedback,
  partnerBanksPromptLine,
} from '@/lib/ai/typesafe-gates';
import type { PartnerBanksSetting } from './admin-types';
import {
  BANKS,
  PARTNER_BANK_DISPLAY,
  detectBanks,
  detectBanksIn,
  partnerCatalogue,
} from './banks';
import { SWITCHES_UNMANAGED, type AccountSwitches } from './config';
import { SwitchesStore } from './policy';
import { supabaseStore, switchesFromRow, type TsStore } from './store';
import { TEST_ACCOUNT, makeLayer, makeSim } from './test-helpers';

const FAB_PARTNER: PartnerBanksSetting = {
  codes: ['MASHREQ', 'FAB', 'NOT_A_BANK'],
  custom: [],
};

const hits = (text: string, setting: PartnerBanksSetting | null) =>
  detectBanksIn(text, partnerCatalogue(setting).banks);

describe('partnerCatalogue (migration 078)', () => {
  it('null is the built-in list, unchanged', () => {
    const c = partnerCatalogue(null);
    expect(c.banks).toBe(BANKS);
    expect(c.display).toEqual([
      'Mashreq',
      'RAKBANK',
      'National Bank of Fujairah (NBF)',
      'Wio Bank',
      'Ruya Community Islamic Bank',
      'United Bank Limited (UBL)',
    ]);
    expect(PARTNER_BANK_DISPLAY).toEqual(c.display);
    const text = 'Mashreq or FAB or Emirates NBD?';
    expect(hits(text, null)).toEqual(detectBanks(text));
  });

  it('makes a built-in bank a partner when its code is listed', () => {
    const c = partnerCatalogue(FAB_PARTNER);
    expect(c.display).toEqual(['Mashreq', 'First Abu Dhabi Bank (FAB)']);
    expect(hits('Open it with FAB', FAB_PARTNER)).toEqual([
      { code: 'FAB', partner: true },
    ]);
    // Not listed any more: RAKBANK is now a non-partner.
    expect(hits('RAKBANK is fine', FAB_PARTNER)).toEqual([
      { code: 'RAKBANK', partner: false },
    ]);
  });

  it('detects a custom bank by name and acronym as a partner', () => {
    const setting: PartnerBanksSetting = {
      codes: [],
      custom: [{ name: 'Al Hilal Bank', aliases: ['AHB', 'مصرف الهلال'] }],
    };
    expect(partnerCatalogue(setting).display).toEqual(['Al Hilal Bank (AHB)']);
    const custom = [{ code: 'CUSTOM_1', partner: true }];
    // ADCB's dictionary lists "al hilal bank": the custom partner claims it.
    expect(hits('Apply at Al Hilal Bank today', setting)).toEqual(custom);
    expect(hits('Is AHB open?', setting)).toEqual(custom);
    expect(hits('أريد حساب في مصرف الهلال', setting)).toEqual(custom);
    expect(hits('ahb is a word here', setting)).toEqual([]);
    expect(hits('Abu Dhabi Commercial Bank', setting)).toEqual([
      { code: 'ADCB', partner: false },
    ]);
  });
});

/** A store whose account row carries `partnerBanks`. */
function storeWith(partnerBanks: PartnerBanksSetting | null): TsStore {
  const sw: AccountSwitches = { ...SWITCHES_UNMANAGED, partnerBanks };
  return {
    activePolicy: async () => null,
    insertDecision: async () => null,
    accountSwitches: async () => sw,
  };
}

describe('the checks use the account catalogue', () => {
  it('guardrail: FAB as a partner is not blocked, ENBD still is', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({ sim, store: storeWith(FAB_PARTNER) });
    const base = { customerMessage: 'Which bank?', evidence: [] };

    const fab = await layer.guardrail({
      ...base,
      botReply: 'We can open your account with FAB.',
    });
    expect(fab.reasonCodes).not.toContain('CODE_NON_PARTNER_BANK');
    expect(fab.outcome).toBe('send');
    expect(
      (sim.calls[0]!.body.state as { partner_banks: string[] }).partner_banks
    ).toEqual(['Mashreq', 'First Abu Dhabi Bank (FAB)']);

    const enbd = await layer.guardrail({
      ...base,
      botReply: 'We can open your account with Emirates NBD.',
    });
    expect(enbd.reasonCodes).toContain('CODE_NON_PARTNER_BANK');
    expect(enbd.outcome).toBe('block');
  });

  it('guardrail without a saved list: FAB is still blocked', async () => {
    const { layer } = makeLayer({ sim: makeSim(), store: storeWith(null) });
    const d = await layer.guardrail({
      customerMessage: 'Which bank?',
      evidence: [],
      botReply: 'We can open your account with FAB.',
    });
    expect(d.reasonCodes).toContain('CODE_NON_PARTNER_BANK');
  });

  it('triage: the non-partner dictionary hits follow the catalogue', async () => {
    const sim = makeSim();
    const partner = makeLayer({ sim, store: storeWith(FAB_PARTNER) }).layer;
    const message = 'I want a FAB account, or else Emirates NBD';
    const d = await partner.triage({ message, journeyStage: 'none' });
    expect(d.nonPartnerBank.banks).toEqual(['ENBD']);
    expect(
      (sim.calls[0]!.body.state as { partner_banks: string[] }).partner_banks
    ).toContain('First Abu Dhabi Bank (FAB)');

    const builtIn = makeLayer({ sim: makeSim(), store: storeWith(null) }).layer;
    const b = await builtIn.triage({ message, journeyStage: 'none' });
    expect(b.nonPartnerBank.banks.sort()).toEqual(['ENBD', 'FAB']);
  });

  it('ts.partners reads the cached account row', async () => {
    const { layer } = makeLayer({
      sim: makeSim(),
      store: storeWith(FAB_PARTNER),
    });
    expect((await layer.partners(TEST_ACCOUNT)).display).toContain(
      'First Abu Dhabi Bank (FAB)'
    );
    const unmanaged = makeLayer({ sim: makeSim() }).layer;
    expect((await unmanaged.partners(TEST_ACCOUNT)).display).toEqual(
      PARTNER_BANK_DISPLAY
    );
  });
});

/** Just enough of a Supabase client for accountSwitches. */
function fakeDb(
  respond: (columns: string) => { data: unknown; error: unknown }
) {
  const selects: string[] = [];
  const db = {
    from: () => ({
      select: (columns: string) => {
        selects.push(columns);
        const chain = {
          eq: () => chain,
          maybeSingle: async () => respond(columns),
        };
        return chain;
      },
    }),
  };
  return { db: db as unknown as SupabaseClient, selects };
}

const ROW = {
  enabled: true,
  mode: 'live',
  triage: true,
  guardrail: true,
  passages: false,
  watch_human_threads: true,
  languages: 'english',
};

describe('supabaseStore.accountSwitches and partner_banks', () => {
  it('reads and parses the column', async () => {
    const { db } = fakeDb(() => ({
      data: { ...ROW, partner_banks: { codes: ['fab'] } },
      error: null,
    }));
    const sw = await supabaseStore(db).accountSwitches!(TEST_ACCOUNT);
    expect(sw?.partnerBanks).toEqual({ codes: ['FAB'], custom: [] });
  });

  it('tolerates a database without the column (pre-078)', async () => {
    const { db, selects } = fakeDb((columns) =>
      columns.includes('partner_banks')
        ? {
            data: null,
            error: {
              code: '42703',
              message:
                'column ts_account_settings.partner_banks does not exist',
            },
          }
        : { data: ROW, error: null }
    );
    const sw = await supabaseStore(db).accountSwitches!(TEST_ACCOUNT);
    expect(selects).toHaveLength(2);
    expect(sw?.enabled).toBe(true);
    expect(sw?.partnerBanks).toBeNull();
  });

  it('still throws on any other read error', async () => {
    const { db } = fakeDb(() => ({
      data: null,
      error: { code: '57014', message: 'canceling statement' },
    }));
    await expect(
      supabaseStore(db).accountSwitches!(TEST_ACCOUNT)
    ).rejects.toThrow('canceling statement');
  });
});

describe('SwitchesStore.set and partner banks', () => {
  it('keeps the known partner banks when the saved row did not carry them', async () => {
    const switches = new SwitchesStore({ store: storeWith(FAB_PARTNER) });
    await switches.get(TEST_ACCOUNT);
    // The settings route's SETTINGS_COLUMNS has no partner_banks.
    switches.set(TEST_ACCOUNT, switchesFromRow(ROW));
    expect((await switches.get(TEST_ACCOUNT)).partnerBanks).toEqual(
      FAB_PARTNER
    );
    switches.set(
      TEST_ACCOUNT,
      switchesFromRow({ ...ROW, partner_banks: null })
    );
    expect((await switches.get(TEST_ACCOUNT)).partnerBanks).toBeNull();
  });
});

describe('gates: the account display list', () => {
  it('guardrailFeedback names the given partners, the built-ins by default', () => {
    expect(guardrailFeedback(['CODE_NON_PARTNER_BANK'])).toContain(
      PARTNER_BANK_DISPLAY.join(', ')
    );
    const custom = guardrailFeedback(
      ['CODE_NON_PARTNER_BANK'],
      ['First Abu Dhabi Bank (FAB)']
    );
    expect(custom).toContain('partner banks (First Abu Dhabi Bank (FAB))');
    expect(custom).not.toContain('Mashreq');
  });

  it('partnerBanksPromptLine lists the partners', () => {
    expect(partnerBanksPromptLine(['A', 'B', 'C'])).toBe(
      'The business works with these partner banks: A, B, C. Only discuss these banks.'
    );
    expect(partnerBanksPromptLine([])).toContain('no partner banks');
  });
});
