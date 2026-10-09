import { describe, expect, it } from 'vitest';

import {
  agentTileStatus,
  autoReplyDot,
  autoReplyScopeMessage,
  partnerBankCount,
  safetyDot,
  summariseAgentOverview,
} from './agent-overview';

const numbers = [
  { id: 'n1', name: 'Sales', isPrimary: true },
  { id: 'n2', name: 'Support', isPrimary: false },
];

const on = { isActive: true, autoReplyEnabled: true, replyOnAllNumbers: false };

describe('summariseAgentOverview', () => {
  it('reports every number when the bot replies everywhere', () => {
    const o = summariseAgentOverview({
      configured: true,
      saved: { ...on, replyOnAllNumbers: true },
      aiReplyRoute: 'n2',
      numbers,
    });
    expect(o.autoReply).toEqual({ on: true, scope: { kind: 'all' } });
  });

  it('names the routed number, else the default one and its kind', () => {
    const routed = summariseAgentOverview({
      configured: true,
      saved: on,
      aiReplyRoute: 'n2',
      numbers,
    });
    expect(routed.autoReply.scope).toEqual({ kind: 'only', name: 'Support' });

    const byDefault = summariseAgentOverview({
      configured: true,
      saved: on,
      aiReplyRoute: null,
      numbers,
    });
    // No explicit route: the bot follows the thread on every number of
    // the default number's provider, so this is not "only".
    expect(byDefault.autoReply.scope).toEqual({
      kind: 'default',
      name: 'Sales',
    });
  });

  it('has no name for the default number when none is primary', () => {
    const o = summariseAgentOverview({
      configured: true,
      saved: on,
      aiReplyRoute: null,
      numbers: [],
    });
    expect(o.autoReply.scope).toEqual({ kind: 'default', name: null });
  });

  it('shows the id of a routed number that is gone', () => {
    const o = summariseAgentOverview({
      configured: true,
      saved: on,
      aiReplyRoute: 'gone',
      numbers,
    });
    expect(o.autoReply.scope).toEqual({ kind: 'only', name: 'gone' });
  });

  it('words the scope', () => {
    expect(autoReplyScopeMessage({ kind: 'all' })).toEqual({
      key: 'overview.everyNumber',
    });
    expect(autoReplyScopeMessage({ kind: 'only', name: 'Support' })).toEqual({
      key: 'overview.onlyOn',
      values: { name: 'Support' },
    });
    expect(autoReplyScopeMessage({ kind: 'default', name: 'Sales' })).toEqual({
      key: 'overview.defaultAndOthers',
      values: { name: 'Sales' },
    });
    expect(autoReplyScopeMessage({ kind: 'default', name: null })).toEqual({
      key: 'overview.defaultAndOthersUnnamed',
    });
  });

  it('auto-reply is off while the assistant is off or not set up', () => {
    const inactive = summariseAgentOverview({
      configured: true,
      saved: { ...on, isActive: false },
      aiReplyRoute: null,
      numbers,
    });
    expect(inactive.assistant).toEqual({ configured: true, on: false });
    expect(inactive.autoReply.on).toBe(false);

    const unconfigured = summariseAgentOverview({
      configured: false,
      saved: on,
      aiReplyRoute: null,
      numbers,
    });
    expect(unconfigured.assistant).toEqual({ configured: false, on: false });
    expect(unconfigured.autoReply.on).toBe(false);
  });
});

describe('status dots', () => {
  it('auto-reply is green only when on', () => {
    const base = { configured: true, aiReplyRoute: null, numbers };
    expect(autoReplyDot(summariseAgentOverview({ ...base, saved: on }))).toBe(
      'green'
    );
    expect(
      autoReplyDot(
        summariseAgentOverview({
          ...base,
          saved: { ...on, autoReplyEnabled: false },
        })
      )
    ).toBeNull();
  });

  it('safety: green live, amber monitor or problem, none off', () => {
    expect(safetyDot('live')).toBe('green');
    expect(safetyDot('monitor')).toBe('amber');
    expect(safetyDot('problem')).toBe('amber');
    expect(safetyDot('off')).toBeNull();
    expect(safetyDot(null)).toBeNull();
  });
});

describe('partnerBankCount', () => {
  const catalogue = [
    { code: 'FAB', name: 'FAB', defaultPartner: true },
    { code: 'ADCB', name: 'ADCB', defaultPartner: true },
    { code: 'ENBD', name: 'Emirates NBD', defaultPartner: false },
  ];

  it('counts the built-in partners while the setting is null', () => {
    expect(partnerBankCount(null, catalogue)).toBe(2);
  });

  it('counts ticked codes plus custom banks', () => {
    expect(
      partnerBankCount(
        {
          codes: ['ENBD'],
          custom: [
            { name: 'A', aliases: [] },
            { name: 'B', aliases: [] },
          ],
        },
        catalogue
      )
    ).toBe(3);
  });

  it('is unknown without a catalogue', () => {
    expect(partnerBankCount(null, undefined)).toBeNull();
  });
});

describe('agentTileStatus', () => {
  const at = (
    configured: boolean,
    isActive: boolean,
    autoReplyEnabled: boolean
  ) =>
    agentTileStatus(
      summariseAgentOverview({
        configured,
        saved: { isActive, autoReplyEnabled, replyOnAllNumbers: false },
        aiReplyRoute: null,
        numbers,
      })
    );

  it('names the state the Settings Overview tile shows', () => {
    expect(at(false, true, true)).toBe('notSetup');
    expect(at(true, false, true)).toBe('aiOff');
    expect(at(true, true, false)).toBe('aiOn');
    expect(at(true, true, true)).toBe('aiAutoReply');
  });
});
