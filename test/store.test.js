// Guards the tenancy fix: the org's own state (criteria card, documents, chats,
// proposal drafts) must be keyed on the NEWSROOM, never on the signed-in user.
//
// The runtime keys host.store on the user (server-hosted.js:
// `const tenantOf = (u) => String(u.id)`). If this Node drifts back to that,
// nothing breaks loudly — a client's colleagues simply stop seeing each other's
// work, and whoever saves the criteria card last silently redefines the whole
// newsroom's scoring. That is the failure these tests exist to catch.
//
// No database needed: a stub pool records the SQL and the bound parameters, so
// we can assert WHICH id every query is scoped to. A live-Postgres integration
// test sits at the bottom, skipped honestly when there is no DATABASE_URL.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const NEWSROOM = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// A pool that answers nothing but remembers everything it was asked.
function stubPool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; },
  };
}

let tenantStore, orgStore;
before(async () => {
  // pool.js reads DATABASE_URL at call time via getPool(); set it so orgStore
  // takes the Postgres path rather than the local host.store fallback.
  process.env.DATABASE_URL ||= 'postgresql://unused@127.0.0.1:1/none';
  ({ tenantStore, orgStore } = await import('../lib/store.js'));
});

describe('every store query is scoped to the newsroom', () => {
  // A stub pool records the SQL and the bound parameters, so these assert what
  // the code actually DOES rather than what it looks like.
  const withStub = () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    return { calls, store: tenantStore(NEWSROOM, () => pool) };
  };

  test('read, write, list and delete all bind the NEWSROOM id, never the user', async () => {
    const { calls, store } = withStub();
    await store.get('criteria', 'main');
    await store.put('criteria', 'main', { themes: ['health'] });
    await store.list('docs');
    await store.delete('docs', 'd1');

    assert.equal(calls.length, 4, 'all four operations should have hit the pool');
    for (const { sql, params } of calls) {
      assert.equal(params[0], NEWSROOM,
        `expected the newsroom id as the first bound parameter, got ${params[0]}`);
      assert.notEqual(params[0], USER, 'the signed-in user id must never be the key');
      assert.match(sql, /resources\.tenant_store/,
        'must use the Node\'s own table, not the runtime\'s per-user store');
      assert.doesNotMatch(sql, /node_resources_store/);
    }
  });

  test('two different users at one newsroom produce identical keying', async () => {
    // The actual regression: A and B are different people, same organisation.
    const a = withStub(); const b = withStub();
    await a.store.get('criteria', 'main');
    await b.store.get('criteria', 'main');
    assert.deepEqual(a.calls[0].params, b.calls[0].params,
      'colleagues must read the same row');
  });

  test('different newsrooms stay separate', async () => {
    const OTHER = '99999999-9999-9999-9999-999999999999';
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push(params); return { rows: [] }; } };
    await tenantStore(NEWSROOM, () => pool).get('criteria', 'main');
    await tenantStore(OTHER, () => pool).get('criteria', 'main');
    assert.notEqual(calls[0][0], calls[1][0], 'two organisations must not share a key');
  });

  test('a store cannot be built without a tenant', () => {
    assert.throws(() => tenantStore(undefined), /needs a newsroom id/i);
    assert.throws(() => tenantStore(''), /needs a newsroom id/i);
  });
});

describe('orgStore chooses the right backing', () => {
  test('with a pool it uses the newsroom-keyed store, not host.store', () => {
    const hostStore = { get: async () => 'FROM_HOST_STORE' };
    const s = orgStore({ store: hostStore }, NEWSROOM);
    assert.notEqual(s, hostStore, 'hosted installs must not fall back to host.store');
  });

  test('without a pool it falls back to host.store (DB-less local install)', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const hostStore = { get: async () => 'FROM_HOST_STORE' };
      const s = orgStore({ store: hostStore }, NEWSROOM);
      assert.equal(s, hostStore, 'a local install with no DB still needs a working store');
    } finally { process.env.DATABASE_URL = saved; }
  });
});

describe('no module reaches for host.store behind the helpers', () => {
  test('routes, nightly and mcp all go through orgStore/tenantStore', async () => {
    const fs = await import('node:fs');
    for (const f of ['routes.js', 'nightly.js', 'mcp.js', 'context.js']) {
      const src = fs.readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8');
      const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      assert.doesNotMatch(code, /host\.store\./,
        `${f} must not use host.store directly — org state is newsroom-keyed (lib/store.js)`);
    }
  });
});

// ── Integration: two colleagues, one org, against a real Postgres ───────────
// Runs only when RESOURCES_TEST_DATABASE_URL points at a throwaway database.
const DB = process.env.RESOURCES_TEST_DATABASE_URL;
describe('integration: colleagues share, tenants stay isolated', { skip: !DB && 'set RESOURCES_TEST_DATABASE_URL to run' }, () => {
  test('B sees the card A saved; a different org sees nothing', async () => {
    process.env.DATABASE_URL = DB;
    const { ensureSchema } = await import('../lib/schema.js');
    const { getCriteria, saveCriteria } = await import('../lib/context.js');
    const { requirePool } = await import('../lib/pool.js');
    const pool = requirePool();
    await ensureSchema(pool);

    const OTHER = '99999999-9999-9999-9999-999999999999';
    await pool.query('DELETE FROM resources.tenant_store WHERE newsroom_id = ANY($1::uuid[])', [[NEWSROOM, OTHER]]);

    // A and B are different USERS at the same newsroom.
    const storeA = tenantStore(NEWSROOM);
    const storeB = tenantStore(NEWSROOM);
    await saveCriteria(storeA, { themes: ['health', 'youth'], amount_min: 500000, amount_max: 3000000 });

    const asB = await getCriteria(storeB);
    assert.deepEqual(asB.themes, ['health', 'youth'], 'a colleague must see the org\'s card');
    assert.equal(asB.amount_min, 500000);

    const asOther = await getCriteria(tenantStore(OTHER));
    assert.deepEqual(asOther.themes, [], 'a different organisation must see nothing');

    await pool.query('DELETE FROM resources.tenant_store WHERE newsroom_id = ANY($1::uuid[])', [[NEWSROOM, OTHER]]);
    await pool.end();
  });
});
