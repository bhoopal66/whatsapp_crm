// ============================================================
// Taamul Connect public API client.
//
// A thin wrapper over the `/api/v1` REST surface. It attaches the
// bearer key, unwraps the `{ data }` / `{ error }` envelope, and
// turns API failures into a typed TaamulApiError the tools can render
// cleanly. Nothing here knows about MCP — it's just the CRM API.
// ============================================================

import { createHash, randomUUID } from 'node:crypto';

import type { Config } from './config.js';

/** A structured error from the Taamul Connect API envelope (`{ error: { code, message } }`). */
export class TaamulApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TaamulApiError';
    this.status = status;
    this.code = code;
  }
}

/** Longest wait for an answer, its body included. */
const TIMEOUT_MS = 30_000;

/** No usable answer: whether a write took effect is unknown. */
function unanswered(
  method: string,
  status: number,
  code: string,
  what: string,
): TaamulApiError {
  return new TaamulApiError(
    status,
    code,
    method === 'GET'
      ? `${what}.`
      : `${what}. The request may have gone through: check before sending it again.`,
  );
}

export interface Paginated<T> {
  data: T[];
  next_cursor: string | null;
}

export class TaamulClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  /** Keys of broadcasts without a success yet, by what they send. */
  private readonly openBroadcasts = new Map<string, string>();

  constructor(config: Pick<Config, 'baseUrl' | 'apiKey'>) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      idempotencyKey?: string;
    } = {},
  ): Promise<{ data: T; meta?: { next_cursor: string | null } }> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // The timeout can also fire while the body is read.
      text = await res.text();
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw unanswered(
          method,
          0,
          'timeout',
          `Taamul Connect did not answer within ${TIMEOUT_MS / 1000} seconds`,
        );
      }
      const { message, cause } = err as Error & { cause?: { code?: string } };
      // Never connected: nothing was sent.
      if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ENOTFOUND') {
        throw new TaamulApiError(
          0,
          'network_error',
          `Could not reach Taamul Connect at ${this.baseUrl}: ${message}`,
        );
      }
      throw unanswered(
        method,
        0,
        'network_error',
        `No answer from Taamul Connect at ${this.baseUrl}: ${message}`,
      );
    }

    // A 5xx with no envelope is a proxy's, not the API's own answer.
    const proxyFailed = res.status >= 500 && method !== 'GET';

    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // Non-JSON body (e.g. an upstream proxy error page).
        if (!res.ok && !proxyFailed) {
          throw new TaamulApiError(res.status, 'internal', text.slice(0, 500));
        }
      }
    }

    if (!res.ok) {
      const envelope = payload as { error?: { code?: string; message?: string } } | undefined;
      const code = envelope?.error?.code ?? 'internal';
      let message =
        envelope?.error?.message ??
        `Request failed with status ${res.status}${proxyFailed && text ? `: ${text.slice(0, 500)}` : ''}`;
      // Both carry a Retry-After we surface to the model.
      if (res.status === 429 || res.status === 503) {
        const retryAfter = res.headers.get('Retry-After');
        if (retryAfter) message += ` (retry after ${retryAfter}s)`;
      }
      if (proxyFailed && !envelope?.error) {
        throw unanswered(method, res.status, code, message);
      }
      throw new TaamulApiError(res.status, code, message);
    }

    const envelope = payload as
      | { data?: T; meta?: { next_cursor: string | null } }
      | null
      | undefined;
    if (envelope?.data === undefined) {
      throw unanswered(
        method,
        res.status,
        'bad_response',
        `Taamul Connect answered ${res.status} with a body that could not be read`,
      );
    }
    return { data: envelope.data, meta: envelope.meta };
  }

  private async list<T>(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<Paginated<T>> {
    const res = await this.request<T[]>('GET', path, { query });
    return { data: res.data, next_cursor: res.meta?.next_cursor ?? null };
  }

  // --- Identity -----------------------------------------------------

  me(): Promise<{ data: unknown }> {
    return this.request('GET', '/me');
  }

  // --- Messages -----------------------------------------------------

  sendMessage(body: unknown): Promise<{ data: unknown }> {
    // One key per call: whatever repeats this request on the way (a proxy)
    // cannot send the customer the message twice.
    return this.request('POST', '/messages', { body, idempotencyKey: randomUUID() });
  }

  // --- Contacts -----------------------------------------------------

  listContacts(query: {
    limit?: number;
    cursor?: string;
    search?: string;
  }): Promise<Paginated<unknown>> {
    return this.list('/contacts', query);
  }

  getContact(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/contacts/${encodeURIComponent(id)}`);
  }

  createContact(body: unknown): Promise<{ data: unknown }> {
    return this.request('POST', '/contacts', { body });
  }

  updateContact(id: string, body: unknown): Promise<{ data: unknown }> {
    return this.request('PATCH', `/contacts/${encodeURIComponent(id)}`, { body });
  }

  // --- Conversations ------------------------------------------------

  listConversations(query: {
    limit?: number;
    cursor?: string;
    status?: string;
    contact_id?: string;
  }): Promise<Paginated<unknown>> {
    return this.list('/conversations', query);
  }

  getConversation(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/conversations/${encodeURIComponent(id)}`);
  }

  listConversationMessages(
    id: string,
    query: { limit?: number; cursor?: string },
  ): Promise<Paginated<unknown>> {
    return this.list(`/conversations/${encodeURIComponent(id)}/messages`, query);
  }

  // --- Broadcasts ---------------------------------------------------

  async sendBroadcast(body: unknown): Promise<{ data: unknown }> {
    // A large campaign can take longer than the timeout, and then goes out
    // all the same: the same call made again takes the same key, and is
    // answered with that campaign. Only a success ends the key, so the
    // same campaign can be sent again on purpose.
    const content = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const key = this.openBroadcasts.get(content) ?? randomUUID();
    this.openBroadcasts.set(content, key);
    const answer = await this.request('POST', '/broadcasts', {
      body,
      idempotencyKey: key,
    });
    this.openBroadcasts.delete(content);
    return answer;
  }

  getBroadcast(id: string): Promise<{ data: unknown }> {
    return this.request('GET', `/broadcasts/${encodeURIComponent(id)}`);
  }
}
