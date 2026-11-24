import { describe, expect, it } from 'vitest';

import { resolveTemplateValues, valuesByPlaceholder } from './template-values';

const TWO = { body_text: 'Hi {{1}}, about your {{2}}' };
const NAMED = { body_text: 'Hi {{customer}}, about your {{product}}' };

const params = (variables: unknown, template = TWO) =>
  resolveTemplateValues(template, { variables }).params;
const missing = (variables: unknown, template = TWO) =>
  resolveTemplateValues(template, { variables }).missing;

describe('resolveTemplateValues', () => {
  it.each<[string, unknown]>([
    ['placeholder keys', { '1': 'Ann', '2': 'cards' }],
    ['placeholder keys in another order', { '2': 'cards', '1': 'Ann' }],
    ['Meta component names', { body_1: 'Ann', body_2: 'cards' }],
    ['an array', ['Ann', 'cards']],
    ['keys counted from 0', { '0': 'Ann', '1': 'cards' }],
    ['one placeholder key and one other', { '1': 'Ann', name: 'cards' }],
    [
      'extra keys beside every placeholder',
      { '1': 'Ann', '2': 'cards', x: 'n' },
    ],
    ['a value past the last placeholder', ['Ann', 'cards', 'more']],
    ['names the template does not have', { customer: 'Ann', product: 'cards' }],
  ])('%s', (_, variables) => {
    expect(params(variables)).toEqual(['Ann', 'cards']);
    expect(missing(variables)).toEqual([]);
  });

  it('sorts numeric keys as numbers when they go by position', () => {
    expect(params({ '10': 'cards', '9': 'Ann' })).toEqual(['Ann', 'cards']);
  });

  it.each<[string, unknown, string[], string[]]>([
    ['the first value only', { '1': 'Ann' }, ['Ann', ''], ['{{2}}']],
    ['the second value only', { '2': 'cards' }, ['', 'cards'], ['{{1}}']],
    ['a short array', ['Ann'], ['Ann', ''], ['{{2}}']],
    ['an array with a hole', [null, 'cards'], ['', 'cards'], ['{{1}}']],
    ['an empty object', {}, ['', ''], ['{{1}}', '{{2}}']],
    ['a string', 'Ann', ['', ''], ['{{1}}', '{{2}}']],
    ['a number', 7, ['', ''], ['{{1}}', '{{2}}']],
    ['null', null, ['', ''], ['{{1}}', '{{2}}']],
    ['nothing', undefined, ['', ''], ['{{1}}', '{{2}}']],
  ])('%s leaves the rest missing', (_, variables, values, left) => {
    expect(params(variables)).toEqual(values);
    expect(missing(variables)).toEqual(left);
  });

  it.each<[string, unknown]>([
    ['its key', { '1': 'Ann' }],
    ['another key', { body_1: 'Ann' }],
    ['an array', ['Ann']],
    ['a key counted from 0', { '0': 'Ann' }],
  ])('one placeholder from %s', (_, variables) => {
    expect(params(variables, { body_text: 'Hi {{1}}' })).toEqual(['Ann']);
  });

  it('reads named placeholders by name, or by position', () => {
    const want = ['Ann', 'cards'];
    expect(params({ product: 'cards', customer: 'Ann' }, NAMED)).toEqual(want);
    expect(params({ '1': 'Ann', '2': 'cards' }, NAMED)).toEqual(want);
    expect(params(['Ann', 'cards'], NAMED)).toEqual(want);
    expect(missing({ product: 'cards' }, NAMED)).toEqual(['{{customer}}']);
  });

  it('fills the header value, whatever its type', () => {
    const header = {
      body_text: 'Hello',
      header_type: 'text',
      header_content: 'Order {{1}}',
    };
    expect(resolveTemplateValues(header, { header_text: 'A1' })).toEqual({
      params: [],
      headerText: 'A1',
      missing: [],
    });
    expect(
      resolveTemplateValues(header, { header_text: 7 as never }).headerText
    ).toBe('7');
    expect(resolveTemplateValues(header, {}).missing).toEqual(['header {{1}}']);
  });
});

describe('valuesByPlaceholder', () => {
  it.each<[string, unknown]>([
    ['placeholder keys', { '1': 'Ann', '2': 'loans' }],
    ['other keys', { body_1: 'Ann', body_2: 'loans' }],
    ['an array', ['Ann', 'loans']],
    ['keys counted from 0', { '0': 'Ann', '1': 'loans' }],
    ['half filled in', { '1': 'Ann' }],
  ])('%s: the inputs show the preview, and an edit keeps the rest', (_, v) => {
    const step = { variables: v };
    const current = valuesByPlaceholder(TWO, step);
    expect(Object.keys(current)).toEqual(['1', '2']);
    expect(Object.values(current)).toEqual(params(v));
    // What the builder saves when {{2}} is edited.
    expect(params({ ...current, '2': 'cards' })).toEqual(['Ann', 'cards']);
  });

  it('is every placeholder, empty, for a step with no values', () => {
    expect(valuesByPlaceholder(TWO, {})).toEqual({ '1': '', '2': '' });
    expect(valuesByPlaceholder(TWO, { variables: 'Ann' })).toEqual({
      '1': '',
      '2': '',
    });
  });

  it('a first value cleared by an edit stays cleared', () => {
    const cleared = {
      ...valuesByPlaceholder(TWO, { variables: ['Ann', 'x'] }),
      '1': '',
    };
    expect(params(cleared)).toEqual(['', 'x']);
    expect(missing(cleared)).toEqual(['{{1}}']);
  });
});
