// Resources — the overnight sweep.
//
// Without this the Node only finds funding when somebody asks, which is not a
// service — the point is that a fundraiser opens the morning to a shortlist
// they did not have to go looking for. Mirrors node-leadfinder's nightly: for
// every tenant with a profile, search the wired sources on that tenant's own
// themes, run the engine pipeline, log an honest digest.
//
// COST: each new call costs two model calls (extract + evidence). The per-run
// cap keeps a night bounded — RESOURCES_NIGHTLY_CAP (default 12 ≈ a few US
// cents on Haiku). Items beyond the cap are simply not fetched this run; the
// next run picks up whatever is newly posted, and grants.gov dedups on
// external_id so nothing is processed twice.

import { requirePool } from './pool.js';
import { SCHEMA, pipelineFor } from './engine.js';
import { orgContext, getCriteria } from './context.js';
import { fetchGrantsGov } from './sources-gov.js';

const CAP = parseInt(process.env.RESOURCES_NIGHTLY_CAP, 10) || 12;

// The hosted host is per-request; the nightly has no request, so build the
// minimal host shape the profile helpers need (host.store, newsroom-scoped).
function storeHostFor(pool, newsroomId) {
  const table = 'node_resources_store';
  return {
    newsroomId,
    store: {
      get: async (kind, key) => {
        const { rows: [r] } = await pool.query(
          `SELECT value FROM ${table} WHERE newsroom_id = $1 AND kind = $2 AND key = $3`,
          [newsroomId, kind, key]).catch(() => ({ rows: [] }));
        return r?.value ?? null;
      },
      list: async (kind) => {
        const { rows } = await pool.query(
          `SELECT key, value FROM ${table} WHERE newsroom_id = $1 AND kind = $2`,
          [newsroomId, kind]).catch(() => ({ rows: [] }));
        return rows;
      },
      put: async () => { /* the nightly never writes profile state */ },
    },
  };
}

export async function sweepAllTenants() {
  const pool = requirePool();
  // Every tenant that has touched this Node — a profile, a source or a call.
  const { rows: tenants } = await pool.query(
    `SELECT DISTINCT newsroom_id FROM ${SCHEMA}.sources
      UNION SELECT DISTINCT newsroom_id FROM ${SCHEMA}.funding_calls`);

  const tally = { tenants: 0, found: 0, kept: 0, errors: 0 };
  for (const { newsroom_id: newsroomId } of tenants) {
    try {
      const host = storeHostFor(pool, newsroomId);
      const criteria = await getCriteria(host);
      const keywords = [...(criteria.themes || []), ...(criteria.keywords || [])].filter(Boolean);
      if (!keywords.length) {
        console.log(`[resources nightly] ${newsroomId}: no themes in the profile — skipping (a scan without themes returns noise, not leads).`);
        continue;
      }

      const r = await fetchGrantsGov({ keywords, limit: CAP });
      console.log(`[resources nightly] ${newsroomId}: ${r.note}`);
      if (r.error) tally.errors++;
      if (!r.items.length) continue;

      const { rows: [src] } = await pool.query(
        `SELECT id FROM ${SCHEMA}.sources WHERE newsroom_id = $1 AND name = 'grants.gov' LIMIT 1`, [newsroomId]);
      const sourceId = src?.id || (await pool.query(
        `INSERT INTO ${SCHEMA}.sources (newsroom_id, name, kind, origin) VALUES ($1,'grants.gov','api','seed') RETURNING id`,
        [newsroomId])).rows[0].id;

      const out = await pipelineFor(await orgContext(host)).runPipeline({ newsroomId, sourceId, items: r.items });
      const d = out.digest || {};
      console.log(`[resources nightly] ${newsroomId}: ${d.new || 0} new — ${d.green || 0} strong fit, ${d.amber || 0} worth a look, ${d.red || 0} poor fit.`);
      tally.tenants++;
      tally.found += r.items.length;
      tally.kept += d.new || 0;
    } catch (e) {
      tally.errors++;
      console.error(`[resources nightly] tenant ${newsroomId}:`, e.message);
    }
  }
  return tally;
}

export default sweepAllTenants;
