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
  template: StoredTemplate | null;
  sentToday: number;
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
  /** The provider accepted the send but the sent mark failed: sent, never resent. */
  settleUnconfirmed(
    id: string,
    providerMessageId: string | null
  ): Promise<void>;
}

export interface TemplateSendRequest {
  accountId: string;
  conversationId: string;
  contactId: string;
  templateKind: TemplateKind;
  language: AutoLang;
  metaTemplateName: string;
  /** The rendered template body (for the message record), never free text. */
  body: string;
  params: { name: string; slot: string };
}

/** The only keys a send request may carry (checked at runtime by `assertTemplateOnly`). */
export const SEND_REQUEST_KEYS: readonly (keyof TemplateSendRequest)[] = [
  'accountId',
  'conversationId',
  'contactId',
  'templateKind',
  'language',
  'metaTemplateName',
  'body',
  'params',
];

export interface SendPort {
  send(
    req: TemplateSendRequest
  ): Promise<{ providerMessageId: string | null; messageId: string | null }>;
}

export interface ClockPort {
  now(): Date;
}

export interface EngineDeps {
  store: AutoMsgStorePort;
  sender: SendPort;
  clock: ClockPort;
}
