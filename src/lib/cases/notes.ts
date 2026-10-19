/**
 * Internal case notes (module 018c, migration 123). INTERNAL ONLY: a note
 * never reaches the customer. No send-path module may import this file or
 * name its tables; never-sent.test.ts scans for both.
 *
 *   add  — case_note_add (case write right). `@<uuid>` mentions (canonical
 *          lowercase) are stored for users who may act on the case; every
 *          other handle is ignored and returned in `ignored`. Append-only.
 *   list — the case's notes with their stored mentions (no access decision:
 *          a route checks the caller's read right first).
 */
import { CaseRpc } from './rpc';
import { date, rows } from './store';

export interface CaseNote {
  id: string;
  caseId: string;
  authorId: string;
  body: string;
  mentions: string[];
  createdAt: Date;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : [];

export class CaseNotesStore extends CaseRpc {
  async add(
    caseId: string,
    actor: string,
    body: string
  ): Promise<{ noteId: string; mentioned: string[]; ignored: string[] }> {
    const [row] = rows(
      await this.rpc('case_note_add', {
        p_case: caseId,
        p_actor: actor,
        p_body: body,
        p_now: this.now(),
      })
    );
    return {
      noteId: String(row?.note_id),
      mentioned: strings(row?.mentioned),
      ignored: strings(row?.ignored),
    };
  }

  async list(caseId: string): Promise<CaseNote[]> {
    const [notes, mentions] = await Promise.all([
      this.select(
        'case_notes',
        'id, case_id, author_id, body, created_at',
        { case_id: caseId },
        ['created_at', 'id']
      ),
      this.select(
        'case_note_mentions',
        'note_id, user_id',
        { case_id: caseId },
        ['user_id']
      ),
    ]);
    const byNote = new Map<string, string[]>();
    for (const m of mentions) {
      const k = String(m.note_id);
      byNote.set(k, [...(byNote.get(k) ?? []), String(m.user_id)]);
    }
    return notes.map((n) => ({
      id: String(n.id),
      caseId: String(n.case_id),
      authorId: String(n.author_id),
      body: String(n.body),
      mentions: byNote.get(String(n.id)) ?? [],
      createdAt: date(n.created_at)!,
    }));
  }
}
