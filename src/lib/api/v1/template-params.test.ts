import { describe, expect, it } from 'vitest';

import { readTemplateParams, readTemplateValues } from './template-params';

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    return err as { code: string; status: number; message: string };
  }
  return null;
};

describe('readTemplateValues', () => {
  it('keeps every value in its place, a number as text', () => {
    expect(readTemplateValues(['Jane', 50000, '5.9', ''], 'params')).toEqual([
      'Jane',
      '50000',
      '5.9',
      '',
    ]);
    expect(readTemplateValues(undefined, 'params')).toBeUndefined();
    expect(readTemplateValues(null, 'params')).toBeUndefined();
  });

  it.each([null, true, {}, ['x'], NaN, Infinity])(
    'refuses %j and says where it is',
    (value) => {
      expect(
        refusal(() => readTemplateValues(['Jane', value], 'r[3].params'))
      ).toMatchObject({
        code: 'bad_request',
        status: 400,
        message: expect.stringContaining("'r[3].params[1]'"),
      });
    }
  );

  it('refuses what is not an array', () => {
    expect(refusal(() => readTemplateValues('Jane', 'params'))).toMatchObject({
      status: 400,
    });
  });
});

describe('readTemplateParams', () => {
  it('reads positional values and the structured object', () => {
    expect(readTemplateParams(undefined)).toEqual({});
    expect(readTemplateParams(['A', 1])).toEqual({
      templateParams: ['A', '1'],
    });
    expect(
      readTemplateParams({
        body: ['A', 2.5],
        headerText: 7,
        headerMediaUrl: null,
        buttonParams: { 0: 123, 1: null },
      })
    ).toEqual({
      templateMessageParams: {
        body: ['A', '2.5'],
        headerText: '7',
        buttonParams: { 0: '123' },
      },
    });
    expect(
      readTemplateParams({ buttonParams: [null, 'x'] }).templateMessageParams
    ).toEqual({ buttonParams: { 1: 'x' } });
  });

  it.each([
    'text',
    7,
    ['A', null],
    { body: 'A' },
    { body: ['A', true] },
    { headerText: false },
    { buttonParams: 'x' },
    { buttonParams: { 0: {} } },
  ])('refuses %j', (params) => {
    expect(refusal(() => readTemplateParams(params))).toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });
});
