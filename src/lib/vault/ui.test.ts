import { describe, expect, it } from 'vitest';

import {
  isVaultToken,
  parseAudit,
  parseVaultOverview,
  reasonLooksLikeIdentifier,
  vaultErrorKey,
} from './ui';

const TOKEN = 'vlt_' + 'kmnpqrstvwxyzghjkmnpqrstvw';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('parseVaultOverview', () => {
  it('reads a configured answer, super admins first then oldest grant', () => {
    const v = parseVaultOverview({
      configured: true,
      overview: {
        bootstrapAvailable: false,
        myRole: 'super_admin',
        roles: [
          {
            userId: U2,
            role: 'admin',
            grantedBy: U1,
            grantedAt: '2026-10-18T09:00:00.000Z',
            counts: false,
          },
          {
            userId: U1,
            role: 'super_admin',
            grantedBy: U1,
            grantedAt: '2026-10-18T10:00:00.000Z',
            counts: true,
          },
        ],
      },
    });
    expect(v).toEqual({
      configured: true,
      reason: null,
      bootstrapAvailable: false,
      myRole: 'super_admin',
      roles: [
        {
          userId: U1,
          role: 'super_admin',
          grantedBy: U1,
          grantedAt: '2026-10-18T10:00:00.000Z',
          counts: true,
        },
        {
          userId: U2,
          role: 'admin',
          grantedBy: U1,
          grantedAt: '2026-10-18T09:00:00.000Z',
          counts: false,
        },
      ],
    });
  });

  it('keeps a known reason and reads any other as UNAVAILABLE', () => {
    const base = { overview: { bootstrapAvailable: true, myRole: null } };
    expect(
      parseVaultOverview({ ...base, configured: false, reason: 'INVALID_KEYS' })
        ?.reason
    ).toBe('INVALID_KEYS');
    expect(
      parseVaultOverview({ ...base, configured: false, reason: 'x' })?.reason
    ).toBe('UNAVAILABLE');
    expect(parseVaultOverview({ ...base, configured: false })?.reason).toBe(
      'UNAVAILABLE'
    );
  });

  it('fails closed on odd fields', () => {
    const v = parseVaultOverview({
      configured: true,
      overview: {
        bootstrapAvailable: 'true',
        myRole: 'owner',
        roles: [
          { userId: U1, role: 'root' },
          { role: 'admin' },
          null,
          { userId: U2, role: 'admin', counts: 'yes', grantedAt: 'nope' },
        ],
      },
    });
    expect(v?.bootstrapAvailable).toBe(false);
    expect(v?.myRole).toBeNull();
    expect(v?.roles).toEqual([
      {
        userId: U2,
        role: 'admin',
        grantedBy: null,
        grantedAt: null,
        counts: false,
      },
    ]);
  });

  it('is null for an answer of another shape', () => {
    expect(parseVaultOverview(null)).toBeNull();
    expect(parseVaultOverview({ configured: true })).toBeNull();
    expect(parseVaultOverview({ overview: {} })).toBeNull();
    expect(parseVaultOverview([])).toBeNull();
  });
});

describe('parseAudit', () => {
  it('reads rows newest first, with the role target and refusal reason', () => {
    const rows = parseAudit({
      rows: [
        {
          id: '1',
          at: '2026-10-18T09:00:00.000Z',
          action: 'role_grant',
          outcome: 'OK',
          actor: U1,
          accountId: 'acc',
          token: null,
          kind: null,
          subjectType: null,
          subjectId: null,
          reason: null,
          detail: { changed: true, user_id: U2, role: 'admin' },
        },
        {
          id: '2',
          at: '2026-10-18T10:00:00.000Z',
          action: 'reveal',
          outcome: 'DENIED',
          actor: U2,
          token: TOKEN,
          kind: 'EID',
          reason: 'checking identity',
          detail: { why: 'NO_ROLE' },
        },
      ],
    });
    expect(rows?.map((r) => r.id)).toEqual(['2', '1']);
    expect(rows?.[0]).toMatchObject({
      action: 'reveal',
      outcome: 'DENIED',
      token: TOKEN,
      kind: 'EID',
      why: 'NO_ROLE',
      targetUserId: null,
    });
    expect(rows?.[1]).toMatchObject({
      targetUserId: U2,
      targetRole: 'admin',
      why: null,
    });
  });

  it('drops rows without id, action or outcome; null without rows', () => {
    expect(parseAudit({ rows: [{ id: '1', action: 'reveal' }, 7] })).toEqual(
      []
    );
    expect(parseAudit({})).toBeNull();
    expect(parseAudit(null)).toBeNull();
  });
});

describe('isVaultToken', () => {
  it('accepts the token shape only', () => {
    expect(isVaultToken(TOKEN)).toBe(true);
    expect(isVaultToken(` ${TOKEN}`)).toBe(false);
    expect(isVaultToken(TOKEN.slice(0, -1))).toBe(false);
    expect(isVaultToken(`${TOKEN}g`)).toBe(false);
    // Digits, vowels and capitals are outside the alphabet.
    expect(isVaultToken('vlt_' + '1'.repeat(26))).toBe(false);
    expect(isVaultToken('vlt_' + 'a'.repeat(26))).toBe(false);
    expect(isVaultToken('VLT_' + 'k'.repeat(26))).toBe(false);
  });
});

describe('reasonLooksLikeIdentifier', () => {
  it('lets a plain reason through', () => {
    expect(reasonLooksLikeIdentifier('Confirming identity on a call')).toBe(
      false
    );
    expect(reasonLooksLikeIdentifier('Call on 18 Oct at 3pm, ticket 42')).toBe(
      false
    );
    expect(reasonLooksLikeIdentifier('room 123456')).toBe(false);
  });

  it('flags 12+ digits in total', () => {
    expect(reasonLooksLikeIdentifier('ref 12 34 56, case 78 90 12')).toBe(true);
    expect(reasonLooksLikeIdentifier('ref 12 34 56, case 78 90 1')).toBe(false);
  });

  it('flags a 7-digit run once separators are removed', () => {
    expect(reasonLooksLikeIdentifier('account 123-4567')).toBe(true);
    expect(reasonLooksLikeIdentifier('date 2026-10-18')).toBe(true);
    expect(reasonLooksLikeIdentifier('123 456')).toBe(false);
  });

  it('flags a passport-like token and an AE IBAN prefix', () => {
    expect(reasonLooksLikeIdentifier('passport Z - 654321')).toBe(true);
    expect(reasonLooksLikeIdentifier('iban AE07')).toBe(true);
    expect(reasonLooksLikeIdentifier('iban ae 07')).toBe(true);
  });

  it('folds Arabic-Indic and fullwidth digits, refuses other scripts', () => {
    expect(reasonLooksLikeIdentifier('رقم ١٢٣٤٥٦٧')).toBe(true);
    expect(reasonLooksLikeIdentifier('ref １２３４５６７')).toBe(true);
    expect(reasonLooksLikeIdentifier('ref ४')).toBe(true);
  });
});

describe('vaultErrorKey', () => {
  it('maps the codes first', () => {
    expect(vaultErrorKey(503, 'VAULT_NOT_CONFIGURED')).toBe('notConfigured');
    expect(vaultErrorKey(409, 'ROLE_DENIED')).toBe('roleDenied');
    expect(vaultErrorKey(409, 'BOOTSTRAP_DENIED')).toBe('bootstrapDenied');
    expect(vaultErrorKey(403, 'DENIED')).toBe('denied');
    expect(vaultErrorKey(404, 'NOT_FOUND')).toBe('notFound');
    expect(vaultErrorKey(429, 'RATE_LIMITED')).toBe('rateLimited');
    expect(vaultErrorKey(409, 'DECRYPT_FAILED')).toBe('decryptFailed');
  });

  it('falls back to the status', () => {
    expect(vaultErrorKey(503, undefined)).toBe('notConfigured');
    expect(vaultErrorKey(403, undefined)).toBe('denied');
    expect(vaultErrorKey(400, undefined)).toBe('reasonRefused');
    expect(vaultErrorKey(429, null)).toBe('rateLimited');
    expect(vaultErrorKey(500, 'WHATEVER')).toBe('failed');
    expect(vaultErrorKey(0, undefined)).toBe('failed');
  });
});
