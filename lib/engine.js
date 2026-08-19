// Resources — the engine wiring: tenancy, criteria, and a per-tenant pipeline.
//
// Tenancy is resolved IN-NODE (the engine field lesson: runtime tenantOf()
// pins hosted tenants to the JWT user id, which is wrong for relational Nodes):
//   hosted → verify the tracker JWT cookie, prefer a newsroom_id claim, else
//            team_members lookup, FAIL CLOSED;
//   local  → one fixed tenant (single-user install).
//
// The pipeline is built per request because checkpoint 2 (evidence/fit) embeds
// the tenant's org context — cheap: createPipeline is closures, no I/O.

import jwt from 'jsonwebtoken';
import { createPipeline } from '@developai/grounded-opportunity-engine';
import { requirePool } from './pool.js';
import { extractCallFields, makeEvidence } from './extract.js';

export const ENTITY = 'funding_call';
export const SCHEMA = 'resources';
const LOCAL_TENANT = '00000000-0000-0000-0000-000000000000';
const HOSTED = () => !!process.env.GROUNDED_HOSTED;

// ── tenancy ──────────────────────────────────────────────────────────────────
export async function tenantOf(req) {
  if (!HOSTED()) return { id: LOCAL_TENANT, email: null };
  const secret = process.env.JWT_SECRET;
  if (!secret) { const e = new Error('JWT_SECRET not configured'); e.status = 500; throw e; }
  const cookies = String(req.headers?.cookie || '').split(';').map((c) => c.trim()).filter(Boolean);
  for (const c of cookies) {
    const val = c.slice(c.indexOf('=') + 1);
    try {
      const payload = jwt.verify(decodeURIComponent(val), secret);
      if (payload?.newsroom_id) return { id: payload.newsroom_id, email: payload.email || null };
      if (payload?.id) {
        const pool = requirePool();
        const { rows: [m] } = await pool.query('SELECT newsroom_id FROM team_members WHERE id = $1', [payload.id]);
        if (m?.newsroom_id) return { id: m.newsroom_id, email: payload.email || null };
      }
    } catch { /* not our cookie — try the next */ }
  }
  const e = new Error('Not signed in.'); e.status = 401; throw e;   // fail closed
}

// ── starter criteria (seed data — the org tunes it in-app) ──────────────────
// Components are fit predictors for a non-profit chasing funding: themes match,
// geography match, enough runway to write a real application, completeness.
// theme/geography keyword lists are REGENERATED from the org's criteria card on
// every save (see refreshCriteriaFromForm) — config edit, never a redeploy.
export const STARTER_FUNDING_CRITERIA = {
  thresholds: { green_min: 65, red_max: 35, hard_rules: ['deadline_runway'] },
  weights: [
    { component: 'theme_fit', weight: 3.0, source: 'prior',
      rule: { type: 'keyword_any', fields: ['title', 'summary', 'eligibility'], keywords: [], miss_score: 0.2, missing_score: 0.3 } },
    { component: 'geography_fit', weight: 2.0, source: 'prior',
      rule: { type: 'keyword_any', fields: ['jurisdiction', 'summary', 'eligibility'], keywords: [], miss_score: 0.3, missing_score: 0.4 } },
    { component: 'deadline_runway', weight: 2.0, source: 'prior',
      rule: { type: 'runway', field: 'closing_date', ideal_min_days: 21, hard_min_days: 5, missing_score: 0.5 } },
    { component: 'completeness', weight: 1.0, source: 'prior',
      rule: { type: 'completeness', fields: ['title', 'funder', 'closing_date', 'eligibility', 'summary'] } },
  ],
};

/**
 * Regenerate the tenant's ACTIVE criteria version from the criteria-card lists
 * (themes/geographies/keywords). Creates a NEW version (history never rewritten)
 * and archives the old active one. Weights/thresholds carry over from the
 * previous active version so in-app tuning survives a list edit.
 */
export async function refreshCriteriaFromForm(pool, newsroomId, { themes = [], geographies = [], keywords = [] }) {
  const { rows: [prev] } = await pool.query(
    `SELECT id, thresholds FROM ${SCHEMA}.criteria_versions
      WHERE newsroom_id = $1 AND entity = $2 AND status = 'active' ORDER BY version DESC LIMIT 1`,
    [newsroomId, ENTITY]
  );
  const base = JSON.parse(JSON.stringify(STARTER_FUNDING_CRITERIA));
  if (prev) {
    const { rows: weights } = await pool.query(
      `SELECT component, weight::float AS weight, source, rule FROM ${SCHEMA}.criteria_weights WHERE criteria_version_id = $1`, [prev.id]);
    if (weights.length) { base.weights = weights; base.thresholds = prev.thresholds || base.thresholds; }
  }
  for (const w of base.weights) {
    if (w.component === 'theme_fit') w.rule.keywords = [...themes, ...keywords].filter(Boolean);
    if (w.component === 'geography_fit') w.rule.keywords = geographies.filter(Boolean);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE ${SCHEMA}.criteria_versions SET status = 'archived' WHERE newsroom_id = $1 AND entity = $2 AND status = 'active'`,
      [newsroomId, ENTITY]);
    const { rows: [mx] } = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS v FROM ${SCHEMA}.criteria_versions WHERE newsroom_id = $1`, [newsroomId]);
    const { rows: [ver] } = await client.query(
      `INSERT INTO ${SCHEMA}.criteria_versions (newsroom_id, version, entity, status, thresholds, notes, activated_at)
       VALUES ($1, $2, $3, 'active', $4::jsonb, 'Regenerated from the criteria card', NOW()) RETURNING id`,
      [newsroomId, mx.v + 1, ENTITY, JSON.stringify(base.thresholds)]);
    for (const w of base.weights) {
      await client.query(
        `INSERT INTO ${SCHEMA}.criteria_weights (criteria_version_id, component, weight, source, rule)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [ver.id, w.component, w.weight, w.source || 'prior', JSON.stringify(w.rule)]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── the per-tenant pipeline ──────────────────────────────────────────────────
export function pipelineFor(orgContext) {
  const pool = requirePool();
  return createPipeline({
    pool,
    schema: SCHEMA,
    entity: ENTITY,
    table: 'funding_calls',
    flags: { table: 'funding_call_flags', fk: 'funding_call_id' },
    rawEntityFk: 'funding_call_id',
    runsBandColumns: { green: 'items_green', amber: 'items_amber', red: 'items_red' },
    columns: [
      { col: 'title', from: 'title' },
      { col: 'funder', from: 'funder' },
      { col: 'funder_type', from: 'funder_type' },
      { col: 'url', from: 'url' },
      { col: 'closing_date', from: (e) => e.closing_date || null },
      { col: 'amount', from: 'amount' },
      { col: 'jurisdiction', from: 'jurisdiction' },
      { col: 'language', from: 'language' },
    ],
    starterCriteria: STARTER_FUNDING_CRITERIA,
    starterNotes: 'Starter criteria (auto-seeded) — tune via the criteria card',
    extractFields: extractCallFields,
    extractEvidence: makeEvidence(orgContext),
    presentResult: (e) => ({ title: e.title, funder: e.funder }),
  });
}
