# CRM memory and the vault

**CRM memory** is what staff write down about what was agreed: short notes
kept per customer, per case or for the whole workspace. The **vault** keeps
the sensitive numbers that appear in those notes (Emirates ID, IBAN and
the like) encrypted, and puts a token in their place. This is the operator
contract for modules 019b (migration 129, `lib/memory/*`) and 019c
(migration 121, `lib/vault/*`).

Memory is **not** fed to the AI reply bot, and nothing outside staff
screens reads it today.

## Where staff see it

- the **Memory** panel on the customer page (`/contacts/[id]`):
  `GET` / `POST /api/contacts/[id]/memory`, and
  `POST /api/contacts/[id]/memory/forget`;
- the **Memory** panel on the case page (`/cases/[id]`):
  `GET` / `POST /api/cases/[id]/memory`, and
  `POST /api/cases/[id]/memory/forget`.

A panel lists the scope's notes newest first (50 at a time, up to 200) or
searches them (`?q=`, up to 100 results). Workspace notes have no screen
yet; the access rule below already covers them.

## Who reads and who writes

| Scope     | Reads                                                      | Adds                                  |
| --------- | ---------------------------------------------------------- | ------------------------------------- |
| customer  | owners and admins; anyone who can see the customer         | agents and up who can read it         |
| case      | owners and admins; anyone who can read the case (cases.md) | agents and up who may act on the case |
| workspace | all live staff of the workspace                            | (no screen yet)                       |

"Staff" means a live profile in the workspace: not deactivated and not a
bank guest. Viewers read and never add. Seeing a customer follows the
inbox rule (their creator, their own or assigned chats, a team leader's
team). One SQL function, `memory_can_read`, decides every read; the role
always comes from the database.

**Forget** erases every note of one customer or one case. Only owners and
admins can do it, with a reason (up to 1,000 characters), and it is
permanent: nothing can bring the notes back. **Deleting a contact** erases
its memory the same way.

## What is stored

Every note is cleaned **before** it is stored:

- With the vault configured, Emirates ID, IBAN, passport, phone and account
  numbers go into the vault and the note keeps a token in their place, for
  example `[EID:vlt_…]` or `[PHONE:vlt_…]`. If the vault cannot take a
  value, nothing is stored and the panel says so (`TOKENIZE_FAILED`).
- Everything else is **redacted for good**: an email address shows as
  `[EMAIL]`, a card number as `[CARD]`, an OTP, PIN, CVV or CVC as
  `[OTP]`. Without the vault, the numbers above are redacted the same way:
  `[EID]`, `[IBAN]`, `[PASSPORT]`, `[ACCT]`, and `[PHONE:123]` (a phone
  keeps its last three digits). Workspace notes are always redacted, never
  vaulted (the vault has no workspace subject).

Only the cleaned text is stored or searched. A note is at most **4,000
characters** after cleaning (text over 16,000 characters is refused before
it is cleaned); a blank note is refused.

**Duplicates.** The same note added twice to the same scope (ignoring case,
spacing and digit forms) is stored once; the second add answers
`deduped: true`.

**Corrections.** A note is never edited. A correction is a new note that
**supersedes** the old one, which stops being listed.

**Expiry.** Every note expires **24 months** after it was written, never
later. The automations cron (`GET /api/automations/cron`) removes expired
notes once a day.

**Size of a scope.** A scope holds at most 500 live notes. Over that,
superseded notes go first, then the least important and least recent.
Staff notes are never evicted; if only staff notes are left over the
limit, the new note is refused.

**Verified and untrusted.** A note added by staff is **verified**: the
server marks it so from the signed-in session, never from the request.
Anything else (a future assistant) is stored **untrusted**, with its
importance capped at 2, and cannot supersede a verified note.

**Audit.** Every add, duplicate, correction, eviction, expiry and forget
is written to an append-only audit: who, which scope, how many. It never
holds the content.

**Not switched on.** Embeddings (semantic search) are off: no note text
leaves the server. Compaction (summarising old untrusted notes) is built
but idle: nothing calls it.

## The vault

### What it keeps

Emirates ID, IBAN, passport, phone, account and trade licence numbers,
each encrypted (AES-256-GCM) by the app; the database never sees a value
or a key. A token (`vlt_` and 26 letters) is random, never derived from
the value. The same value twice in one workspace is stored once and keeps
one token.

It **never** keeps card numbers, CVV, OTP or PIN, not even encrypted:
the database refuses those kinds.

### Keys

The keys come from the environment, read when they are used:

| Variable            | Value                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `VAULT_KEYS`        | comma-separated `id:base64` entries, each a 32-byte key; keep every old key still in use |
| `VAULT_CURRENT_KEY` | the id new values are encrypted under; it must be in `VAULT_KEYS`                        |
| `VAULT_BLIND_KEY`   | base64, at least 32 bytes, different from every encryption key; **never rotated**        |

Generate each key with `openssl rand -base64 32`, for example
`VAULT_KEYS=k1:<output>`, `VAULT_CURRENT_KEY=k1`,
`VAULT_BLIND_KEY=<another output>`. The blind key finds an existing value
without decrypting it; changing it orphans every stored value's lookup.

All three unset, or any of them invalid, means the vault is **not
configured**: Settings -> Vault says so, the vault routes answer `503
VAULT_NOT_CONFIGURED`, and memory still redacts every sensitive number,
irreversibly.

### Vault roles

Two roles, **admin** and **super admin**, per workspace, in **Settings ->
Vault** (`GET /api/vault`). A role counts only while its holder is also a
live owner or admin of the workspace: someone demoted or deactivated loses
the vault with it.

- **Bootstrap.** While nobody holds a vault role, a live owner can make
  themselves super admin from Settings -> Vault
  (`POST /api/vault/bootstrap`).
- A **super admin** grants and revokes roles (`POST` / `DELETE
/api/vault/roles`), only to live owners and admins. The last super
  admin cannot be revoked.
- Admins and super admins reveal, erase and read the vault audit.

### Reveal

A vault admin reveals one value with a reason (`POST /api/vault/reveal`):

- The reason is required, at most 500 characters, and must **not contain
  an identifier**. A long run of digits counts, and so do numeric dates:
  write "the fourth of March", not "04/03". A refused reason is a refused
  reveal.
- **20 reveals per person per hour**, counted across every workspace.
- Every attempt, refused ones included, is audited (who, when, which
  token, the reason).
- The answer is never cached (`no-store`), and neither the value nor the
  reason is logged.

### Erase

`POST /api/vault/erase` (a vault admin, with a reason under the same rule)
wipes the encrypted value for good; the token then reveals nothing. A
value is stored once per workspace, so if two customers' notes carry the
same number, **erasing it erases it for both**. The notes keep the token.

### Key rotation

There is no screen. An operator adds a new key to `VAULT_KEYS`, points
`VAULT_CURRENT_KEY` at it, and has a super admin's script run
`VaultStore.rewrap` to re-encrypt the old key's values; the old key stays
listed until nothing uses it. The blind key never changes.

### The vault audit

Append-only (no update or delete, not even by the database owner): every
put, duplicate, reveal, erase, rewrap and role change, and every refused
attempt. Never a value. Vault admins read it in Settings -> Vault
(`GET /api/vault/audit`).

### Threat model

A stolen database dump yields ciphertext, tokens and audit rows, no
values. A stolen app server holds the keys, so the vault protects against
the database leaking, not the server.

## Known limits

- Memory search sends the search text in the URL (`GET ?q=`), so a number
  typed into search can land in proxy logs.
- Bootstrap is done by a live owner from Settings -> Vault rather than by
  a deploy script.
- Key rotation has no screen; it is an operator task.
- If every super admin stops being an owner or admin while their role rows
  stay, nobody can grant roles and bootstrap stays closed.
- Vault and memory rows block hard-deleting a workspace; workspaces are
  archived, not deleted.
- Trade licence numbers are a vault kind, but notes have no rule that
  detects them, so a note never vaults one.
- Concurrency rules (reveal limit races, concurrent bootstraps) are not
  covered by the SQL verify files.
- Memory is not fed to the AI bot; embeddings are off and compaction is
  idle.
