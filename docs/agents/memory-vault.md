> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### CRM memory and vault (`lib/memory/*`, `lib/vault/*`, migrations 121, 129)

Staff notes per customer, case or workspace, with sensitive numbers kept
in an encrypted vault. `docs/memory-and-vault.md` is the contract.

- **Clean before storing.** A note is redacted before it is stored, and
  tokenised through the vault first when the vault is configured
  (`lib/memory/staff.ts`). Only cleaned text is stored or searched.
- **One read rule**, `memory_can_read`. Its contact branch mirrors 072's
  `can_view_contact` written for an explicit user (the service-role path
  has no `auth.uid()`); change one, change both.
- **Contact delete erases memory** (the `contacts_forget_memory`
  trigger). Forget is owner/admin only, with a reason, and permanent.
- **Search text is an identifier risk.** Memory search should not put
  identifiers in URLs; today it does (`GET ?q=`), a known limit.
- **The app encrypts**, never the database: AES-256-GCM with AAD =
  account | kind | blind index (`lib/vault/crypto.ts`). Keys come only
  from `VAULT_KEYS` / `VAULT_CURRENT_KEY` / `VAULT_BLIND_KEY`, read at call
  time; unset means not configured (503 `VAULT_NOT_CONFIGURED`), and
  memory still redacts.
- **A vault role counts only** while its holder is a live owner or admin
  of the workspace.
- **Reveal** answers `no-store` and never logs the value or the reason.
- `bytea` travels as `\x` hex over PostgREST (`lib/vault/store.ts`).
- Both migrations must be applied as a superuser or BYPASSRLS role.
  `verify-vault.sql`, `verify-crm-memory.sql`.
