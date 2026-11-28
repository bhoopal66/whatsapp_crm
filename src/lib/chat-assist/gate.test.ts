import { describe, expect, it } from 'vitest';

import { ACCOUNT_ROLES, type AccountRole } from '@/lib/auth/roles';

import {
  CHAT_ASSIST_DEFAULT_ENABLED,
  canToggleChatAssist,
  chatAssistEnabledFrom,
  chatAssistGate,
  chatAssistRefusalBody,
} from './gate';

describe('chat assistant gate', () => {
  it('is off by default (no row, a malformed row, anything but true)', () => {
    expect(CHAT_ASSIST_DEFAULT_ENABLED).toBe(false);
    for (const row of [
      null,
      undefined,
      {},
      { enabled: 'true' },
      { enabled: 1 },
      { enabled: false },
    ])
      expect(chatAssistEnabledFrom(row)).toBe(false);
    expect(chatAssistEnabledFrom({ enabled: true })).toBe(true);
  });

  it('refuses everyone while the switch is off', () => {
    for (const role of ACCOUNT_ROLES) {
      const g = chatAssistGate({ role, enabled: false });
      expect(g.ok).toBe(false);
    }
    expect(chatAssistGate({ role: 'owner', enabled: false })).toEqual({
      ok: false,
      reason: 'off',
    });
  });

  it('is for agents and up while on', () => {
    const allowed: AccountRole[] = ['owner', 'admin', 'team_leader', 'agent'];
    for (const role of ACCOUNT_ROLES)
      expect(chatAssistGate({ role, enabled: true }).ok).toBe(
        allowed.includes(role)
      );
    expect(chatAssistGate({ role: 'viewer', enabled: true })).toEqual({
      ok: false,
      reason: 'role',
    });
    expect(chatAssistGate({ role: 'bank_guest', enabled: true })).toEqual({
      ok: false,
      reason: 'role',
    });
  });

  it('only an owner or admin turns the switch', () => {
    for (const role of ACCOUNT_ROLES)
      expect(canToggleChatAssist(role)).toBe(
        role === 'owner' || role === 'admin'
      );
  });

  it('words each refusal with its own code', () => {
    expect(chatAssistRefusalBody('off').code).toBe('chat_assist_off');
    expect(chatAssistRefusalBody('role').code).toBe('chat_assist_role');
  });
});
