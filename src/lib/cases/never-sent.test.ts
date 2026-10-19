// Internal case text never reaches a send path (module 018c). Static: the
// send-path files, and every src/lib module they import transitively
// (`@/lib/...` and relative imports), must not import the internal modules
// (notes, bank contacts, the bank workspace) nor name their tables, not even
// in a comment. The reader is a parameter so the mutation checks run the
// same scan over in-memory edited copies.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');
const LIB = join(SRC, 'lib');

const SEND_PATH = [
  'src/lib/whatsapp/send-message.ts',
  'src/lib/whatsapp/provider.ts',
  'src/lib/whatsapp/whapi-api.ts',
  'src/lib/whatsapp/meta-api.ts',
  'src/lib/submission-groups/service.ts',
  'src/lib/cases/documents.ts',
].map((f) => join(ROOT, f));

/** Internal modules, without extension (bank-workspaces.ts is still to come). */
const INTERNAL = ['notes', 'bank-contacts', 'bank-workspaces'].map((m) =>
  join(LIB, 'cases', m)
);
const INTERNAL_TABLES =
  /case_notes|case_note_mentions|case_bank_contacts|bank_ws_posts|bank_ws_pins|bank_ws_threads/i;

type Reader = (file: string) => string;
const realReader: Reader = (f) => readFileSync(f, 'utf8');

const stripExt = (p: string) => p.replace(/\.(?:tsx?|js)$/, '');

/** The import specifiers of a file, resolved to absolute paths (no extension check). */
function specifiers(file: string, read: Reader): string[] {
  const out: string[] = [];
  for (const m of read(file).matchAll(
    /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  )) {
    const spec = m[1];
    if (spec.startsWith('@/')) out.push(join(SRC, spec.slice(2)));
    else if (spec.startsWith('.')) out.push(resolve(dirname(file), spec));
  }
  return out;
}

function existing(base: string): string | null {
  const b = stripExt(base);
  for (const c of [`${b}.ts`, `${b}.tsx`, join(b, 'index.ts')])
    if (existsSync(c)) return c;
  return null;
}

export function scan(read: Reader, roots: readonly string[] = SEND_PATH) {
  const seen = new Set<string>();
  const offenders = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (INTERNAL_TABLES.test(read(f))) offenders.add(f);
    for (const s of specifiers(f, read)) {
      if (INTERNAL.includes(stripExt(s))) offenders.add(f);
      const hit = existing(s);
      if (hit && hit.startsWith(LIB + '/')) queue.push(hit);
    }
  }
  const rel = (fs: Iterable<string>) =>
    [...fs].map((f) => relative(ROOT, f)).sort();
  return { seen: rel(seen), offenders: rel(offenders) };
}

const SERVICE = join(LIB, 'submission-groups', 'service.ts');
const DOCS = join(LIB, 'cases', 'documents.ts');
const mutated =
  (target: string, edit: (t: string) => string): Reader =>
  (f) =>
    f === target ? edit(realReader(f)) : realReader(f);

describe('internal case text is never on a send path', () => {
  it('no send-path file, nor anything it imports, imports an internal module or names its tables', () => {
    const { seen, offenders } = scan(realReader);
    // Not vacuous: the closure follows both import styles.
    expect(seen).toEqual(
      expect.arrayContaining([
        'src/lib/cases/documents.ts',
        'src/lib/cases/tools.ts',
        'src/lib/cases/store.ts',
        'src/lib/submission-groups/service.ts',
        'src/lib/submission-groups/rules.ts',
        'src/lib/whatsapp/send-message.ts',
      ])
    );
    expect(seen.length).toBeGreaterThan(SEND_PATH.length);
    expect(offenders).toEqual([]);
  });

  it.each([
    [SERVICE, "import '@/lib/cases/notes';\n"],
    [DOCS, "import { CaseBankContactsStore } from './bank-contacts';\n"],
    [DOCS, "export * from './bank-workspaces';\n"],
  ])(
    'mutation: an import of an internal module in %s is reported',
    (target, line) => {
      const { offenders } = scan(mutated(target, (t) => line + t));
      expect(offenders).toContain(relative(ROOT, target));
    }
  );

  it.each([
    'SELECT body FROM PUBLIC.CASE_NOTES',
    "from('case_note_mentions')",
    "from('case_bank_contacts')",
    'bank_ws_posts',
    'bank_ws_pins',
    'bank_ws_threads',
  ])('mutation: the table name %s in a send-path file is reported', (text) => {
    const { offenders } = scan(mutated(DOCS, (t) => `${t}\n// ${text}\n`));
    expect(offenders).toEqual(['src/lib/cases/documents.ts']);
  });

  it('mutation: a module reached transitively is scanned too', () => {
    const tools = join(LIB, 'cases', 'tools.ts');
    const { offenders } = scan(
      mutated(tools, (t) => `${t}\nconst q = 'case_notes';\n`)
    );
    expect(offenders).toEqual(['src/lib/cases/tools.ts']);
  });
});
