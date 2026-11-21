/**
 * HR automated messages: the ports the row processor needs. The real
 * store (migration 203's RPCs) and sender live elsewhere; `memory-store.ts`
 * is the in-memory store for tests. A send request names a template and
 * its params and carries the rendered body for the record: it has no
 * free-text field.
 */
import type {
  AutoLang,
  AutoMsgSettings,
  Channel,
  HoldReason,
  OutboxRow,
  StoredTemplate,
  TemplateKind,
} from './types';

export type { OutboxRow, StoredTemplate } from './types';

/** camelCase of SQL `hr_automsg_row_state()`. */
export interface RowState {
  row: OutboxRow;
  closed: boolean;
  inbox: 'recruiter' | 'dept' | null;
  /** A personal-number chat (migration 191): never sent on. */
  personal: boolean;
  optedOut: boolean;
  consent: boolean;
  lastInboundAt: string | null;
  contactName: string | null;
  /** Includes `triggers`. */
  settings: AutoMsgSettings;
  triggerEnabled: boolean;
  /** That channel's template: for rcs, `metaTemplateName` is the RCS provider template id. */
  template: StoredTemplate | null;
  sentToday: number;
  /** Migration 215; 'whatsapp' when the state carries none. */
  channel: Channel;
}

export type ClaimOutcome = 'claimed' | 'capped' | 'lost';

export interface AutoMsgStorePort {
  state(id: string): Promise<RowState | null>;
  hold(id: string, reason: HoldReason): Promise<void>;
  cancel(id: string): Promise<void>;
  /** Claim before send: 'claimed' = this caller sends; 'capped' = held daily_cap; 'lost' = do not send. */
  claim(id: string, now: Date): Promise<ClaimOutcome>;
  markSent(
    id: string,
    r: {
      providerMessageId: string | null;
      messageId: string | null;
      bodyRendered: string;
    }
  ): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  /** A failure no retry can pass (029a): failed for good, with a stable reason. */
  failTerminal(id: string, reason: string): Promise<void>;
  /** The provider accepted the send but the sent mark failed: sent, never resent. */
  settleUnconfirmed(
    id: string,
    providerMessageId: string | null
  ): Promise<void>;
}

export interface TemplateSendRequest {
  /**
   * The outbox row's id: an id, never text. The RCS sender passes it as its
   * idempotency reference (`clientRef`); the WhatsApp sender ignores it.
   */
  outboxId: string;
  accountId: string;
  conversationId: string;
  contactId: string;
  templateKind: TemplateKind;
  language: AutoLang;
  metaTemplateName: string;
  /**
   * The rendered template body, never free text: sent as-is on a linked
   * device (Whapi/OpenWA) and kept as the message record.
   */
  body: string;
  /**
   * The stored HR template body with its {name}/{slot} tokens: their order
   * is the Meta template's positional body-param order.
   */
  templateBody: string;
  params: { name: string; slot: string };
}

/** The only keys a send request may carry (checked at runtime by `assertTemplateOnly`). */
export const SEND_REQUEST_KEYS: readonly (keyof TemplateSendRequest)[] = [
  'outboxId',
  'accountId',
  'conversationId',
  'contactId',
  'templateKind',
  'language',
  'metaTemplateName',
  'body',
  'templateBody',
  'params',
];

export interface SendPort {
  send(
    req: TemplateSendRequest
  ): Promise<{ providerMessageId: string | null; messageId: string | null }>;
  /**
   * False while the sender is at its own pace limit (the SMS gateway's
   * per-minute cap). The engine then leaves the row untouched for a later
   * pass: claiming it would spend one of its three attempts on a send
   * that cannot happen yet. Absent = always ready.
   */
  hasCapacity?(): boolean;
}

export interface ClockPort {
  now(): Date;
}

export interface EngineDeps {
  store: AutoMsgStorePort;
  /** The WhatsApp sender. */
  sender: SendPort;
  /** Other channels' senders; a missing one holds its rows 'channel_not_connected'. */
  senders?: { rcs?: SendPort | null; sms?: SendPort | null };
  clock: ClockPort;
}
