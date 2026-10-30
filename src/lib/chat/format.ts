/**
 * Team-chat message formatting, WhatsApp-compatible (pure, no React).
 *
 * Inline: *bold*, _italic_, ~strike~, `code` (literal inside), nesting
 * like *_both_*. A marker opens only at the start of a line or after
 * whitespace/punctuation and before a non-space, and closes only after
 * a non-space and before the end, whitespace or punctuation, so
 * 2*3*4, snake_case_name and a~b stay literal; an unmatched marker is
 * literal text. Markers never span lines.
 *
 * Blocks: ``` fenced code (contents literal), "> " quotes, "- " / "* " /
 * "• " bullets, "1. " numbered lists, other lines as paragraphs.
 *
 * Only http:// and https:// URLs become links; mentions (<@uuid>,
 * @channel, @here) are atomic tokens resolved as mentionSegments does.
 */
import { pickedLabelRanges, type ComposerDraft } from './composer';
import { mentionSegments, type MentionSegment } from './mentions';
import type { BroadcastKind, ChatPerson } from './types';

type People = ReadonlyArray<Pick<ChatPerson, 'userId' | 'fullName'>>;

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold' | 'italic' | 'strike'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string }
  | { type: 'mention'; userId: string; name: string | null }
  | { type: 'broadcast'; kind: BroadcastKind }
  | { type: 'break' };

export type Block =
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'quote'; content: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'bullets'; items: Inline[][] }
  | { type: 'numbered'; start: number; items: Inline[][] };

const EMPHASIS = { '*': 'bold', _: 'italic', '~': 'strike' } as const;
type Marker = keyof typeof EMPHASIS;
const isWs = (c: string | undefined) => c !== undefined && /\s/u.test(c);
const isPunct = (c: string | undefined) =>
  c !== undefined && /[\p{P}\p{S}]/u.test(c);
const openOk = (s: string, i: number) =>
  (i === 0 || isWs(s[i - 1]) || isPunct(s[i - 1])) &&
  i + 1 < s.length &&
  !isWs(s[i + 1]);
const closeOk = (s: string, i: number) =>
  i > 0 &&
  !isWs(s[i - 1]) &&
  (i + 1 >= s.length || isWs(s[i + 1]) || isPunct(s[i + 1]));

/** Trailing characters a URL gives back to the sentence around it. */
const URL_TRAIL = /[.,;:!?*_~'"]/;
const URL_RE = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>]+/giu;

/** The URL as linked: trailing punctuation and an unbalanced ")" trimmed; null when nothing is left. */
export function trimUrl(raw: string): string | null {
  let u = raw;
  for (;;) {
    const last = u[u.length - 1];
    if (last && URL_TRAIL.test(last)) u = u.slice(0, -1);
    else if (
      last === ')' &&
      (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)
    )
      u = u.slice(0, -1);
    else break;
  }
  return /^https?:\/\/[^\s/?#]+/i.test(u) ? u : null;
}

interface Atom {
  start: number;
  end: number;
  node: Inline;
}

/** Code spans, mentions and links of one line: the ranges emphasis never looks inside. */
function atomsOf(line: string, people: People): Atom[] {
  const atoms: Atom[] = [];
  const free: [number, number][] = [];
  let at = 0;
  for (let i = 0; i < line.length;) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let n = 1;
    while (line[i + n] === '`') n++;
    let close = -1;
    const before = i === 0 || isWs(line[i - 1]) || isPunct(line[i - 1]);
    if (before && i + n < line.length && !isWs(line[i + n])) {
      for (let k = i + n + 1; k < line.length; k++) {
        if (line[k] !== '`') continue;
        let m = 1;
        while (line[k + m] === '`') m++;
        const after =
          k + m >= line.length || isWs(line[k + m]) || isPunct(line[k + m]);
        if (m === n && !isWs(line[k - 1]) && after) {
          close = k;
          break;
        }
        k += m - 1;
      }
    }
    if (close < 0) {
      i += n;
      continue;
    }
    if (i > at) free.push([at, i]);
    atoms.push({
      start: i,
      end: close + n,
      node: { type: 'code', text: line.slice(i + n, close) },
    });
    i = at = close + n;
  }
  if (at < line.length) free.push([at, line.length]);

  for (const [a, b] of free) {
    let pos = a;
    for (const seg of mentionSegments(line.slice(a, b), people)) {
      const text = seg.type === 'text' ? seg.text : null;
      const len =
        seg.type === 'text'
          ? seg.text.length
          : seg.type === 'mention'
            ? seg.userId.length + 3
            : seg.kind.length + 1;
      if (text === null) {
        atoms.push({ start: pos, end: pos + len, node: seg });
      } else {
        for (const m of text.matchAll(URL_RE)) {
          const href = trimUrl(m[0]);
          if (href)
            atoms.push({
              start: pos + m.index,
              end: pos + m.index + href.length,
              node: { type: 'link', href },
            });
        }
      }
      pos += len;
    }
  }
  return atoms.sort((x, y) => x.start - y.start);
}

/** One line's inline tokens. */
export function parseInline(line: string, people: People): Inline[] {
  const atoms = atomsOf(line, people);
  const atomAt = new Map(atoms.map((a) => [a.start, a]));
  const plain = (from: number, to: number): Inline[] => {
    const out: Inline[] = [];
    let t = from;
    for (const a of atoms) {
      if (a.start < from || a.start >= to) continue;
      if (a.start > t) out.push({ type: 'text', text: line.slice(t, a.start) });
      out.push(a.node);
      t = a.end;
    }
    if (t < to) out.push({ type: 'text', text: line.slice(t, to) });
    return out;
  };
  const findClose = (c: string, from: number, to: number): number => {
    for (let k = from; k < to;) {
      const a = atomAt.get(k);
      if (a) {
        k = a.end;
        continue;
      }
      if (line[k] === c && closeOk(line, k)) return k;
      k++;
    }
    return -1;
  };
  const range = (from: number, to: number): Inline[] => {
    const out: Inline[] = [];
    let textStart = from;
    for (let i = from; i < to;) {
      const a = atomAt.get(i);
      if (a) {
        i = a.end;
        continue;
      }
      const c = line[i];
      if (c in EMPHASIS && openOk(line, i)) {
        const j = findClose(c, i + 2, to);
        if (j >= 0) {
          out.push(...plain(textStart, i), {
            type: EMPHASIS[c as Marker],
            children: range(i + 1, j),
          });
          i = textStart = j + 1;
          continue;
        }
      }
      i++;
    }
    out.push(...plain(textStart, to));
    return out;
  };
  return range(0, line.length);
}

const FENCE = '```';
const QUOTE_RE = /^>(?: (.*))?$/;
const BULLET_RE = /^[-*•] (.*)$/;
const NUMBER_RE = /^(\d{1,9})\. (.*)$/;

const joinLines = (lines: string[], people: People): Inline[] =>
  lines.flatMap((l, i): Inline[] =>
    i === 0
      ? parseInline(l, people)
      : [{ type: 'break' }, ...parseInline(l, people)]
  );

/** A stored body as blocks of inline tokens. */
export function parseBody(body: string, people: People): Block[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length)
      out.push({ type: 'paragraph', content: joinLines(para, people) });
    para = [];
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.startsWith(FENCE)) {
      const first = line.slice(3);
      if (first.length > 3 && first.endsWith(FENCE)) {
        flush();
        out.push({ type: 'code', text: first.slice(0, -3) });
        i++;
        continue;
      }
      let end = -1;
      for (let k = i + 1; k < lines.length; k++)
        if (lines[k].trimEnd().endsWith(FENCE)) {
          end = k;
          break;
        }
      if (end > 0) {
        flush();
        const last = lines[end].trimEnd().slice(0, -3);
        const content = [
          ...(first.trim() ? [first] : []),
          ...lines.slice(i + 1, end),
          ...(last ? [last] : []),
        ];
        out.push({ type: 'code', text: content.join('\n') });
        i = end + 1;
        continue;
      }
    }
    if (QUOTE_RE.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]))
        q.push(QUOTE_RE.exec(lines[i++])?.[1] ?? '');
      out.push({ type: 'quote', content: joinLines(q, people) });
      continue;
    }
    if (BULLET_RE.test(line)) {
      flush();
      const items: Inline[][] = [];
      while (i < lines.length && BULLET_RE.test(lines[i]))
        items.push(parseInline(BULLET_RE.exec(lines[i++])?.[1] ?? '', people));
      out.push({ type: 'bullets', items });
      continue;
    }
    const num = NUMBER_RE.exec(line);
    if (num) {
      flush();
      const items: Inline[][] = [];
      while (i < lines.length && NUMBER_RE.test(lines[i]))
        items.push(parseInline(NUMBER_RE.exec(lines[i++])?.[2] ?? '', people));
      out.push({ type: 'numbered', start: Number(num[1]), items });
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line);
    i++;
  }
  flush();
  return out;
}

const flatten = (nodes: Inline[]): MentionSegment[] =>
  nodes.flatMap((n): MentionSegment[] => {
    switch (n.type) {
      case 'text':
      case 'code':
        return [{ type: 'text', text: n.text }];
      case 'link':
        return [{ type: 'text', text: n.href }];
      case 'break':
        return [{ type: 'text', text: '\n' }];
      case 'mention':
      case 'broadcast':
        return [n];
      default:
        return flatten(n.children);
    }
  });

/**
 * A body for previews: markers removed, list items prefixed "• " / "1. ",
 * blocks on their own lines; mentions stay segments for chips. Adjacent
 * text runs are merged.
 */
export function previewSegments(
  body: string,
  people: People
): MentionSegment[] {
  const lines: MentionSegment[][] = [];
  for (const b of parseBody(body, people)) {
    if (b.type === 'code') lines.push([{ type: 'text', text: b.text }]);
    else if (b.type === 'bullets')
      for (const it of b.items)
        lines.push([{ type: 'text', text: '• ' }, ...flatten(it)]);
    else if (b.type === 'numbered')
      b.items.forEach((it, k) =>
        lines.push([{ type: 'text', text: `${b.start + k}. ` }, ...flatten(it)])
      );
    else lines.push(flatten(b.content));
  }
  const out: MentionSegment[] = [];
  lines.forEach((l, k) => {
    for (const s of k > 0 ? [{ type: 'text', text: '\n' } as const, ...l] : l) {
      const prev = out[out.length - 1];
      if (s.type === 'text' && prev?.type === 'text')
        out[out.length - 1] = { type: 'text', text: prev.text + s.text };
      else out.push(s);
    }
  });
  return out;
}

/** The readable text: markers removed, mentions as "@Name". */
export function plainText(
  body: string,
  people: People,
  unknownName = '?'
): string {
  return previewSegments(body, people)
    .map((s) =>
      s.type === 'text'
        ? s.text
        : s.type === 'mention'
          ? `@${s.name ?? unknownName}`
          : `@${s.kind}`
    )
    .join('');
}

// ---------- composer formatting ----------

export type FormatAction =
  'bold' | 'italic' | 'strike' | 'code' | 'quote' | 'bullets';

const WRAP: Record<'bold' | 'italic' | 'strike' | 'code', string> = {
  bold: '*',
  italic: '_',
  strike: '~',
  code: '`',
};
const PREFIX = { quote: '> ', bullets: '- ' } as const;

/** Ctrl/Cmd+B, I, Shift+X, E; null for any other key. */
export function formatShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): FormatAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (e.shiftKey) return k === 'x' ? 'strike' : null;
  return k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'e' ? 'code' : null;
}

export interface FormatResult {
  draft: ComposerDraft;
  selStart: number;
  selEnd: number;
}

/**
 * Applies a toolbar/shortcut action to the selection [start, end).
 * Picked mentions live in the text as "@label", so a selection edge
 * inside a label is first moved to the label's edge: markers then never
 * split a label and serializeDraft still finds it ('*' etc. are not
 * word characters). Wrapping trims the selection's outer whitespace,
 * wraps each selected line on its own (markers never span lines),
 * unwraps when the selection is already wrapped, and inserts the pair
 * with the caret between when nothing is selected. Quote and bullets
 * prefix every touched line, or remove the prefix when all have it.
 */
export function applyFormat(
  draft: ComposerDraft,
  start: number,
  end: number,
  action: FormatAction
): FormatResult {
  const text = draft.text;
  let s = Math.max(0, Math.min(start, end, text.length));
  let e = Math.min(text.length, Math.max(start, end, s));
  for (const [a, b] of pickedLabelRanges(text, draft.picked)) {
    if (s > a && s < b) s = a;
    if (e > a && e < b) e = b;
  }
  const done = (t: string, a: number, b: number): FormatResult => ({
    draft: { text: t, picked: draft.picked },
    selStart: a,
    selEnd: b,
  });

  if (action === 'quote' || action === 'bullets') {
    const p = PREFIX[action];
    const ls = text.lastIndexOf('\n', s - 1) + 1;
    const nl = text.indexOf('\n', e > s ? e - 1 : e);
    const le = nl < 0 ? text.length : nl;
    const lines = text.slice(ls, le).split('\n');
    const all = lines.every((l) => l.startsWith(p));
    const next = lines.map((l) => (all ? l.slice(p.length) : p + l));
    const delta = all ? -p.length : p.length;
    const first = Math.max(ls, s + delta);
    return done(
      text.slice(0, ls) + next.join('\n') + text.slice(le),
      first,
      e + delta * lines.length
    );
  }

  const m = WRAP[action];
  const sel = text.slice(s, e);
  if (!sel.trim())
    return done(
      text.slice(0, s) + m + m + text.slice(s),
      s + m.length,
      s + m.length
    );
  s += sel.length - sel.trimStart().length;
  e -= sel.length - sel.trimEnd().length;
  const inner = text.slice(s, e);
  if (text.slice(s - m.length, s) === m && text.slice(e, e + m.length) === m)
    return done(
      text.slice(0, s - m.length) + inner + text.slice(e + m.length),
      s - m.length,
      e - m.length
    );
  if (
    inner.length > 2 * m.length &&
    inner.startsWith(m) &&
    inner.endsWith(m) &&
    !inner.includes('\n')
  )
    return done(
      text.slice(0, s) + inner.slice(m.length, -m.length) + text.slice(e),
      s,
      e - 2 * m.length
    );
  const wrapped = inner
    .split('\n')
    .map((l) => {
      const t = l.trim();
      if (!t) return l;
      const lead = l.slice(0, l.length - l.trimStart().length);
      const tail = l.slice(l.trimEnd().length);
      return lead + m + t + m + tail;
    })
    .join('\n');
  const single = !inner.includes('\n');
  return done(
    text.slice(0, s) + wrapped + text.slice(e),
    single ? s + m.length : s,
    single ? e + m.length : s + wrapped.length
  );
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Replaces the selection [start, end) with `insert` (an emoji from the
 * picker) and puts the caret after it. Picked mentions stay valid: a
 * caret inside an "@label" moves to the label's end rather than
 * splitting it, a selection edge inside one widens to the whole label
 * (as applyFormat does), and a word character that would touch
 * either end of a label is separated by a space, so serializeDraft
 * still finds the label.
 */
export function insertAtSelection(
  draft: ComposerDraft,
  start: number,
  end: number,
  insert: string
): { draft: ComposerDraft; caret: number } {
  const text = draft.text;
  let s = Math.max(0, Math.min(start, end, text.length));
  let e = Math.min(text.length, Math.max(start, end, s));
  const ranges = pickedLabelRanges(text, draft.picked);
  for (const [a, b] of ranges) {
    if (s === e && s > a && s < b) s = e = b;
    if (s > a && s < b) s = a;
    if (e > a && e < b) e = b;
  }
  let piece = insert;
  if (piece && WORD_CHAR.test(piece[0]) && ranges.some(([, b]) => b === s))
    piece = ` ${piece}`;
  if (
    piece &&
    WORD_CHAR.test(piece[piece.length - 1]) &&
    ranges.some(([a]) => a === e)
  )
    piece = `${piece} `;
  return {
    draft: {
      text: text.slice(0, s) + piece + text.slice(e),
      picked: draft.picked,
    },
    caret: s + piece.length,
  };
}
