import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('./tag-write', () => ({
  addContactTagIfAbsent: mocks.add,
}));

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: mocks.dispatch,
}));

import { addContactTagAndDispatch } from './tag-events';

const base = {
  db: {} as never,
  accountId: 'account-1',
  contactId: 'contact-1',
  tagId: 'tag-1',
};

beforeEach(() => {
  mocks.add.mockReset();
  mocks.dispatch.mockReset();
});

describe('addContactTagAndDispatch', () => {
  it('writes a new tag without dispatching any automation (tag_added is retired)', async () => {
    mocks.add.mockResolvedValue(true);

    const result = await addContactTagAndDispatch({
      ...base,
      context: { vars: { source: 'flow' } },
    });

    expect(result).toEqual({ added: true, dispatched: false });
    expect(mocks.add).toHaveBeenCalledWith(base.db, {
      accountId: 'account-1',
      contactId: 'contact-1',
      tagId: 'tag-1',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('reports a tag that already exists as a duplicate', async () => {
    mocks.add.mockResolvedValue(false);

    await expect(addContactTagAndDispatch(base)).resolves.toEqual({
      added: false,
      dispatched: false,
      reason: 'duplicate',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
