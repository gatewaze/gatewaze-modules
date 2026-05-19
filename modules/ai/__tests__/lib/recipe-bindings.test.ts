/**
 * Recipe parameter binding tests — covers spec §4.4 (sanitisation) +
 * §4.5 (outputs_from path resolution + coercion) + §9 (fanout detection).
 *
 * Reaches in via the `__internal` export on run-recipe.ts. These are
 * pure helpers — no IO, no provider — so unit-testing them in isolation
 * is the cleanest way to lock the substitution semantics.
 */

import { describe, expect, it } from 'vitest';
import { __internal } from '../../lib/recipes/run-recipe.js';
import type { ParsedRecipe } from '../../lib/recipes/parse-recipe.js';

const {
  bindParameters,
  sanitiseParamValue,
  bindStepInputs,
  resolveOutputsFrom,
  coerceForParam,
  detectFanout,
} = __internal;

function param(
  key: string,
  input_type: ParsedRecipe['parameters'][number]['input_type'] = 'string',
  requirement: 'required' | 'optional' = 'optional',
  options?: string[],
): ParsedRecipe['parameters'][number] {
  return { key, input_type, requirement, ...(options ? { options } : {}) };
}

const noOutputs = new Map<string, { structured: Record<string, unknown> | null; narrative: string }>();

describe('sanitiseParamValue', () => {
  it('strips {{ and }} sequences', () => {
    expect(sanitiseParamValue('hi {{ inject }} bye')).toBe('hi  inject  bye');
  });

  it('strips backticks', () => {
    expect(sanitiseParamValue('cmd `evil` thing')).toBe('cmd evil thing');
  });

  it('strips ${ but leaves } intact', () => {
    expect(sanitiseParamValue('a ${HOME} b')).toBe('a HOME} b');
  });

  it('stringifies arrays as JSON', () => {
    expect(sanitiseParamValue(['a', 'b'])).toBe('["a","b"]');
  });

  it('serialises Date as ISO-8601', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(sanitiseParamValue(d)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('preserves numbers and booleans as strings', () => {
    expect(sanitiseParamValue(42)).toBe('42');
    expect(sanitiseParamValue(true)).toBe('true');
  });

  it('collapses whitespace runs > 1 KiB', () => {
    const long = 'a' + ' '.repeat(2000) + 'b';
    expect(sanitiseParamValue(long)).toBe('a b');
  });
});

describe('bindParameters', () => {
  const declared = [param('name', 'string'), param('count', 'number')];

  it('substitutes declared params', () => {
    const out = bindParameters('Hi {{ name }}, count={{ count }}.', { name: 'alice', count: 5 }, declared);
    expect(out).toBe('Hi alice, count=5.');
  });

  it('sanitises injection attempts in supplied values', () => {
    const out = bindParameters('Hi {{ name }}', { name: '{{ inject }} `evil` ${HOME}', count: 0 }, declared);
    expect(out).toBe('Hi  inject  evil HOME}');
  });

  it('throws when required param missing', () => {
    const req = [param('must', 'string', 'required')];
    expect(() => bindParameters('Hi {{ must }}', {}, req)).toThrow(/missing required parameter 'must'/);
  });

  it('treats unknown {{ key }} as empty (defensive — parser blocks this)', () => {
    const out = bindParameters('Hi {{ unknown }}', { name: 'a', count: 1 }, declared);
    expect(out).toBe('Hi ');
  });
});

describe('resolveOutputsFrom', () => {
  const outputs = new Map<string, { structured: Record<string, unknown> | null; narrative: string }>([
    [
      'step-0',
      {
        structured: {
          status: 'ok',
          candidates: [
            { title: 'first', score: 10 },
            { title: 'second', score: 5 },
          ],
        },
        narrative: '',
      },
    ],
    ['step-1', { structured: null, narrative: 'free text' }],
  ]);

  it('walks step-N.field path', () => {
    expect(resolveOutputsFrom('step-0.status', outputs)).toBe('ok');
  });

  it('walks step-N.array[index].field', () => {
    expect(resolveOutputsFrom('step-0.candidates[0].title', outputs)).toBe('first');
    expect(resolveOutputsFrom('step-0.candidates[1].score', outputs)).toBe(5);
  });

  it('returns array values', () => {
    expect(resolveOutputsFrom('step-0.candidates', outputs)).toEqual([
      { title: 'first', score: 10 },
      { title: 'second', score: 5 },
    ]);
  });

  it('throws when ref lacks step-N prefix', () => {
    expect(() => resolveOutputsFrom('candidates[0]', outputs)).toThrow(/must start with step-N/);
  });

  it('throws when step has not run', () => {
    expect(() => resolveOutputsFrom('step-9.x', outputs)).toThrow(/step has not run/);
  });

  it('throws when step has no structured output', () => {
    expect(() => resolveOutputsFrom('step-1.x', outputs)).toThrow(/no structured output/);
  });

  it('throws on out-of-range array index (undefined leaf)', () => {
    expect(() => resolveOutputsFrom('step-0.candidates[99]', outputs)).toThrow(/path not found/);
  });

  it('throws on non-object descent', () => {
    expect(() => resolveOutputsFrom('step-0.status.foo', outputs)).toThrow(/non-object/);
  });

  it('throws on trailing garbage after valid path', () => {
    expect(() => resolveOutputsFrom('step-0.status garbage', outputs)).toThrow(/invalid syntax|trailing/);
  });
});

describe('coerceForParam', () => {
  it('string passthrough; non-string JSON-encodes', () => {
    expect(coerceForParam('hello', param('k', 'string'), 'ref')).toBe('hello');
    expect(coerceForParam({ a: 1 }, param('k', 'string'), 'ref')).toBe('{"a":1}');
  });

  it('number: passes numbers; coerces numeric strings; throws otherwise', () => {
    expect(coerceForParam(42, param('k', 'number'), 'ref')).toBe(42);
    expect(coerceForParam('3.14', param('k', 'number'), 'ref')).toBe(3.14);
    expect(() => coerceForParam('nope', param('k', 'number'), 'ref')).toThrow(/expected number/);
  });

  it('boolean: passes booleans; coerces "true"/"false"; throws otherwise', () => {
    expect(coerceForParam(true, param('k', 'boolean'), 'ref')).toBe(true);
    expect(coerceForParam('false', param('k', 'boolean'), 'ref')).toBe(false);
    expect(() => coerceForParam('yes', param('k', 'boolean'), 'ref')).toThrow(/expected boolean/);
  });

  it('date: parses ISO-8601; throws otherwise', () => {
    const d = coerceForParam('2026-05-19T00:00:00.000Z', param('k', 'date'), 'ref');
    expect(d).toBeInstanceOf(Date);
    expect(() => coerceForParam('not-a-date', param('k', 'date'), 'ref')).toThrow(/ISO-8601/);
  });

  it('select: rejects values outside option set', () => {
    const p = param('k', 'select', 'optional', ['a', 'b']);
    expect(coerceForParam('a', p, 'ref')).toBe('a');
    expect(() => coerceForParam('z', p, 'ref')).toThrow(/not in options/);
  });
});

describe('bindStepInputs', () => {
  const declared = [
    param('name', 'string', 'required'),
    param('count', 'number'),
  ];

  it('resolves outputs_from into a literal then substitutes', () => {
    const outputs = new Map([
      [
        'step-0',
        { structured: { items: [{ name: 'one' }, { name: 'two' }] }, narrative: '' },
      ],
    ]);
    const out = bindStepInputs(
      'Pick {{ name }} ({{ count }})',
      { name: { outputs_from: 'step-0.items[0].name' }, count: 7 },
      declared,
      {},
      outputs,
    );
    expect(out).toBe('Pick one (7)');
  });

  it('caller params win over values block', () => {
    const out = bindStepInputs(
      'Hi {{ name }}',
      { name: 'from-values' },
      [param('name', 'string')],
      { name: 'from-caller' },
      noOutputs,
    );
    expect(out).toBe('Hi from-caller');
  });

  it('throws on missing required when no caller param + no values entry', () => {
    expect(() =>
      bindStepInputs('Hi {{ name }}', {}, [param('name', 'string', 'required')], {}, noOutputs),
    ).toThrow(/required parameter 'name'/);
  });

  it('throws on outputs_from non-string', () => {
    expect(() =>
      bindStepInputs(
        '{{ name }}',
        { name: { outputs_from: 123 } },
        [param('name', 'string')],
        {},
        noOutputs,
      ),
    ).toThrow(/outputs_from must be a string/);
  });
});

describe('detectFanout', () => {
  it('returns kind=none when no arrays', () => {
    expect(detectFanout({ a: 'foo', b: 42 }, noOutputs)).toEqual({ kind: 'none' });
  });

  it('detects literal array fanout', () => {
    const d = detectFanout({ items: ['a', 'b', 'c'] }, noOutputs);
    expect(d.kind).toBe('array');
    if (d.kind !== 'array') return;
    expect(d.key).toBe('items');
    expect(d.elements).toEqual(['a', 'b', 'c']);
  });

  it('detects outputs_from array fanout', () => {
    const outputs = new Map([
      ['step-0', { structured: { picks: [1, 2, 3] }, narrative: '' }],
    ]);
    const d = detectFanout({ items: { outputs_from: 'step-0.picks' } }, outputs);
    expect(d.kind).toBe('array');
    if (d.kind !== 'array') return;
    expect(d.elements).toEqual([1, 2, 3]);
  });

  it('multi-array → kind=multi (ambiguous, executor will fail)', () => {
    const d = detectFanout({ a: [1, 2], b: [3, 4] }, noOutputs);
    expect(d.kind).toBe('multi');
    if (d.kind !== 'multi') return;
    expect(d.keys.sort()).toEqual(['a', 'b']);
  });

  it('non-array outputs_from does not trigger fanout', () => {
    const outputs = new Map([
      ['step-0', { structured: { picks: 'single' }, narrative: '' }],
    ]);
    expect(detectFanout({ items: { outputs_from: 'step-0.picks' } }, outputs)).toEqual({ kind: 'none' });
  });
});
