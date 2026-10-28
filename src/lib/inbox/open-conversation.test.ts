import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationListItem } from '@/lib/inbox/conversations';
import type { Contact, Conversation } from '@/types';
import {
  applyActiveAvatars,
  applyFullRow,
  FULL_ROW_RETRY_DELAYS_MS,
  openConversation,
  patchActiveChat,
  rereadFullRow,
  type ActiveChat,
  type OpenTicket,
} from './open-conversation';

function listRow(id: string): ConversationListItem {
  return {
    id,
    user_id: 'u1',
    assigned_agent_id: undefined,
    last_message_text: 'hi',
    last_message_at: '2026-10-28T10:00:00Z',
    unread_count: 2,
    updated_at: '2026-10-28T10:00:00Z',
    channel_id: null,
    send_channel_id: null,
    chat_tag_id: null,
    chat_sub_tag_id: null,
    campaign_broadcast_id: null,
    human_engaged_at: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
    ai_attention_at: null,
    contact: {
      id: `contact-${id}`,
      name: 'Amal',
      phone: '971500000000',
      company: undefined,
      avatar_url: undefined,
    },
  } as ConversationListItem;
}

function fullRow(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    ...listRow(id),
    contact_id: `contact-${id}`,
    status: 'open',
    created_at: '2026-10-01T00:00:00Z',
    ai_pending_draft: 'Held draft',
    contact: {
      ...listRow(id).contact,
      user_id: 'u1',
      account_id: 'a1',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      do_not_contact_at: '2026-10-02T00:00:00Z',
    } as Contact,
    ...extra,
  } as Conversation;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The page's state, driven through the same updaters it uses. */
function harness() {
  let active: ActiveChat | null = null;
  const pending = new Map<
    string,
    ReturnType<typeof deferred<Conversation | null>>
  >();
  const shows: ActiveChat[] = [];
  const failures: string[] = [];
  const deps = {
    latest: { current: null as OpenTicket | null },
    show: (chat: ActiveChat) => {
      shows.push(chat);
      active = chat;
    },
    upgrade: (full: Conversation) => {
      active = applyFullRow(active, full);
    },
    fetchFull: vi.fn((id: string) => {
      const d = deferred<Conversation | null>();
      pending.set(id, d);
      return d.promise;
    }),
    failed: (id: string) => {
      failures.push(id);
    },
  };
  return {
    deps,
    shows,
    failures,
    pending,
    get active() {
      return active;
    },
  };
}

describe('openConversation', () => {
  it('shows the list row at once and reads the full row in parallel', () => {
    const h = harness();
    const row = listRow('a');
    // Not awaited: the full row is still in flight.
    void openConversation('a', row, h.deps);
    // The thread is already open on the list row, so its own messages
    // read can start now, and the full-row read has been asked for in
    // the same tick rather than ahead of the thread.
    expect(h.active).toEqual({ full: false, row });
    expect(h.deps.fetchFull).toHaveBeenCalledWith('a');
  });

  it('replaces the list row with the full row when it lands', async () => {
    const h = harness();
    const open = openConversation('a', listRow('a'), h.deps);
    const full = fullRow('a');
    h.pending.get('a')!.resolve(full);
    await open;
    expect(h.active).toEqual({ full: true, row: full });
    // One show: the upgrade is not a new open (messages are not cleared).
    expect(h.shows).toHaveLength(1);
  });

  it('never lets a slow full row land on a chat picked since', async () => {
    const h = harness();
    const openA = openConversation('a', listRow('a'), h.deps);
    const openB = openConversation('b', listRow('b'), h.deps);
    h.pending.get('a')!.resolve(fullRow('a'));
    await openA;
    expect(h.active).toEqual({ full: false, row: listRow('b') });
    const fullB = fullRow('b');
    h.pending.get('b')!.resolve(fullB);
    await openB;
    expect(h.active).toEqual({ full: true, row: fullB });
  });

  it('without a list row opens on the full row once read', async () => {
    const h = harness();
    const open = openConversation('a', undefined, h.deps);
    expect(h.active).toBeNull();
    const full = fullRow('a');
    h.pending.get('a')!.resolve(full);
    await open;
    expect(h.active).toEqual({ full: true, row: full });
  });

  it('without a list row does not open over a later pick', async () => {
    const h = harness();
    const openA = openConversation('a', undefined, h.deps);
    void openConversation('b', listRow('b'), h.deps);
    h.pending.get('a')!.resolve(fullRow('a'));
    await openA;
    expect(h.active).toEqual({ full: false, row: listRow('b') });
  });
});

describe('openConversation retries a missed full row', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Resolves the read in flight for `id` and lets the loop move on. */
  async function miss(h: ReturnType<typeof harness>, id: string) {
    h.pending.get(id)!.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
  }

  it('retries after each backoff, then reports failed and stops', async () => {
    vi.useFakeTimers();
    const h = harness();
    const open = openConversation('a', listRow('a'), h.deps);
    await miss(h, 'a');
    // The list row stays open meanwhile.
    expect(h.active).toEqual({ full: false, row: listRow('a') });
    for (const [i, delay] of FULL_ROW_RETRY_DELAYS_MS.entries()) {
      expect(h.deps.fetchFull).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.deps.fetchFull).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.deps.fetchFull).toHaveBeenCalledTimes(i + 2);
      expect(h.failures).toEqual([]);
      await miss(h, 'a');
    }
    await open;
    expect(h.failures).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.fetchFull).toHaveBeenCalledTimes(
      FULL_ROW_RETRY_DELAYS_MS.length + 1
    );
  });

  it('a retry that reads the row upgrades the chat', async () => {
    vi.useFakeTimers();
    const h = harness();
    const open = openConversation('a', listRow('a'), h.deps);
    await miss(h, 'a');
    await vi.advanceTimersByTimeAsync(FULL_ROW_RETRY_DELAYS_MS[0]);
    const full = fullRow('a');
    h.pending.get('a')!.resolve(full);
    await open;
    expect(h.active).toEqual({ full: true, row: full });
    expect(h.failures).toEqual([]);
  });

  it('stops retrying once another chat is opened', async () => {
    vi.useFakeTimers();
    const h = harness();
    void openConversation('a', listRow('a'), h.deps);
    await miss(h, 'a');
    void openConversation('b', listRow('b'), h.deps);
    h.pending.get('b')!.resolve(fullRow('b'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.fetchFull.mock.calls).toEqual([['a'], ['b']]);
    expect(h.failures).toEqual([]);
  });

  it('stops retrying once the chat is closed', async () => {
    vi.useFakeTimers();
    const h = harness();
    void openConversation('a', listRow('a'), h.deps);
    await miss(h, 'a');
    // handleCloseConversation clears the ticket.
    h.deps.latest.current = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.fetchFull).toHaveBeenCalledTimes(1);
    expect(h.failures).toEqual([]);
  });

  it('a re-read of the open list row reads now and supersedes the old retries', async () => {
    vi.useFakeTimers();
    const h = harness();
    void openConversation('a', listRow('a'), h.deps);
    await miss(h, 'a');
    // The agent re-clicks before the first backoff has run out.
    void rereadFullRow('a', h.deps);
    expect(h.deps.fetchFull).toHaveBeenCalledTimes(2);
    expect(h.shows).toHaveLength(1);
    await miss(h, 'a');
    // One loop left: its first backoff, not two loops' worth of reads.
    await vi.advanceTimersByTimeAsync(FULL_ROW_RETRY_DELAYS_MS[0]);
    expect(h.deps.fetchFull).toHaveBeenCalledTimes(3);
    const full = fullRow('a');
    h.pending.get('a')!.resolve(full);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.active).toEqual({ full: true, row: full });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.fetchFull).toHaveBeenCalledTimes(3);
  });

  it('a re-read after giving up reads again', async () => {
    vi.useFakeTimers();
    const h = harness();
    const open = openConversation('a', listRow('a'), h.deps);
    await miss(h, 'a');
    for (const delay of FULL_ROW_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
      await miss(h, 'a');
    }
    await open;
    expect(h.failures).toEqual(['a']);
    const reread = rereadFullRow('a', h.deps);
    const full = fullRow('a');
    h.pending.get('a')!.resolve(full);
    await reread;
    expect(h.active).toEqual({ full: true, row: full });
  });
});

describe('a duplicate read of one chat', () => {
  it('drops the older read even when it lands last, after a patch', async () => {
    const h = harness();
    void openConversation('a', listRow('a'), h.deps);
    const read1 = h.pending.get('a')!;
    // A second read of the same chat (re-read) while the first is out.
    void rereadFullRow('a', h.deps);
    const read2 = h.pending.get('a')!;
    expect(read2).not.toBe(read1);
    const newer = fullRow('a', { last_message_text: 'second' });
    read2.resolve(newer);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.active).toEqual({ full: true, row: newer });
    // Realtime moves the chat on; then the older snapshot finally lands.
    const patched = patchActiveChat(h.active, 'a', {
      channel_id: 'ch-2',
      unread_count: 3,
    });
    h.deps.show(patched!);
    read1.resolve(fullRow('a', { last_message_text: 'first' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.active).toEqual(patched);
  });
});

describe('applyFullRow', () => {
  it('never replaces a chat that already has its full row', () => {
    const prev: ActiveChat = {
      full: true,
      row: fullRow('a', { channel_id: 'ch-2' }),
    };
    expect(applyFullRow(prev, fullRow('a', { channel_id: 'ch-1' }))).toBe(prev);
  });

  it('upgrades the same chat and leaves any other untouched', () => {
    const prev: ActiveChat = { full: false, row: listRow('a') };
    expect(applyFullRow(prev, fullRow('a'))).toEqual({
      full: true,
      row: fullRow('a'),
    });
    expect(applyFullRow(prev, fullRow('b'))).toBe(prev);
    expect(applyFullRow(null, fullRow('a'))).toBeNull();
  });
});

describe('a late full row and newer patches', () => {
  it('keeps fields patched after the open over an older full row', () => {
    // Opened on the list row; the full-row snapshot is taken now.
    const snapshot = fullRow('a', {
      ai_pending_draft: 'Held draft',
      ai_handoff_summary: 'Asked for a person',
    });
    let active: ActiveChat | null = { full: false, row: listRow('a') };
    // A realtime UPDATE lands before the full row does.
    active = patchActiveChat(active, 'a', {
      channel_id: 'ch-2',
      unread_count: 5,
      last_message_text: 'newer',
      last_message_at: '2026-10-28T10:05:00Z',
      updated_at: '2026-10-28T10:05:00Z',
    });
    // A save's result, which carries no updated_at.
    active = patchActiveChat(active, 'a', { chat_tag_id: 'tag-1' });
    active = applyFullRow(active, snapshot);
    expect(active?.full).toBe(true);
    const row = active!.row as Conversation;
    expect(row.channel_id).toBe('ch-2');
    expect(row.unread_count).toBe(5);
    expect(row.last_message_text).toBe('newer');
    expect(row.chat_tag_id).toBe('tag-1');
    expect(row.updated_at).toBe('2026-10-28T10:05:00Z');
    // The full-only fields still arrive from the full row.
    expect(row.ai_pending_draft).toBe('Held draft');
    expect(row.ai_handoff_summary).toBe('Asked for a person');
    expect(row.contact).toBe(snapshot.contact);
    expect(row.status).toBe('open');
  });

  it('later patches win over earlier ones', () => {
    let active: ActiveChat | null = { full: false, row: listRow('a') };
    active = patchActiveChat(active, 'a', { unread_count: 5 });
    active = patchActiveChat(active, 'a', { unread_count: 0 });
    active = applyFullRow(active, fullRow('a', { unread_count: 3 }));
    expect(active?.row.unread_count).toBe(0);
  });

  it('keeps the patches across a profile-picture update', () => {
    let active: ActiveChat | null = { full: false, row: listRow('a') };
    active = patchActiveChat(active, 'a', { channel_id: 'ch-2' });
    active = applyActiveAvatars(active, { 'contact-a': 'https://x/p.jpg' });
    active = applyFullRow(active, fullRow('a'));
    expect(active?.row.channel_id).toBe('ch-2');
  });
});

describe('patchActiveChat', () => {
  it('keeps a full row full and its full contact', () => {
    const full = fullRow('a');
    const prev: ActiveChat = { full: true, row: full };
    const next = patchActiveChat(prev, 'a', {
      unread_count: 0,
      // A list row's narrow contact must not replace the full one.
      contact: listRow('a').contact as Contact,
    });
    expect(next?.full).toBe(true);
    expect(next?.row.unread_count).toBe(0);
    expect(next?.row.contact).toBe(full.contact);
    expect((next?.row as Conversation).ai_pending_draft).toBe('Held draft');
  });

  it('does not upgrade a list row', () => {
    const prev: ActiveChat = { full: false, row: listRow('a') };
    const next = patchActiveChat(prev, 'a', { ai_pending_draft: 'x' });
    expect(next?.full).toBe(false);
  });

  it('leaves another chat as the same reference', () => {
    const prev: ActiveChat = { full: true, row: fullRow('a') };
    expect(patchActiveChat(prev, 'b', { unread_count: 0 })).toBe(prev);
  });
});

describe('applyActiveAvatars', () => {
  it('sets the picture and keeps `full`', () => {
    const prev: ActiveChat = { full: true, row: fullRow('a') };
    const next = applyActiveAvatars(prev, { 'contact-a': 'https://x/p.jpg' });
    expect(next?.full).toBe(true);
    expect(next?.row.contact?.avatar_url).toBe('https://x/p.jpg');
    expect(applyActiveAvatars(prev, { other: 'y' })).toBe(prev);
  });
});
