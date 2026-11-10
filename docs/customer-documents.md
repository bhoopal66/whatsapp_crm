# Customer documents

Every document and photo a customer sends on WhatsApp is filed under
that customer's own reference number (for example `TC-000123`), and a
separate worker copies the file into a folder of that name on the
company NAS. Staff see the reference and the list of files on the
customer page and in the inbox contact panel.

Nothing is ever sent to the customer, and no workflow changes: flows,
automations, the AI and the inbox behave exactly as before. The NAS copy
is an archive beside the message, which keeps its own media link.

**Migration required:** `supabase/migrations/178_customer_documents.sql`,
applied by a superuser or BYPASSRLS role (its `customer_documents_record`
function reads the RLS-forced submission group tables). It refuses to
run as anyone else. The worker below is installed once, by hand.

## What is filed, and what is not

Filed:

- A **document** (any file type) or a **photo** (image) a customer sends
  in a 1:1 WhatsApp chat, on any provider: Whapi, Meta Cloud API or
  OpenWA.
- The same, sent by the customer in their case's **submission group**
  (Whapi). The file is first copied into the CRM's `chat-media` storage,
  like 1:1 media, even when the number's media mirror is switched off,
  because the worker has no other way to fetch it. Messages from
  coordinators or staff in the group are not filed.

Not filed:

- Stickers, voice notes, other audio, video and text. The decision uses
  the message's normalised type, not the stored `content_type`: a
  sticker is stored as an image but is never filed.
- Anything that arrived before migration 178 was applied. Nothing is
  back-filled.
- A message with no stored media link.

Recording happens after the inbound message is stored and its duplicate
check has passed, so a webhook redelivery files nothing twice. It never
blocks or fails a message: if recording errors, the app logs
`[customer-docs] record failed for message <id>` and carries on. That
document is then not filed.

A group document whose media could not be copied into `chat-media` is
not filed; the app logs `[customer-docs] group media not mirrored for
group message <id>`.

## Reference numbers and folders

- A customer gets one folder (`customer_doc_folders`, one per contact)
  with the first document filed for them, and keeps it.
- The reference is `TC-` plus a six-digit zero-padded number from one
  global sequence (seven or more digits after 999999). It is never
  reused. Gaps are possible (two first documents of one customer racing
  can burn a number).
- If the contact is deleted, the folder row and the NAS files stay. The
  folder's documents then become visible to owners and admins only.

On the NAS, the layout is:

```
<CUSTOMER_DOCS_NAS_ROOT>/
  .wacrm-customer-docs          readiness marker
  .incoming/                    scratch for writes in progress
  TC-000123/
    2026-11-10 1432 Passport.pdf
    2026-11-10 1433 photo.jpg
```

File names are `YYYY-MM-DD HHmm <name>.<ext>`:

- the date and time are when the message arrived, in
  `CUSTOMER_DOCS_TIME_ZONE` (default UTC);
- for a document `<name>` is the original file name; for a photo it is
  the first line of the caption, or `photo`;
- names are cleaned for Windows/SMB (reserved characters and names) and
  cut to at most 200 bytes;
- an existing file is never overwritten: a clash becomes `name (2).ext`,
  `name (3).ext`, and so on;
- bytes are written into `<root>/.incoming/` and then hard-linked into
  place, an operation that fails rather than replace a file someone put
  there meanwhile (the next free name is taken instead). Where the share
  refuses hard links it falls back to an exclusive copy, which also
  never overwrites but is visible while it copies;
- a retry whose earlier attempt already put the same bytes in the folder
  (as `name.ext` or `name (n).ext`) records that file instead of writing
  a second copy.

Files over 100 MB are failed ("too large").

## Document status

Each filed file is a `customer_documents` row. Its status moves
`pending` to one of:

| status      | shown as                | meaning                                                                 |
| ----------- | ----------------------- | ----------------------------------------------------------------------- |
| `pending`   | Saving...               | waiting for the worker, or being retried                                |
| `stored`    | Saved to NAS            | copied; the CRM also keeps an Open link to the stored copy              |
| `duplicate` | Same as an earlier file | identical bytes (SHA-256) already in that folder; nothing written again |
| `failed`    | Couldn't save           | gave up after the retries below                                         |

Owners and admins get a **Try again** button on a failed file
(`customer_documents_retry`), which puts it back in the queue with its
attempts reset.

## The worker

The copier is `scripts/customer-docs-worker.mjs` (logic in
`src/lib/customer-docs/nas-worker.ts`, loaded by plain Node 22 type
stripping). It runs as its own systemd service, **never inside the
app**: the NAS is a `hard` CIFS mount, so during an outage file I/O
blocks, and that must never freeze the web server.

### Install

```bash
sudo cp scripts/systemd/wacrm-customer-docs.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wacrm-customer-docs
```

Edit the paths in the unit first if your checkout or mount differs
(`WorkingDirectory`, `ExecStart`, `EnvironmentFile`, the mount unit in
`After=` and the `Environment=` lines). `node scripts/customer-docs-worker.mjs
--once` runs one batch and exits (1 if anything failed, 2 on bad
configuration).

### Configuration

The worker reads its environment, not the app's. The unit loads the
Supabase URL and service key from `.env.local` and sets the rest.

| variable                     | meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `CUSTOMER_DOCS_NAS_MOUNT`    | the share's mount point (it must be a live mount)             |
| `CUSTOMER_DOCS_NAS_ROOT`     | a folder inside the mount, e.g. `<mount>/Customer Documents`  |
| `CUSTOMER_DOCS_TIME_ZONE`    | time zone for the date and time in file names (default `UTC`) |
| `CUSTOMER_DOCS_POLL_SECONDS` | seconds between batches, 1 to 3600 (default 20)               |

### Readiness marker

The worker only works while the mount is live and the root holds the
marker file `.wacrm-customer-docs`. If the mount is present but the root
or marker is missing, the first run creates them. While not ready it
claims nothing, so a NAS outage (or an unmounted share) just queues
files; they are copied once it returns. Readiness is checked again
(creating nothing) before every file, and only the check at the start
of a batch ever creates the root: a customer's folder is created only inside an existing root,
so a share that drops mid-batch stops the batch instead of filling the
local disk under the mount point. The check knows only that something
is mounted at `CUSTOMER_DOCS_NAS_MOUNT`, not which share it is: a wrong
share mounted there gets the root and marker created on it at the
start of the next batch and is written into, so check the mount source
(`findmnt <mount>`) when you set it up.

### Failure behaviour

- A claim lasts 15 minutes; a worker that dies mid-file puts the row
  back in the queue when the claim expires.
- Settling hands back the claim's `claimed_at` as its token; a run whose
  claim expired and was re-claimed is refused (`STALE_CLAIM`), logs the
  row id and leaves the row to the run that holds it.
- A retryable failure backs off `2^attempts` minutes, at most 6 hours.
  After 10 attempts the file is `failed`.
- A stop signal finishes the current file only.
- A staff upload or case build (migration 180) has no media link: its
  bytes are in the private `case-files` bucket, and the worker fetches
  the object with the service key. That is the only request that sends
  the key to Storage: only for bucket `case-files` and a path with no
  leading `/` and no `..` segment (else the row is `failed`,
  "unsupported storage location"), never following a redirect. A row
  with neither a media link nor a storage object is `failed`.

### Logs

```bash
journalctl -u wacrm-customer-docs -f
```

Logs never contain media URLs, file names or keys.

## Who sees what

- Whoever can see a customer sees their reference and documents: both
  tables' RLS reuses the contacts policy (migration 177's set-based
  `contacts_select`). Owners and admins see the whole workspace.
- A folder whose contact was deleted is admin-only.
- No client role writes either table. Every write is a SECURITY DEFINER
  function: `customer_documents_record`, `_claim`, `_existing` and
  `_settle` for the service role (the webhook side and the worker), and
  `customer_documents_retry` for owners and admins.

In the CRM: a **Documents** card on the customer page (reference chip
with copy, the NAS folder path, the list with status, Open for stored
copies, Try again for owners/admins) and a **Documents** row in the
inbox contact panel, shown once a folder exists.

### Giving staff access to the NAS folder

The folder lives on the share the server mounts. Access for people is
granted in the NAS's own permissions, and only on the `Customer
Documents` folder: the same share may hold other server data, such as
database backups, that staff should not see.

## API

Internal routes (cookie session, `{ error: string }` on failure):

- `GET /api/contacts/[id]/documents` returns `{ folder, documents }`
  (newest first, at most 200). With `?summary=1` it returns
  `{ folder, count }`. A contact the caller cannot see is 404.
- `POST /api/contacts/[id]/documents/[docId]/retry` puts a failed
  document back in the queue (owner/admin; 409 if it is not failed).

Neither is part of the public `/api/v1` API.

## Tests

`supabase/ci/verify-customer-documents.sql` asserts the SQL invariants
and is a step in `.github/workflows/migrations.yml`.
