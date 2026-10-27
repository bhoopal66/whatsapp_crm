import { describe, expect, it } from 'vitest';

// The change-password dialog (Settings → Members) and its API route
// share this rule: at least 8 characters, at most bcrypt's 72 bytes.

import { MIN_PASSWORD_LENGTH } from './add-member';
import {
  MAX_PASSWORD_BYTES,
  passwordProblem,
  utf8ByteLength,
} from './member-password';

describe('passwordProblem', () => {
  it('wants a password', () => {
    expect(passwordProblem('')).toBe('required');
  });

  it('counts characters for the minimum', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(passwordProblem('a'.repeat(7))).toBe('tooShort');
    expect(passwordProblem('a'.repeat(8))).toBeNull();
    // Seven emoji are fourteen UTF-16 units but seven characters.
    expect(passwordProblem('🔑'.repeat(7))).toBe('tooShort');
    expect(passwordProblem('🔑'.repeat(8))).toBeNull();
  });

  it('counts UTF-8 bytes for the maximum', () => {
    expect(MAX_PASSWORD_BYTES).toBe(72);
    expect(passwordProblem('a'.repeat(72))).toBeNull();
    expect(passwordProblem('a'.repeat(73))).toBe('tooLong');
    // 36 two-byte letters fill bcrypt's 72 bytes; one more is too many.
    expect(utf8ByteLength('é'.repeat(36))).toBe(72);
    expect(passwordProblem('é'.repeat(36))).toBeNull();
    expect(passwordProblem('é'.repeat(37))).toBe('tooLong');
    // 18 four-byte emoji are 72 bytes.
    expect(passwordProblem('🔑'.repeat(18))).toBeNull();
    expect(passwordProblem('🔑'.repeat(19))).toBe('tooLong');
  });

  it('refuses a huge string as too long', () => {
    expect(passwordProblem('x'.repeat(1_000_000))).toBe('tooLong');
  });
});

describe("Add person's suggestion", () => {
  it('always passes the rule the dialog and route apply', async () => {
    const { suggestPassword } = await import('@/lib/workspaces/form');
    for (let i = 0; i < 200; i++) {
      expect(passwordProblem(suggestPassword())).toBeNull();
    }
  });
});
