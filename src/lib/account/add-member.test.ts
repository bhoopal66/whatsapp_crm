import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// One email field, two operations (migration 083): an existing login is
// added by `add_workspace_member` with no password, an unknown email is
// created as a new login and moved in by `provision_account_member`.
// These pin which branch runs, and that a login banned by an earlier
// deactivation everywhere can sign in again once it is added.

import {
  addOrCreateMember,
  EMAIL_HAS_LOGIN,
  INVITE_BY_LINK,
  isAddableRole,
} from './add-member';

const callerRpc = vi.fn();
const adminRpc = vi.fn();
const createUser = vi.fn();
const deleteUser = vi.fn();
const getUserById = vi.fn();
const updateUserById = vi.fn();

const supabase = { rpc: callerRpc } as unknown as SupabaseClient;
const admin = {
  rpc: adminRpc,
  auth: { admin: { createUser, deleteUser, getUserById, updateUserById } },
} as unknown as SupabaseClient;

const NO_SUCH_USER = { code: 'P0002', message: 'no_such_user' };

function add(overrides: Record<string, unknown> = {}) {
  return addOrCreateMember({
    supabase,
    admin,
    accountId: 'account-1',
    email: ' Ana@Example.com ',
    role: 'agent',
    mayCreateLogin: true,
    ...overrides,
  });
}

describe('addOrCreateMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callerRpc.mockResolvedValue({ data: 'ana', error: null });
    adminRpc.mockResolvedValue({ error: null });
    createUser.mockResolvedValue({
      data: { user: { id: 'new' } },
      error: null,
    });
    deleteUser.mockResolvedValue({ error: null });
    getUserById.mockResolvedValue({
      data: { user: { id: 'ana' } },
      error: null,
    });
    updateUserById.mockResolvedValue({ error: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('adds an existing login without a password', async () => {
    expect(await add()).toEqual({ ok: true, userId: 'ana', created: false });
    expect(callerRpc).toHaveBeenCalledWith('add_workspace_member', {
      p_email: 'ana@example.com',
      p_role: 'agent',
      p_bank_code: null,
    });
    expect(createUser).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('passes a guest’s bank code trimmed', async () => {
    await add({ role: 'bank_guest', bankCode: ' ENBD ' });
    expect(callerRpc).toHaveBeenCalledWith('add_workspace_member', {
      p_email: 'ana@example.com',
      p_role: 'bank_guest',
      p_bank_code: 'ENBD',
    });
  });

  it('lifts the ban a deactivation everywhere left on the login', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: 'ana', banned_until: '2126-01-01T00:00:00Z' } },
      error: null,
    });
    expect(await add()).toMatchObject({ ok: true, created: false });
    expect(updateUserById).toHaveBeenCalledWith('ana', {
      ban_duration: 'none',
    });
  });

  it('leaves a ban that has already expired alone', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: 'ana', banned_until: '2020-01-01T00:00:00Z' } },
      error: null,
    });
    await add();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('lifts any ban when the login cannot be read', async () => {
    getUserById.mockResolvedValue({
      data: { user: null },
      error: { message: 'x' },
    });
    expect(await add()).toMatchObject({ ok: true });
    expect(updateUserById).toHaveBeenCalledWith('ana', {
      ban_duration: 'none',
    });
  });

  it('removes the person again when the ban cannot be lifted', async () => {
    getUserById.mockResolvedValue({
      data: { user: { id: 'ana', banned_until: '2126-01-01T00:00:00Z' } },
      error: null,
    });
    updateUserById.mockResolvedValue({ error: { message: 'boom' } });
    callerRpc.mockImplementation(async (fn: string) =>
      fn === 'add_workspace_member'
        ? { data: 'ana', error: null }
        : { data: null, error: null }
    );

    const result = await add();

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(callerRpc).toHaveBeenLastCalledWith('remove_account_member', {
      p_user_id: 'ana',
    });
  });

  it('creates a login for an unknown email and provisions it', async () => {
    callerRpc.mockResolvedValue({ data: null, error: NO_SUCH_USER });
    const result = await add({
      role: 'bank_guest',
      bankCode: 'ENBD',
      password: 'correct-horse',
      fullName: ' Gus ',
    });

    expect(result).toEqual({ ok: true, userId: 'new', created: true });
    expect(createUser).toHaveBeenCalledWith({
      email: 'ana@example.com',
      password: 'correct-horse',
      email_confirm: true,
      user_metadata: { full_name: 'Gus' },
    });
    expect(adminRpc).toHaveBeenCalledWith('provision_account_member', {
      p_user_id: 'new',
      p_account_id: 'account-1',
      p_role: 'bank_guest',
      p_bank_code: 'ENBD',
    });
  });

  it.each([
    [
      'its wording',
      { message: 'A user with this email address has already been registered' },
    ],
    [
      'its code',
      { message: 'Email address taken', code: 'email_exists', status: 422 },
    ],
  ])(
    'answers one fixed conflict, never GoTrue’s text, for a registered address the RPC refused (%s)',
    async (_, gotrueError) => {
      callerRpc.mockResolvedValue({ data: null, error: NO_SUCH_USER });
      createUser.mockResolvedValue({
        data: { user: null },
        error: gotrueError,
      });
      const result = await add({ password: 'correct-horse' });

      expect(result).toEqual({
        ok: false,
        status: 409,
        error: EMAIL_HAS_LOGIN,
      });
      expect(adminRpc).not.toHaveBeenCalled();
      expect(deleteUser).not.toHaveBeenCalled();
    }
  );

  // Migration 099: a team leader adds people but never creates a login,
  // whose password they would choose. The RPC no longer says P0002 to a
  // leader; this holds even if it did.
  it('never creates a login for a caller who may not', async () => {
    callerRpc.mockResolvedValue({ data: null, error: NO_SUCH_USER });
    const result = await add({
      mayCreateLogin: false,
      password: 'correct-horse',
    });
    expect(result).toEqual({ ok: false, status: 403, error: INVITE_BY_LINK });
    expect(createUser).not.toHaveBeenCalled();
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it('adds an existing login for a caller who may not create one', async () => {
    const result = await add({ mayCreateLogin: false });
    expect(result).toEqual({ ok: true, userId: 'ana', created: false });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('asks for a password only when the login has to be created', async () => {
    callerRpc.mockResolvedValue({ data: null, error: NO_SUCH_USER });
    const result = await add({ password: 'short' });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('deletes the new login when the move into the account fails', async () => {
    callerRpc.mockResolvedValue({ data: null, error: NO_SUCH_USER });
    adminRpc.mockResolvedValue({ error: { message: 'boom' } });
    const result = await add({ password: 'correct-horse' });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(deleteUser).toHaveBeenCalledWith('new');
  });

  it.each([
    ['23505', 'That person is already a member of this workspace', 409],
    ['22023', 'A bank guest needs a bank code', 400],
    ['42501', 'This action requires the admin role or higher', 403],
  ])('maps SQLSTATE %s to %#', async (code, message, status) => {
    callerRpc.mockResolvedValue({ data: null, error: { code, message } });
    expect(await add()).toEqual({ ok: false, status, error: message });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('treats only no_such_user as an unknown email', async () => {
    callerRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: 'something else' },
    });
    expect(await add({ password: 'correct-horse' })).toMatchObject({
      ok: false,
      status: 500,
    });
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe('isAddableRole', () => {
  it('accepts staff roles and the bank guest, never the owner', () => {
    expect(
      ['admin', 'team_leader', 'agent', 'viewer', 'bank_guest'].every(
        isAddableRole
      )
    ).toBe(true);
    expect(isAddableRole('owner')).toBe(false);
    expect(isAddableRole(undefined)).toBe(false);
  });
});
