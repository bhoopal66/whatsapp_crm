# Voice library

A workspace library of ready voice notes, **Saved voice notes** in the
app: a welcome, the documents a bank needs, a missing-documents reminder,
a status update, in English, Hindi, Arabic or Urdu. An agent picks one
from the composer's **More** menu and it goes out as an ordinary voice
message, through the normal send path: team-activity limits, opt-out and
the Meta 24-hour window apply as for any send.

A voice note for one customer is not saved here: tap the microphone (or
**More → Record a voice note**), speak, and tap **Send**, or **Listen
first** to hear it before it goes.

## Entries

- **Subjects:** four built-in ones (Welcome, Documents required, Missing
  documents, Status update), plus any the team adds.
- **Languages:** English, Hindi, Arabic, Urdu. Fixed.
- **Source:** a recording made in the browser, or a script spoken by AI
  (OpenAI text-to-speech).
  - A **fixed** entry (a recording, or a script without placeholders) is
    stored once as audio and every send uses that same file.
  - A **personalised** script uses `{name}` and/or `{company}`. It stores
    no audio: it is spoken afresh for each send with the chat's customer
    filled in, and that audio is a normal composer upload.
- Entries are never edited: delete and add again.

## Who can do what

- **Read and send:** everyone in the workspace reads the library;
  sending is agent and up, like any reply. Bank guests get nothing.
- **Add an entry or a subject:** agent and up.
- **Delete an entry:** its author, or an owner or admin. (The app has no
  screen to delete a subject; the database allows it only to its author
  or an admin, and only while no entry uses it.)

Entries and their audio are written only by the server, after these
checks; nobody can write them directly from the browser, and no member
can change or delete the stored audio files.

## Deleting an entry

The entry leaves the library at once. Its audio file is kept while any
message in the workspace still points at it, so voice notes already
sent from it keep playing; it is removed only when nothing sent uses it.

## Where data lives

- `voice_note_subjects` and `voice_note_entries` (database).
- Audio of fixed entries: the `chat-media` bucket at
  `account-<workspace id>/voice-library/<entry id>.ogg`. The bucket is
  public, as for every voice note sent, so the WhatsApp gateways can
  fetch it. The unsent-attachment sweep never touches this folder.

## Privacy

- Library entries are staff content, not customer data: a recording is
  made by staff, and a personalised script stores only placeholders,
  never a customer's name.
- AI speech sends the script text (with the customer's name and company
  filled in, for a personalised entry) to OpenAI under the workspace's
  own key. Every call goes through the AI transfer check (migration 224),
  so a workspace that requires a lawful basis must record one first.
- Speech is rate-limited: 20 a minute per person, 60 per workspace.

## Defaults

The library starts empty. AI speech needs an OpenAI key in Settings →
AI (the main key when the provider is OpenAI, else the embeddings key)
and the assistant switched on; without one, recordings still work.

Requires migration `242_voice_note_library.sql`. Verify with
`supabase/ci/verify-voice-note-library.sql`.
