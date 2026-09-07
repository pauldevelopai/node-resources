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
import { createPipeline, getActiveCriteria } from '@developai/grounded-opportunity-engine';
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
  thresholds: { green_min: 65, red_max: 35, hard_rules: ['deadline_runway', 'exclusions'] },
  weights: [
    { component: 'theme_fit', weight: 3.0, source: 'prior',
      rule: { type: 'keyword_any', fields: ['title', 'summary', 'eligibility'], keywords: [], miss_score: 0.2, missing_score: 0.3 } },
    { component: 'geography_fit', weight: 2.0, source: 'prior',
      rule: { type: 'keyword_any', fields: ['jurisdiction', 'summary', 'eligibility'], keywords: [], miss_score: 0.3, missing_score: 0.4 } },
    { component: 'deadline_runway', weight: 2.0, source: 'prior',
      rule: { type: 'runway', field: 'closing_date', ideal_min_days: 21, hard_min_days: 5, missing_score: 0.5 } },
    { component: 'completeness', weight: 1.0, source: 'prior',
      rule: { type: 'completeness', fields: ['title', 'funder', 'closing_date', 'eligibility', 'summary'] } },
    // The org's own refusals, as arithmetic. A hit scores 0 and the component
    // is a hard rule, so a ruled-out funder routes red however well it would
    // otherwise score. Empty list = excludes nothing (the normal state).
    { component: 'exclusions', weight: 1.0, source: 'prior',
      rule: { type: 'keyword_none', fields: ['funder', 'title', 'summary', 'eligibility'], keywords: [] } },
    // Grant size — SHIPPED INERT, at weight 0, and that is deliberate.
    //
    // An org's useful grant range is its own business assumption, so it is
    // config, not a number we choose. Until the org states one there are no
    // bounds, and an unbounded `range` scores every stated amount 1 — which at
    // any weight above zero would hand every call a free component and quietly
    // shift where the green/red lines fall. So the weight stays 0 until bounds
    // exist, and refreshCriteriaFromForm raises it (and drops it back to 0 if
    // the range is cleared). Nothing about scoring changes by shipping this.
    //
    // Reads the DERIVED amount_for_scoring, never the verbatim `amount` string
    // — see the note in extract.js on why parsing that string at score time is
    // how a 1.5-million grant silently scores zero.
    { component: 'grant_size', weight: 0, source: 'prior',
      rule: { type: 'range', field: 'amount_for_scoring', missing_score: 0.3 } },
  ],
};

// The weight grant_size takes when an org first states a range. In line with
// geography_fit (2.0): it matters, and it does not outrank theme fit (3.0).
// Tunable afterwards in the rules panel like any other component.
const GRANT_SIZE_DEFAULT_WEIGHT = 2.0;

// ── plain English, for the rules panel ───────────────────────────────────────
// The org is promised it can SEE the rules, not just change them. These read
// out the stored config — they never describe anything the scorer doesn't do.
const COMPONENT_LABELS = {
  theme_fit: 'Theme match',
  geography_fit: 'Where you work',
  deadline_runway: 'Time to apply',
  completeness: 'How much the call tells us',
  exclusions: 'What you rule out',
  grant_size: 'Grant size',
};

const FIELD_LABELS = {
  title: 'title', summary: 'summary', eligibility: 'eligibility', funder: 'funder',
  jurisdiction: 'jurisdiction', closing_date: 'closing date', funder_type: 'funder type',
  themes: 'themes', geographies: 'geographies', amount: 'amount', language: 'language',
};

const asWords = (arr) => (arr || []).map((f) => FIELD_LABELS[f] || f).join(', ');

export function describeRule(rule) {
  const kw = (rule?.keywords || []).filter(Boolean);
  switch (rule?.type) {
    case 'keyword_any':
      return kw.length
        ? `Reads the ${asWords(rule.fields)}. Full marks when the call mentions any of: ${kw.join(', ')}.`
        : `Reads the ${asWords(rule.fields)}. No terms set yet — add them in the criteria card, and this rule fills itself in.`;
    case 'keyword_none':
      return kw.length
        ? `Reads the ${asWords(rule.fields)}. Rejects the call outright if it mentions any of: ${kw.join(', ')}.`
        : `Reads the ${asWords(rule.fields)}. Nothing ruled out yet — add terms in the criteria card and they take effect on the next scan.`;
    case 'range': {
      // Reads out the stored bounds and nothing more. An unset range says so
      // plainly rather than implying a default the scorer isn't using.
      const money = (n) => Number(n).toLocaleString('en-ZA', { maximumFractionDigits: 0 });
      const hasIdeal = rule.ideal_min != null || rule.ideal_max != null;
      if (!hasIdeal) {
        return 'No size range set yet — add the smallest and largest grant worth your time in the criteria card, and this rule starts counting.';
      }
      const floor = rule.ideal_min != null ? money(rule.ideal_min) : null;
      const ceil = rule.ideal_max != null ? money(rule.ideal_max) : null;
      const band = floor && ceil ? `between ${floor} and ${ceil}`
        : floor ? `at or above ${floor}`
        : `up to ${ceil}`;
      const outside = rule.hard_min != null || rule.hard_max != null
        ? ` Scores fall away towards ${rule.hard_min != null ? money(rule.hard_min) : '0'}${rule.hard_max != null ? ` and ${money(rule.hard_max)}` : ''}, so a call outside the band still gets looked at rather than binned.`
        : '';
      return `Full marks for a grant ${band}.${outside} A call that doesn't state an amount scores ${rule.missing_score ?? 0.3} — unknown, not rejected.`;
    }
    case 'runway':
      return `Full marks with ${rule.ideal_min_days ?? 14} days or more before the deadline. Under ${rule.hard_min_days ?? 2} days is rejected outright — too little time to write a real application.`;
    case 'completeness':
      return `Scores the share of these the call actually states: ${asWords(rule.fields)}.`;
    default:
      return `Rule type "${rule?.type || 'unknown'}".`;
  }
}

/** The active criteria version, shaped for the rules panel. */
export async function describeCriteria(pool, newsroomId) {
  const active = await getActiveCriteria(pool, SCHEMA, newsroomId, ENTITY);
  if (!active) return null;
  const hard = active.thresholds?.hard_rules || [];
  const total = active.weights.reduce((s, w) => s + Number(w.weight || 0), 0) || 1;
  return {
    version: active.version,
    thresholds: {
      green_min: active.thresholds?.green_min ?? 65,
      red_max: active.thresholds?.red_max ?? 35,
      hard_rules: hard,
    },
    components: active.weights
      .map((w) => ({
        component: w.component,
        label: COMPONENT_LABELS[w.component] || w.component,
        weight: Number(w.weight),
        share: Math.round((Number(w.weight) / total) * 100),
        hard: hard.includes(w.component),
        detail: describeRule(w.rule),
      }))
      .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label)),
  };
}

/**
 * Write a new ACTIVE criteria version, archiving the current one. History is
 * never rewritten — every stored score keeps naming the version that produced
 * it. Shared by both writers: the criteria card and the rules panel.
 */
async function writeVersion(pool, newsroomId, base, notes) {
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
       VALUES ($1, $2, $3, 'active', $4::jsonb, $5, NOW()) RETURNING id, version`,
      [newsroomId, mx.v + 1, ENTITY, JSON.stringify(base.thresholds), notes]);
    for (const w of base.weights) {
      await client.query(
        `INSERT INTO ${SCHEMA}.criteria_weights (criteria_version_id, component, weight, source, rule)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [ver.id, w.component, w.weight, w.source || 'prior', JSON.stringify(w.rule)]);
    }
    await client.query('COMMIT');
    return ver.version;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Load the active version as a mutable base, MERGED over the starter set.
 *
 * The merge is what lets a tenant created before a component existed pick it up
 * on their next save: start from the starter (which defines today's components
 * and rule shapes), overlay the tenant's tuned weights, keep any component the
 * starter no longer knows about, and UNION the hard rules — a plain spread
 * would let an older thresholds row silently drop a newly-hard component.
 */
async function mergedBase(pool, newsroomId) {
  const base = JSON.parse(JSON.stringify(STARTER_FUNDING_CRITERIA));
  const prev = await getActiveCriteria(pool, SCHEMA, newsroomId, ENTITY);
  if (!prev) return base;

  const prevByComponent = new Map(prev.weights.map((w) => [w.component, w]));
  for (const w of base.weights) {
    const p = prevByComponent.get(w.component);
    if (!p) continue;
    w.weight = Number(p.weight);
    w.source = p.source || w.source;
    // The rule's SHAPE stays the starter's, so a fix there reaches every
    // tenant. The keyword lists are the tenant's own data and MUST be carried
    // — without this, saving the rules panel silently blanks the themes,
    // geographies and exclusions, and everything scores against nothing.
    if (Array.isArray(p.rule?.keywords)) w.rule.keywords = p.rule.keywords;
    // Numeric bounds are the tenant's data for exactly the same reason, and
    // carrying them matters more than it looks: the starter ships grant_size
    // with NO bounds, and an unbounded `range` scores every stated amount 1.
    // Drop the bounds while keeping the weight the rules panel just saved and
    // the component silently becomes free marks for everyone — the failure the
    // weight-follows-configuration rule exists to prevent, reintroduced by the
    // merge. So bounds travel with the tenant, and only the criteria card
    // (which is given the org's actual numbers) may change them.
    for (const k of ['ideal_min', 'ideal_max', 'hard_min', 'hard_max']) {
      if (p.rule?.[k] != null) w.rule[k] = p.rule[k];
    }
  }
  // A component the tenant has that the starter dropped stays, rule and all.
  for (const p of prev.weights) {
    if (!base.weights.some((w) => w.component === p.component)) {
      base.weights.push({ component: p.component, weight: Number(p.weight), source: p.source, rule: p.rule });
    }
  }
  base.thresholds = {
    ...base.thresholds,
    ...(prev.thresholds || {}),
    hard_rules: [...new Set([
      ...(base.thresholds.hard_rules || []),
      ...((prev.thresholds || {}).hard_rules || []),
    ])],
  };
  return base;
}

/**
 * Regenerate the tenant's ACTIVE criteria version from the criteria-card lists
 * (themes/geographies/keywords/exclusion terms). Tuning done in the rules panel
 * carries over, so editing a list never resets the weights.
 */
export async function refreshCriteriaFromForm(pool, newsroomId, {
  themes = [], geographies = [], keywords = [], exclusion_terms = [],
  amount_min = null, amount_max = null,
} = {}) {
  const base = await mergedBase(pool, newsroomId);
  for (const w of base.weights) {
    if (w.component === 'theme_fit') w.rule.keywords = [...themes, ...keywords].filter(Boolean);
    if (w.component === 'geography_fit') w.rule.keywords = geographies.filter(Boolean);
    if (w.component === 'exclusions') w.rule.keywords = exclusion_terms.filter(Boolean);
    if (w.component === 'grant_size') applyAmountRange(w, amount_min, amount_max);
  }
  return writeVersion(pool, newsroomId, base, 'Regenerated from the criteria card');
}

/**
 * Turn "the smallest and largest grant worth our time" into the grant_size
 * rule's bounds — the whole point being that a client's size range is a config
 * edit, not a code change.
 *
 * Two things this does on the org's behalf, both to stop the rule misbehaving
 * in a way nobody would see:
 *
 *  - Weight follows configuration. No bounds means an unbounded `range`, which
 *    scores every stated amount 1 — a free component that silently moves the
 *    band lines. So no bounds forces weight 0, and the first real range raises
 *    it off 0 to the default. A weight the org has since tuned itself is left
 *    alone.
 *  - Hard bounds are DERIVED from the ideal band, not asked for. An org can
 *    say what it wants; making it also state the point where a grant becomes
 *    worthless is a question about the scorer, not about fundraising. Below
 *    the floor falls away to zero (a grant far too small really is no use);
 *    above the ceiling only falls to a generous bound, because a grant larger
 *    than you hoped for is a nice problem and must still reach a human.
 */
export function applyAmountRange(w, minRaw, maxRaw) {
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[\s,]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  let lo = num(minRaw);
  let hi = num(maxRaw);
  if (lo != null && hi != null && lo > hi) [lo, hi] = [hi, lo];   // entered the wrong way round

  if (lo == null && hi == null) {
    delete w.rule.ideal_min; delete w.rule.ideal_max;
    delete w.rule.hard_min;  delete w.rule.hard_max;
    w.weight = 0;
    return;
  }
  if (lo != null) { w.rule.ideal_min = lo; w.rule.hard_min = 0; } else { delete w.rule.ideal_min; delete w.rule.hard_min; }
  if (hi != null) { w.rule.ideal_max = hi; w.rule.hard_max = hi * 10; } else { delete w.rule.ideal_max; delete w.rule.hard_max; }
  if (!(Number(w.weight) > 0)) w.weight = GRANT_SIZE_DEFAULT_WEIGHT;
}

/**
 * Save weights + thresholds from the rules panel. The rules themselves (what
 * each component reads and matches on) stay derived from the criteria card —
 * this changes how much each one counts and where the bands fall.
 */
export async function saveRules(pool, newsroomId, { weights = [], thresholds = {} } = {}) {
  const base = await mergedBase(pool, newsroomId);

  const byComponent = new Map(base.weights.map((w) => [w.component, w]));
  for (const w of weights) {
    const target = byComponent.get(w.component);
    if (!target) continue;                       // ignore anything we don't score
    const n = Number(w.weight);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      throw Object.assign(new Error(`Weight for "${w.component}" must be between 0 and 10.`), { status: 400 });
    }
    target.weight = Math.round(n * 100) / 100;
  }
  if (!base.weights.some((w) => w.weight > 0)) {
    throw Object.assign(new Error('At least one rule needs a weight above zero, or nothing can be scored.'), { status: 400 });
  }

  const green = Number(thresholds.green_min ?? base.thresholds.green_min);
  const red = Number(thresholds.red_max ?? base.thresholds.red_max);
  for (const [name, v] of [['Green threshold', green], ['Red threshold', red]]) {
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      throw Object.assign(new Error(`${name} must be between 0 and 100.`), { status: 400 });
    }
  }
  if (red >= green) {
    throw Object.assign(new Error('The red threshold has to sit below the green one — otherwise nothing can land in between for review.'), { status: 400 });
  }
  base.thresholds = { ...base.thresholds, green_min: green, red_max: red };

  return writeVersion(pool, newsroomId, base, 'Edited in the rules panel');
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
      { col: 'amount_min', from: (e) => e.amount_min ?? null },
      { col: 'amount_max', from: (e) => e.amount_max ?? null },
      { col: 'amount_currency', from: (e) => e.amount_currency ?? null },
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
