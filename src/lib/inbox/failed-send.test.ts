import { describe, it, expect, vi } from 'vitest';

import type { Message } from '@/types';
import {
  forgetKeptUpload,
  isRetryableSendFailure,
  KEPT_UPLOADS_KEY,
  partitionRestoredDrafts,
  rememberKeptUpload,
  retryAttempt,
  sendFailureReason,
  shouldWarnMaybeSent,
  supersededBy,
  takeKeptUploads,
  type FailedSend,
} from './failed-send';

// What /api/whatsapp/send answers when the gateway refused the send.
const routeError = {
  error: 'WhatsApp API error: the number is logged out',
  code: 'whatsapp_error',
  retryable: true,
};
// …and when the gateway call failed in a way that may have delivered it.
const ambiguousError = {
  error: 'WhatsApp API error: Whapi request failed: timeout',
  code: 'whatsapp_error',
  retryable: false,
};

describe('isRetryableSendFailure', () => {
  it('offers Retry when the gateway refused the send (502 whatsapp_error)', () => {
    expect(isRetryableSendFailure(502, routeError)).toBe(true);
  });

  it('refuses a 502 the route did not mark retryable: it may have gone out', () => {
    // A timeout, a gateway 5xx, or an accepted send with no id back.
    expect(isRetryableSendFailure(502, ambiguousError)).toBe(false);
    // An older server that sends no flag is not trusted either.
    expect(isRetryableSendFailure(502, { error: routeError.error })).toBe(
      false
    );
    expect(
      isRetryableSendFailure(502, { ...routeError, retryable: 'yes' })
    ).toBe(false);
  });

  it.each([400, 401, 403, 404, 409, 429])(
    'offers Retry for a %i from the route: nothing reached the gateway',
    (status) => {
      expect(isRetryableSendFailure(status, { error: 'nope' })).toBe(true);
      // The 4xx rule does not depend on the flag.
      expect(
        isRetryableSendFailure(status, { error: 'nope', retryable: false })
      ).toBe(true);
    }
  );

  it('refuses a 500: db_error means it was sent but not saved', () => {
    expect(
      isRetryableSendFailure(500, {
        error:
          'The message was sent to WhatsApp but could not be saved. It will not appear in the conversation.',
      })
    ).toBe(false);
    expect(
      isRetryableSendFailure(500, { error: 'Internal server error' })
    ).toBe(false);
  });

  it.each([503, 504, 524])(
    'refuses a %i even with a JSON error: the send may have gone out',
    (status) => {
      expect(isRetryableSendFailure(status, routeError)).toBe(false);
    }
  );

  it('refuses a proxy-generated page (no route JSON), even as a 502', () => {
    // nginx / Cloudflare answer with HTML, so `res.json()` fails → null.
    expect(isRetryableSendFailure(502, null)).toBe(false);
    expect(isRetryableSendFailure(502, {})).toBe(false);
    expect(isRetryableSendFailure(502, { error: '' })).toBe(false);
    expect(isRetryableSendFailure(502, { error: 42 })).toBe(false);
    expect(isRetryableSendFailure(502, 'Bad Gateway')).toBe(false);
  });

  it('never treats a success as a failure', () => {
    expect(isRetryableSendFailure(200, routeError)).toBe(false);
    expect(isRetryableSendFailure(201, routeError)).toBe(false);
  });
});

describe('shouldWarnMaybeSent', () => {
  it('warns when there is no Retry because the send may have gone out', () => {
    expect(shouldWarnMaybeSent(502, ambiguousError)).toBe(true);
    expect(shouldWarnMaybeSent(502, null)).toBe(true);
    expect(shouldWarnMaybeSent(504, null)).toBe(true);
    expect(shouldWarnMaybeSent(500, { error: 'Internal server error' })).toBe(
      true
    );
  });

  it('does not warn when Retry is offered', () => {
    expect(shouldWarnMaybeSent(502, routeError)).toBe(false);
    expect(shouldWarnMaybeSent(403, { error: 'Forbidden' })).toBe(false);
  });

  it('does not warn when nothing can have gone out', () => {
    // A proxy's 4xx page: the request never reached the app.
    expect(shouldWarnMaybeSent(413, null)).toBe(false);
    expect(shouldWarnMaybeSent(429, '<html>Too Many Requests</html>')).toBe(
      false
    );
    expect(shouldWarnMaybeSent(403, null)).toBe(false);
    // A 500 the route raised before the gateway call.
    expect(
      shouldWarnMaybeSent(500, {
        error: 'Template row is malformed locally',
        code: 'template_malformed',
        retryable: true,
      })
    ).toBe(false);
  });

  it('does not warn for db_error, whose own words say it was sent', () => {
    expect(
      shouldWarnMaybeSent(500, {
        error:
          'The message was sent to WhatsApp but could not be saved. It will not appear in the conversation.',
        code: 'db_error',
        retryable: false,
      })
    ).toBe(false);
  });
});

describe('sendFailureReason', () => {
  it("uses the route's own words", () => {
    expect(sendFailureReason(502, routeError)).toBe(routeError.error);
  });

  it('falls back to the status without them', () => {
    expect(sendFailureReason(504, null)).toBe('HTTP 504');
    expect(sendFailureReason(502, { error: '' })).toBe('HTTP 502');
  });
});

const failedText = (over: Partial<FailedSend> = {}): FailedSend => ({
  conversationId: 'conv-1',
  reason: 'WhatsApp API error: refused',
  message: {
    id: 'temp-1',
    conversation_id: 'conv-1',
    sender_type: 'agent',
    content_type: 'text',
    content_text: 'hello',
    status: 'failed',
    created_at: '2026-09-29T10:41:04.000Z',
    reply_to_message_id: 'm-9',
  } as Message,
  body: {
    conversation_id: 'conv-1',
    message_type: 'text',
    content_text: 'hello',
    reply_to_message_id: 'm-9',
  },
  restoreText: 'hello',
  ...over,
});

describe('retryAttempt', () => {
  it('re-sends the identical body as a fresh sending bubble', () => {
    const failed = failedText();
    const now = new Date('2026-09-29T13:00:00.000Z');
    const attempt = retryAttempt(failed, 'temp-2', now);

    expect(attempt.body).toBe(failed.body);
    expect(attempt.message).toEqual({
      ...failed.message,
      id: 'temp-2',
      status: 'sending',
      created_at: '2026-09-29T13:00:00.000Z',
    });
    // Nothing of the failure's own bookkeeping rides along.
    expect(attempt).not.toHaveProperty('reason');
    expect(attempt).not.toHaveProperty('conversationId');
  });

  it('keeps the restore text and the upload for a second failure', () => {
    const attempt = retryAttempt(
      failedText({ uploadPath: 'account-1/1-photo.jpg' }),
      'temp-2'
    );
    expect(attempt.restoreText).toBe('hello');
    expect(attempt.uploadPath).toBe('account-1/1-photo.jpg');
  });

  it('does not mutate the failed entry', () => {
    const failed = failedText();
    retryAttempt(failed, 'temp-2');
    expect(failed.message.id).toBe('temp-1');
    expect(failed.message.status).toBe('failed');
  });
});

describe('supersededBy', () => {
  it('finds the failed text the same words in the same chat replace', () => {
    const a = failedText();
    const other = failedText({ conversationId: 'conv-2' });
    const different = failedText({ restoreText: 'bye' });
    const media = failedText({ restoreText: undefined });
    expect(
      supersededBy([a, other, different, media], 'conv-1', 'hello')
    ).toEqual([a]);
  });

  it('finds nothing for new words', () => {
    expect(supersededBy([failedText()], 'conv-1', 'hello again')).toEqual([]);
  });
});

describe('partitionRestoredDrafts', () => {
  const a1 = {
    conversationId: 'conv-a',
    text: 'Your refund of AED 500 is approved',
  };
  const a2 = { conversationId: 'conv-a', text: 'second try' };
  const b = { conversationId: 'conv-b', text: 'hello B' };

  it("withdraws every other chat's restored draft when a chat opens", () => {
    // The agent failed a reply in A, then opened B: A's words must not
    // sit in B's composer one Enter away from the wrong customer.
    expect(partitionRestoredDrafts([a1, a2, b], 'conv-b')).toEqual({
      withdraw: [a1, a2],
      keep: [b],
    });
  });

  it("keeps the open chat's own drafts", () => {
    expect(partitionRestoredDrafts([a1], 'conv-a')).toEqual({
      withdraw: [],
      keep: [a1],
    });
  });

  it('withdraws everything when no chat is open', () => {
    expect(partitionRestoredDrafts([a1, b], null)).toEqual({
      withdraw: [a1, b],
      keep: [],
    });
  });
});

/** An in-memory stand-in for the tab's sessionStorage. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    removeItem: vi.fn((k: string) => void data.delete(k)),
  };
}

function throwingStorage() {
  const fail = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  return {
    getItem: vi.fn(fail),
    setItem: vi.fn(fail),
    removeItem: vi.fn(fail),
  };
}

describe('kept uploads', () => {
  it('lists an upload once, and a reload sweep takes the whole list', () => {
    const storage = memoryStorage();
    rememberKeptUpload(storage, 'account-1/1-a.jpg');
    rememberKeptUpload(storage, 'account-1/2-b.pdf');
    rememberKeptUpload(storage, 'account-1/1-a.jpg');

    expect(takeKeptUploads(storage)).toEqual([
      'account-1/1-a.jpg',
      'account-1/2-b.pdf',
    ]);
    // Taken means cleared: a second mount deletes nothing again.
    expect(storage.data.has(KEPT_UPLOADS_KEY)).toBe(false);
    expect(takeKeptUploads(storage)).toEqual([]);
  });

  it('forgets an upload that was discarded or is being retried', () => {
    // Taken off before a Retry goes out, so a reload mid-retry can never
    // sweep an upload that the retry delivered.
    const storage = memoryStorage();
    rememberKeptUpload(storage, 'account-1/1-a.jpg');
    rememberKeptUpload(storage, 'account-1/2-b.pdf');
    forgetKeptUpload(storage, 'account-1/1-a.jpg');
    expect(takeKeptUploads(storage)).toEqual(['account-1/2-b.pdf']);

    rememberKeptUpload(storage, 'account-1/3-c.png');
    forgetKeptUpload(storage, 'account-1/3-c.png');
    expect(storage.data.has(KEPT_UPLOADS_KEY)).toBe(false);
    // Forgetting what is not listed writes nothing.
    const writes = storage.setItem.mock.calls.length;
    forgetKeptUpload(storage, 'account-1/never-listed.png');
    expect(storage.setItem).toHaveBeenCalledTimes(writes);
  });

  it('ignores a corrupt list rather than deleting what it names', () => {
    expect(
      takeKeptUploads(memoryStorage({ [KEPT_UPLOADS_KEY]: '{not json' }))
    ).toEqual([]);
    expect(
      takeKeptUploads(
        memoryStorage({ [KEPT_UPLOADS_KEY]: '{"path":"account-1/a.jpg"}' })
      )
    ).toEqual([]);
    expect(
      takeKeptUploads(
        memoryStorage({
          [KEPT_UPLOADS_KEY]: JSON.stringify(['account-1/a.jpg', 7, '']),
        })
      )
    ).toEqual(['account-1/a.jpg']);
  });

  it('drops the whole list when a path cannot be taken off it', () => {
    // Left listed, the path would be swept after a Retry delivered it.
    const storage = memoryStorage({
      [KEPT_UPLOADS_KEY]: JSON.stringify([
        'account-1/a.jpg',
        'account-1/b.jpg',
      ]),
    });
    storage.setItem.mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    forgetKeptUpload(storage, 'account-1/a.jpg');
    expect(storage.data.has(KEPT_UPLOADS_KEY)).toBe(false);
  });

  it('never throws when storage is missing or blocked', () => {
    for (const storage of [null, throwingStorage()]) {
      expect(() =>
        rememberKeptUpload(storage, 'account-1/a.jpg')
      ).not.toThrow();
      expect(() => forgetKeptUpload(storage, 'account-1/a.jpg')).not.toThrow();
      expect(takeKeptUploads(storage)).toEqual([]);
    }
  });
});
