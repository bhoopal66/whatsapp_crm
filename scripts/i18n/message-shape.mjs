import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

/**
 * The parts of a catalogue string a translation must carry over
 * unchanged: ICU argument names and types, select option keys, rich-text
 * tag names, and — for strings the ICU parser rejects (WhatsApp `{{1}}`
 * placeholders, raw HTML read through `t.raw()`) — the literal tokens.
 *
 * Plural option keys are the one deliberate exception: Arabic has six
 * plural categories (zero, one, two, few, many, other) where English has
 * two, so a translation may add categories. It must keep `other` and
 * every exact `=N` case of the source.
 *
 * src/i18n/message-shape.ts is the same logic for the tests: change both
 * together.
 */
const ARG_TYPE = {
  [TYPE.argument]: 'arg',
  [TYPE.number]: 'number',
  [TYPE.date]: 'date',
  [TYPE.time]: 'time',
  [TYPE.select]: 'select',
  [TYPE.plural]: 'plural',
};

/** Literal tokens of a string the ICU parser cannot read. */
function rawTokens(text) {
  const tokens = [
    ...(text.match(/\{\{[^{}]*\}\}/g) ?? []),
    ...(text.match(/<\/?[A-Za-z][\w-]*/g) ?? []),
    ...(text.replace(/\{\{[^{}]*\}\}/g, '').match(/\{[\w.]+\}/g) ?? []),
  ];
  return tokens.sort();
}

export function messageShape(text) {
  let ast;
  try {
    ast = parse(text);
  } catch {
    return { kind: 'raw', tokens: rawTokens(text) };
  }
  const args = new Set();
  const selects = new Set();
  const plurals = {};
  const pluralsWithoutOther = new Set();
  const tags = [];

  const walk = (nodes) => {
    for (const node of nodes) {
      const type = ARG_TYPE[node.type];
      if (type && 'value' in node) args.add(`${node.value}:${type}`);
      if (node.type === TYPE.select) {
        selects.add(
          `${node.value}=${Object.keys(node.options).sort().join('|')}`
        );
        for (const opt of Object.values(node.options)) walk(opt.value);
      } else if (node.type === TYPE.plural) {
        const exact = (plurals[node.value] ??= new Set());
        for (const key of Object.keys(node.options)) {
          if (key.startsWith('=')) exact.add(key);
        }
        if (!('other' in node.options)) pluralsWithoutOther.add(node.value);
        for (const opt of Object.values(node.options)) walk(opt.value);
      } else if (node.type === TYPE.tag) {
        tags.push(node.value);
        walk(node.children);
      }
    }
  };
  walk(ast);

  return {
    kind: 'icu',
    args: [...args].sort(),
    selects: [...selects].sort(),
    plurals: Object.fromEntries(
      Object.entries(plurals)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, [...v].sort()])
    ),
    pluralsWithoutOther: [...pluralsWithoutOther].sort(),
    tags: tags.sort(),
  };
}

/**
 * Why `translated` does not carry `source`'s shape, or null when it does.
 */
export function shapeMismatch(source, translated) {
  const a = messageShape(source);
  const b = messageShape(translated);
  if (a.kind !== b.kind) {
    return a.kind === 'icu'
      ? 'the source is a valid ICU message but the translation does not parse'
      : 'the source is a raw (t.raw) string but the translation parses as ICU';
  }
  if (a.kind === 'raw' && b.kind === 'raw') {
    const x = a.tokens.join(' ');
    const y = b.tokens.join(' ');
    return x === y ? null : `raw tokens differ: [${x}] vs [${y}]`;
  }
  if (a.kind !== 'icu' || b.kind !== 'icu') return null;
  const same = (p, q) => p.join(' ') === q.join(' ');
  if (!same(a.args, b.args))
    return `arguments differ: [${a.args.join(' ')}] vs [${b.args.join(' ')}]`;
  if (!same(a.selects, b.selects)) {
    return `select options differ: [${a.selects.join(' ')}] vs [${b.selects.join(' ')}]`;
  }
  if (!same(a.tags, b.tags))
    return `tags differ: [${a.tags.join(' ')}] vs [${b.tags.join(' ')}]`;
  if (b.pluralsWithoutOther.length) {
    return `plural without an "other" branch: ${b.pluralsWithoutOther.join(', ')}`;
  }
  for (const [name, exact] of Object.entries(a.plurals)) {
    const missing = exact.filter((k) => !(b.plurals[name] ?? []).includes(k));
    if (missing.length)
      return `plural ${name} lost exact cases ${missing.join(', ')}`;
  }
  return null;
}
