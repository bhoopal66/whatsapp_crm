import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

import en from '../../messages/en.json';

/**
 * Every text the code asks for by a literal key exists. Parity and shape
 * tests compare the catalogues with each other; a key under the wrong
 * namespace is in all three and still missing where it is used (the
 * Contacts checkboxes, 2026-11-25). Keys built at run time are not seen.
 */
const SRC = path.resolve(__dirname, '..');

type Scope = Record<string, string | null>;

function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === 'object'
          ? (o as Record<string, unknown>)[k]
          : undefined,
      en
    );
}

function namespaceOf(node: ts.Expression): string | null | undefined {
  const call = ts.isAwaitExpression(node) ? node.expression : node;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    !/^(use|get)Translations$/.test(call.expression.text)
  ) {
    return undefined;
  }
  const arg = call.arguments[0];
  if (!arg) return '';
  return ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** The literal keys of `t(...)`, through `a ? 'x' : 'y'`. */
function literals(node: ts.Expression): string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return literals(node.expression);
  }
  return [];
}

function usedKeys(file: string, source: string) {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const used: Array<{ key: string; line: number; raw: boolean }> = [];
  const visit = (node: ts.Node, outer: Scope) => {
    const opens = ts.isBlock(node) || ts.isFunctionLike(node);
    const scope: Scope = opens ? Object.create(outer) : outer;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const ns = node.initializer ? namespaceOf(node.initializer) : undefined;
      // Any other variable of that name hides an outer translator.
      scope[node.name.text] = ns ?? null;
    }
    if (ts.isCallExpression(node) && node.arguments[0]) {
      let callee: ts.Expression = node.expression;
      let method = '';
      if (
        ts.isPropertyAccessExpression(callee) &&
        ['rich', 'raw', 'markup'].includes(callee.name.text)
      ) {
        method = callee.name.text;
        callee = callee.expression;
      }
      const ns = ts.isIdentifier(callee) ? scope[callee.text] : undefined;
      if (typeof ns === 'string') {
        for (const k of literals(node.arguments[0])) {
          used.push({
            key: ns ? `${ns}.${k}` : k,
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            raw: method === 'raw',
          });
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, scope));
  };
  visit(sf, Object.create(null) as Scope);
  return used;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

it('every text the code asks for exists', () => {
  const missing: string[] = [];
  let seen = 0;
  for (const file of sources(SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/\b(use|get)Translations\b/.test(source)) continue;
    for (const { key, line, raw } of usedKeys(file, source)) {
      seen += 1;
      const text = lookup(key);
      if (text === undefined || (typeof text === 'object' && !raw)) {
        missing.push(`${path.relative(SRC, file)}:${line} ${key}`);
      }
    }
  }
  expect(missing).toEqual([]);
  // The scan still finds them: a refactor that blinds it must not pass.
  expect(seen).toBeGreaterThan(8000);
}, 60_000);
