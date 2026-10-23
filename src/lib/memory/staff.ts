/**
 * A staff member adds a memory from the dashboard (modules 019b + 019c). The write is verified: the origin is minted
 * here by humanOriginFromChannel for the caller's own account and user, never taken from the request.
 *   With a vault (configured) and a contact or case scope, the content is tokenised FIRST (tokenizeSensitive: EID /
 *   IBAN / passport / phone / account values go into the vault and are replaced by '[KIND:vlt_...]'); the memory put
 *   gets only the tokenised text. A tokenise failure stores NOTHING and answers the fixed code TOKENIZE_FAILED (its
 *   reason is not passed on).
 *   Without a vault, or for a workspace scope (the vault has no workspace subject), the content goes to put directly,
 *   where 019b redaction replaces those values irreversibly: nothing sensitive is stored either way.
 * The caller (a route) authenticates the user and checks they may write the scope; memory_put checks the scope belongs
 * to the account.
 */
import { tokenizeSensitive, type TokenVault } from '@/lib/vault/tokenize';
import {
  humanOriginFromChannel,
  MAX_RAW_CHARS,
  type MemoryKind,
  type MemoryScope,
  type MemoryStore,
  type PutResult,
} from './store';

export const STAFF_MEMORY_SOURCE = 'staff';
export const STAFF_MEMORY_CHANNEL = 'dashboard';
export const STAFF_MEMORY_DEFAULT_IMPORTANCE = 3;

export interface StaffMemoryDeps {
  readonly memory: Pick<MemoryStore, 'put'>;
  /** null when the vault is not configured. */
  readonly vault: TokenVault | null;
}

export interface StaffMemoryInput {
  /** The caller's active account (wacrm account id). */
  readonly accountId: string;
  /** The authenticated caller. */
  readonly userId: string;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly kind?: MemoryKind;
  /** 1..5; default 3. */
  readonly importance?: number;
  readonly supersedes?: string | null;
}

export type StaffMemoryResult =
  PutResult | { readonly ok: false; readonly refused: 'TOKENIZE_FAILED' };

export async function addStaffMemory(
  deps: StaffMemoryDeps,
  input: StaffMemoryInput
): Promise<StaffMemoryResult> {
  const { accountId, userId, scope } = input;
  let content = input.content;
  // put() refuses raw content over MAX_RAW_CHARS anyway; refusing first
  // keeps an oversized note from being scanned and vaulted (vault rows
  // that then belong to nothing) before that refusal.
  // .length (UTF-16 units) >= code points: count them only when it is over.
  if (content.length > MAX_RAW_CHARS) {
    const raw = Array.from(content).length;
    if (raw > MAX_RAW_CHARS)
      return {
        ok: false,
        refused: 'TOO_LONG',
        reason: `content is ${raw} chars before redaction (max ${MAX_RAW_CHARS})`,
      };
  }
  if (deps.vault && scope.type !== 'workspace') {
    const t = await tokenizeSensitive(
      content,
      {
        workspace: accountId,
        subject: { type: scope.type, id: scope.id },
        actor: userId,
      },
      deps.vault
    );
    if (!t.ok) return { ok: false, refused: 'TOKENIZE_FAILED' };
    content = t.text;
  }
  return deps.memory.put(accountId, scope, content, {
    importance: input.importance ?? STAFF_MEMORY_DEFAULT_IMPORTANCE,
    trust: 'verified',
    origin: humanOriginFromChannel({
      userId,
      workspaceId: accountId,
      channel: STAFF_MEMORY_CHANNEL,
    }),
    kind: input.kind,
    sourceType: STAFF_MEMORY_SOURCE,
    createdBy: userId,
    supersedes: input.supersedes ?? null,
  });
}
