// What these guard, and why they are worth having in a repo with no other tests:
// both invariants below fail INVISIBLY. Nothing throws, no route 500s — the
// scoring just quietly becomes wrong, and the only symptom is a client
// wondering why their shortlist looks off.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEntity } from '@developai/grounded-opportunity-engine';
import { STARTER_FUNDING_CRITERIA, applyAmountRange, describeRule } from '../lib/engine.js';

const weights = () => JSON.parse(JSON.stringify(STARTER_FUNDING_CRITERIA.weights));
const crit = (w) => ({ thresholds: STARTER_FUNDING_CRITERIA.thresholds, weights: w });
const grantSize = (w) => w.find((x) => x.component === 'grant_size');

const CALL = {
  title: 'Community health strengthening grant',
  funder: 'Example Trust',
  summary: 'Supports community health and youth programmes in Namibia and Zambia.',
  eligibility: 'Open to registered non-profits in Southern Africa.',
  jurisdiction: 'Namibia',
  closing_date: new Date(Date.now() + 40 * 864e5).toISOString(),
  amount: 'ZAR 1.5 million',
  amount_for_scoring: 1500000,
};

describe('grant_size ships inert', () => {
  test('an unconfigured grant_size changes no score and no band', () => {
    // If this fails, every tenant silently got a free component the day it
    // shipped and their green/red lines moved under them.
    const withIt = scoreEntity(CALL, crit(weights()));
    const withoutIt = scoreEntity(CALL, crit(weights().filter((w) => w.component !== 'grant_size')));
    assert.equal(withIt.total, withoutIt.total, 'total score must not move');
    assert.equal(withIt.band, withoutIt.band, 'band must not move');
  });

  test('it ships at weight 0 with no bounds', () => {
    const g = grantSize(weights());
    assert.equal(Number(g.weight), 0);
    assert.equal(g.rule.ideal_min, undefined);
    assert.equal(g.rule.ideal_max, undefined);
  });
});

describe('weight follows configuration', () => {
  // The rule an unbounded `range` breaks: it scores EVERY stated amount 1, so
  // a weight above zero with no bounds is free marks for everyone.
  test('no range -> weight 0 and no bounds', () => {
    const g = grantSize(weights());
    applyAmountRange(g, null, null);
    assert.equal(Number(g.weight), 0);
    assert.equal(g.rule.ideal_min, undefined);
  });

  test('a range raises the weight off zero and sets bounds', () => {
    const g = grantSize(weights());
    applyAmountRange(g, '500000', '3000000');
    assert.ok(Number(g.weight) > 0, 'a configured range must count for something');
    assert.equal(g.rule.ideal_min, 500000);
    assert.equal(g.rule.ideal_max, 3000000);
  });

  test('clearing the range stands the component back down', () => {
    const g = grantSize(weights());
    applyAmountRange(g, '500000', '3000000');
    applyAmountRange(g, '', '');
    assert.equal(Number(g.weight), 0, 'cleared bounds must not leave a weighted unbounded rule');
    assert.equal(g.rule.ideal_min, undefined);
    assert.equal(g.rule.ideal_max, undefined);
  });

  test('a weight the org tuned itself is not overwritten', () => {
    const g = grantSize(weights());
    g.weight = 4.5;
    applyAmountRange(g, '500000', '3000000');
    assert.equal(Number(g.weight), 4.5);
  });

  test('bounds entered backwards are swapped, separators tolerated', () => {
    const back = grantSize(weights());
    applyAmountRange(back, '3000000', '500000');
    assert.equal(back.rule.ideal_min, 500000);
    assert.equal(back.rule.ideal_max, 3000000);

    const sep = grantSize(weights());
    applyAmountRange(sep, '500 000', '3,000,000');
    assert.equal(sep.rule.ideal_min, 500000);
    assert.equal(sep.rule.ideal_max, 3000000);
  });
});

describe('grant_size scores sensibly once configured', () => {
  const configured = () => {
    const w = weights();
    applyAmountRange(grantSize(w), '500000', '3000000');
    return w;
  };
  const scoreFor = (amount) => {
    const r = scoreEntity({ ...CALL, amount_for_scoring: amount }, crit(configured()));
    return (r.components ?? r.component_scores).grant_size.score;
  };

  test('inside the band scores full marks', () => {
    assert.equal(scoreFor(1500000), 1);
    assert.equal(scoreFor(3000000), 1);
  });

  test('an unstated amount is unknown, NOT too small', () => {
    // The distinction that keeps a good call in front of a person: a missing
    // amount must never score like a rejected one.
    const missing = scoreFor(null);
    assert.ok(missing > 0, 'a call that states no amount must not score zero');
    assert.ok(missing < 1);
  });

  test('a grant larger than hoped for still reaches a human', () => {
    // Derived hard_max is ideal_max * 10, so 12m stays well above zero.
    assert.ok(scoreFor(12000000) > 0, 'a too-big grant is a nice problem, not a rejection');
  });

  test('below the floor falls away but is still visible', () => {
    const small = scoreFor(250000);
    assert.ok(small > 0 && small < 1);
  });
});

describe('the org can read the rule', () => {
  test('an unset range says so instead of implying a default', () => {
    const g = grantSize(weights());
    const text = describeRule(g.rule);
    assert.match(text, /No size range set yet/i);
    assert.doesNotMatch(text, /Rule type/, 'must not fall through to the generic describer');
  });

  test('a set range reads back the actual numbers', () => {
    const g = grantSize(weights());
    applyAmountRange(g, '500000', '3000000');
    const text = describeRule(g.rule);
    assert.match(text, /500\s*000/);
    assert.match(text, /3\s*000\s*000/);
  });
});
