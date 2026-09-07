// mergedBase resets every rule to the STARTER's shape and overlays the tenant's
// own data on top. That is the migration path — it is how a tenant created
// before a component existed picks it up — but it means anything the tenant
// tuned has to be explicitly carried, or it is silently dropped on the next
// save.
//
// The trap, sprung once already during this work: grant_size ships with NO
// bounds. Carry the weight but not the bounds and a rules-panel save leaves a
// WEIGHTED UNBOUNDED range, which scores every stated amount 1 — free marks for
// every call, and the band lines move. Nothing errors; the shortlist just goes
// quietly wrong.
//
// These drive the real saveRules / refreshCriteriaFromForm against a stub pool,
// and assert on what would actually have been persisted.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { saveRules, refreshCriteriaFromForm, STARTER_FUNDING_CRITERIA, applyAmountRange } from '../lib/engine.js';

const NEWSROOM = '11111111-1111-1111-1111-111111111111';

// A tenant whose active version already has a configured grant range and a
// weight they tuned themselves.
function activeVersion() {
  const weights = JSON.parse(JSON.stringify(STARTER_FUNDING_CRITERIA.weights));
  const gs = weights.find((w) => w.component === 'grant_size');
  applyAmountRange(gs, '500000', '3000000');
  gs.weight = 2.5;
  weights.find((w) => w.component === 'theme_fit').rule.keywords = ['health', 'youth'];
  return weights;
}

// Stub pool: answers the reads mergedBase/writeVersion make, and records the
// criteria_weights rows the write would have inserted.
function stubPool(weights) {
  const persisted = [];
  const answer = (sql) => {
    if (/FROM resources\.criteria_versions/.test(sql) && /status = 'active'/.test(sql))
      return { rows: [{ id: 'ver-1', version: 3, thresholds: STARTER_FUNDING_CRITERIA.thresholds }] };
    if (/FROM resources\.criteria_weights/.test(sql)) return { rows: weights };
    if (/MAX\(version\)/.test(sql)) return { rows: [{ v: 3 }] };
    if (/INSERT INTO resources\.criteria_versions/.test(sql)) return { rows: [{ id: 'ver-2', version: 4 }] };
    return { rows: [] };
  };
  const client = {
    query: async (sql, params) => {
      if (/INSERT INTO resources\.criteria_weights/.test(sql)) {
        persisted.push({ component: params[1], weight: Number(params[2]), rule: JSON.parse(params[4]) });
      }
      return answer(sql);
    },
    release() {},
  };
  return { persisted, pool: { query: async (sql) => answer(sql), connect: async () => client } };
}

const grantSizeOf = (persisted) => persisted.find((p) => p.component === 'grant_size');

// The invariant, stated once: a weighted grant_size must always have bounds.
function assertSafe(persisted, context) {
  const g = grantSizeOf(persisted);
  assert.ok(g, 'grant_size must be persisted');
  const bounded = g.rule.ideal_min != null || g.rule.ideal_max != null;
  if (Number(g.weight) > 0) {
    assert.ok(bounded, `${context}: a weighted grant_size with no bounds is free marks for every call`);
  }
}

describe('a rules-panel save preserves what the org configured', () => {
  test('grant-size bounds survive, and so does the tuned weight', async () => {
    const { pool, persisted } = stubPool(activeVersion());
    // The rules panel only ever sends weights.
    await saveRules(pool, NEWSROOM, { weights: [{ component: 'theme_fit', weight: 3 }], thresholds: {} });

    const g = grantSizeOf(persisted);
    assert.equal(g.rule.ideal_min, 500000, 'bounds must not be reset to the starter\'s (none)');
    assert.equal(g.rule.ideal_max, 3000000);
    assert.equal(g.weight, 2.5, 'the org\'s own tuning must survive');
    assertSafe(persisted, 'rules-panel save');
  });

  test('keyword lists still survive too (the older trap)', async () => {
    const { pool, persisted } = stubPool(activeVersion());
    await saveRules(pool, NEWSROOM, { weights: [{ component: 'theme_fit', weight: 3 }], thresholds: {} });
    const theme = persisted.find((p) => p.component === 'theme_fit');
    assert.deepEqual(theme.rule.keywords, ['health', 'youth']);
  });
});

describe('a criteria-card save applies the org\'s numbers', () => {
  test('restating the range keeps it', async () => {
    const { pool, persisted } = stubPool(activeVersion());
    await refreshCriteriaFromForm(pool, NEWSROOM, {
      themes: ['health'], amount_min: '500000', amount_max: '3000000',
    });
    const g = grantSizeOf(persisted);
    assert.equal(g.rule.ideal_min, 500000);
    assert.equal(g.rule.ideal_max, 3000000);
    assertSafe(persisted, 'criteria-card save');
  });

  test('clearing the range stands the component down to weight 0', async () => {
    const { pool, persisted } = stubPool(activeVersion());
    await refreshCriteriaFromForm(pool, NEWSROOM, {
      themes: ['health'], amount_min: '', amount_max: '',
    });
    const g = grantSizeOf(persisted);
    assert.equal(g.weight, 0, 'an unbounded rule must not keep a weight');
    assert.equal(g.rule.ideal_min, undefined);
    assertSafe(persisted, 'cleared range');
  });

  test('a tenant who never set a range is left inert', async () => {
    const fresh = JSON.parse(JSON.stringify(STARTER_FUNDING_CRITERIA.weights));
    const { pool, persisted } = stubPool(fresh);
    await refreshCriteriaFromForm(pool, NEWSROOM, { themes: ['health'] });
    assert.equal(grantSizeOf(persisted).weight, 0);
    assertSafe(persisted, 'never configured');
  });
});
