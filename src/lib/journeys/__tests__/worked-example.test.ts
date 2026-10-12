import { describe, expect, it } from 'vitest';
import { Sim, adv, btn, clone, dxb, media, posToDocs } from './helpers';

const SOURCE_TEMPLATES = [
  'welcome_menu',
  'pos_pitch_in_window',
  'pos_rate_comparison',
  'pos_docs_request',
  'pos_application_status',
  'pos_delivery_scheduled',
  'pos_activated_thankyou',
];

/** Source worked example: POS switch lead. DOCS_COMPLETE time is not in the source; Day 3 10:00 (> 24h after Day 2 media). */
function replay(sim: Sim, freeEntry = false): Sim {
  posToDocs(sim, 1, ['10:14', '10:15', '10:16', '15:40', '16:02'], freeEntry);
  return sim
    .ev(
      media(dxb(2, '09:20')),
      adv('DOCS_COMPLETE', dxb(3, '10:00')),
      adv('PARTNER_APPROVED', dxb(5, '11:00')),
      adv('FULFILMENT_SCHEDULED', dxb(6, '10:00')),
      btn('CONFIRM', dxb(6, '10:30'))
    )
    .runUntil(dxb(8, '12:00'));
}

describe('worked example — POS switch lead via QR (24h window, D-016-5)', () => {
  it('ends WON with exactly the source templates and 3 billable UTILITY sends', () => {
    const sim = replay(new Sim());
    expect(sim.file.state).toBe('WON');
    expect(sim.file.outcome).toEqual({ kind: 'WON', reason: 'CONVERTED' });
    expect(sim.sends().map((s) => s.template)).toEqual(SOURCE_TEMPLATES);
    const billable = sim.sends().filter((s) => s.billable);
    expect(billable.map((s) => s.template)).toEqual([
      'pos_application_status',
      'pos_delivery_scheduled',
      'pos_activated_thankyou',
    ]);
    expect(billable.every((s) => s.category === 'UTILITY')).toBe(true);
    expect(sim.sends().at(-1)!.at).toBe(dxb(8, '10:30'));
    expect(sim.log.filter((x) => x.action.type === 'LOG_COST')).toHaveLength(3);
    expect(sim.file.counters.paidSends).toBe(3);
  });
  it('variant: thank-you within 24h of CONFIRM → 2 billable', () => {
    const d = clone();
    d.states.WON!.timers![0]!.after = '12h';
    const sim = replay(new Sim(d));
    expect(sim.sends().map((s) => s.template)).toEqual(SOURCE_TEMPLATES);
    expect(
      sim
        .sends()
        .filter((s) => s.billable)
        .map((s) => s.template)
    ).toEqual(['pos_application_status', 'pos_delivery_scheduled']);
  });
  it('variant: Click-to-WhatsApp entry (freeEntry) → every send inside the first 72h is free', () => {
    const sim = replay(new Sim(), true);
    const until = Date.parse(dxb(4, '10:14'));
    const inside = sim.sends().filter((s) => Date.parse(s.at) < until);
    expect(inside.map((s) => s.template)).toContain('pos_application_status');
    expect(inside.every((s) => !s.billable)).toBe(true);
    expect(
      sim
        .sends()
        .filter((s) => s.billable)
        .map((s) => s.template)
    ).toEqual(['pos_delivery_scheduled', 'pos_activated_thankyou']);
  });
});
