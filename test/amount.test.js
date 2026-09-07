// toAmount decides whether a money figure reaches the scorer at all.
//
// The rule it enforces: REFUSE anything that is not already a clean number.
// The temptation is to be helpful and parse "ZAR 1.5 million" — and the engine's
// own generic parser does exactly that, arriving at 1.5. A 1.5-million-rand
// grant then scores ZERO against any sane range, routes red, and no one ever
// looks at it. Returning null instead scores it "not stated", which is honest
// and still puts it in front of a person.
//
// So a wrong number is a much worse failure than no number, and these tests
// pin that asymmetry down.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toAmount } from '../lib/extract.js';

describe('accepts what is unambiguous', () => {
  const ok = [
    [50000, 50000],           // already a number
    ['50000', 50000],
    ['50,000', 50000],        // thousands separator
    ['50 000', 50000],        // the South African convention
    ['1500000.50', 1500000.5],
    [0, 0],
  ];
  for (const [input, expected] of ok) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(toAmount(input), expected);
    });
  }
});

describe('refuses anything it would have to guess at', () => {
  // Every one of these, parsed helpfully, produces a WRONG figure. The engine's
  // generic digit-strip turns them into 1.5, 50, 2 and 50000100000 respectively.
  const refuse = [
    'ZAR 1.5 million',
    '$50k',
    'up to EUR 2m',
    'USD 50,000-100,000',
    'R50 000 per year',
    'fifty thousand',
    'unknown',
    'Not stated',
    'TBC',
    '',
    '   ',
    null,
    undefined,
    {},
    [],
    NaN,
    Infinity,
    -5000,                    // a negative grant is not a grant
  ];
  for (const input of refuse) {
    test(`${JSON.stringify(input) ?? String(input)} -> null`, () => {
      assert.equal(toAmount(input), null,
        'an ambiguous amount must be null (unknown), never a guessed number');
    });
  }
});

describe('the specific failure this prevents', () => {
  test('"ZAR 1.5 million" never becomes the number 1.5', () => {
    const got = toAmount('ZAR 1.5 million');
    assert.notEqual(got, 1.5, 'this is the bug: a 1.5m grant scored as 1.5 routes red');
    assert.equal(got, null);
  });

  test('a stated range never becomes its digits concatenated', () => {
    assert.notEqual(toAmount('USD 50,000-100,000'), 50000100000);
    assert.equal(toAmount('USD 50,000-100,000'), null);
  });
});
