// Resources — the org's key/value store, keyed on the NEWSROOM.
//
// WHY THIS EXISTS, because it looks like a pointless wrapper around host.store
// until you read the runtime:
//
//   grounded-node-runtime/src/server-hosted.js:  const tenantOf = (u) => String(u.id)
//
// The runtime scopes host.store to the SIGNED-IN USER. That is right for
// personal scratch state and wrong for everything this Node keeps there — the
// criteria card, the org's documents, the discussion on an opportunity, the
// proposal drafts. Every one of those belongs to the organisation, and the
// Postgres tables beside them are already keyed per newsroom (tenantOf in
// engine.js resolves it properly). Leaving the split in place gives a client:
//
//   - person A fills the criteria card; person B signs in to an empty one, and
//     the scan refuses outright ("Set your search criteria first")
//   - B fills their own card, which writes a new criteria version for the WHOLE
//     newsroom — so B silently redefines the org's scoring while A's card still
//     shows A's version
//   - a proposal one colleague drafted is invisible to the person who has to
//     send it
//
// The tracker's CLAUDE.md records the runtime's per-user keying as an open data
// decision rather than a bug to quietly fix, because rekeying would orphan the
// rows live Nodes have already written. This Node has written none — it has
// never been deployed — so it can simply be correct from the start, in-Node,
// without touching the runtime or any other Node.
//
// Interface is deliberately identical to host.store (list/get/put/delete over
// JSON values) so call sites read the same and the runtime remains a drop-in
// if its keying is ever fixed centrally.

import { getPool, requirePool } from './pool.js';

const TABLE = 'resources.tenant_store';

/**
 * A store bound to one newsroom. Pass the id from engine.js's tenantOf(req) —
 * the same resolution the Postgres tables use, so both halves of a tenant's
 * data agree.
 */
export function tenantStore(newsroomId) {
  if (!newsroomId) throw new Error('tenantStore needs a newsroom id');
  const pool = () => requirePool();
  return {
    list: async (collection) => {
      const r = await pool().query(
        `SELECT key, value FROM ${TABLE} WHERE newsroom_id=$1 AND collection=$2 ORDER BY key`,
        [newsroomId, collection]);
      return r.rows.map((row) => ({ key: row.key, value: row.value }));
    },
    get: async (collection, key) => {
      const r = await pool().query(
        `SELECT value FROM ${TABLE} WHERE newsroom_id=$1 AND collection=$2 AND key=$3`,
        [newsroomId, collection, String(key)]);
      return r.rows.length ? r.rows[0].value : null;
    },
    put: async (collection, key, value) => {
      await pool().query(
        `INSERT INTO ${TABLE} (newsroom_id, collection, key, value)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (newsroom_id, collection, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [newsroomId, collection, String(key), JSON.stringify(value ?? null)]);
    },
    delete: async (collection, key) => {
      await pool().query(
        `DELETE FROM ${TABLE} WHERE newsroom_id=$1 AND collection=$2 AND key=$3`,
        [newsroomId, collection, String(key)]);
    },
  };
}

/**
 * The store a route should use: newsroom-keyed when this install has Postgres,
 * host.store when it doesn't.
 *
 * The fallback is for a DB-less LOCAL install, which pool.js explicitly
 * supports ("the Node still boots… docs, chat all work" without DATABASE_URL).
 * Local is a single user on their own machine, so host.store's per-user keying
 * is not wrong there — there is only one person, and tenantOf returns the fixed
 * local tenant. Hosted always has a pool, so hosted always gets the correct
 * newsroom keying, which is the case that was broken.
 */
export function orgStore(host, newsroomId) {
  if (!getPool()) return host.store;
  return tenantStore(newsroomId);
}
