import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { changeMyPassword, passwordChangeFailure } from './password-change';

afterEach(() => vi.unstubAllGlobals());

describe('changeMyPassword', () => {
  it('posts both passwords to our server', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await changeMyPassword('old', 'new')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'old', newPassword: 'new' }),
      })
    );
  });

  it('names each refusal', () => {
    expect(passwordChangeFailure(403, null).key).toBe(
      'currentPasswordIncorrect'
    );
    expect(passwordChangeFailure(422, null).key).toBe('passwordRefused');
    expect(passwordChangeFailure(429, null).key).toBe('passwordRateLimited');
    expect(passwordChangeFailure(503, null).key).toBe('passwordUnavailable');
    expect(passwordChangeFailure(0, null).key).toBe('passwordUnavailable');
    expect(passwordChangeFailure(423, { retryAfterSeconds: 61 })).toEqual({
      key: 'passwordLocked',
      minutes: 2,
    });
  });
});

// The password grant will be closed on the public Supabase URL.
describe('browser code', () => {
  const src = path.join(process.cwd(), 'src');
  const files = (fs.readdirSync(src, { recursive: true }) as string[]).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)
  );
  const using = (needle: string) =>
    files.filter((f) =>
      fs.readFileSync(path.join(src, f), 'utf8').includes(needle)
    );

  it('never checks a password or changes a login itself', () => {
    const server = /^app\/api\//;
    for (const call of ['.signInWithPassword(', 'auth.updateUser(']) {
      expect(using(call).filter((f) => !server.test(f))).toEqual([]);
    }
    expect(using('resetPasswordForEmail(')).toEqual([]);
  });

  it('shows the email in the profile form read-only, with the way to change it', () => {
    const form = fs.readFileSync(
      path.join(src, 'components/settings/profile-form.tsx'),
      'utf8'
    );
    const input = form.slice(form.indexOf('id="profile-email"'));
    expect(input.slice(0, input.indexOf('/>'))).toContain('readOnly');
    expect(form).toContain("t('emailReadOnly')");
  });
});
