// Resources — schema, created on boot by ensureSchema (idempotent).
//
// The engine-standard table set (see grounded-opportunity-engine/CLAUDE.md) in
// our own `resources` schema, entity = 'funding_call'. Two deliberate
// departures from the LeadFinder reference:
//   - NO foreign keys to public.newsrooms — a standalone local install has no
//     tracker tables. newsroom_id stays a plain UUID; hosted tenancy is
//     resolved in-Node (JWT newsroom_id → team_members lookup, fail closed).
//   - runs uses the engine's NEW band column names (items_green/amber/red) —
//     only the LeadFinder reference schema keeps the legacy tenders_* names.
//
// Chats, proposal drafts and pasted org documents stay in host.store (they're
// per-tenant working state, not corpus data). Found opportunities live HERE —
// relational, scored, audit-spined — and project into the news_opportunities
// corpus via host.corpus when the runtime provides it.

const STATEMENTS = [
  `CREATE SCHEMA IF NOT EXISTS resources`,

  `CREATE TABLE IF NOT EXISTS resources.sources (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id         UUID NOT NULL,
  name                VARCHAR(300) NOT NULL,
  kind                VARCHAR(20) NOT NULL DEFAULT 'html',   -- 'html'|'rss'|'upload'|'search'
  location            TEXT,                                  -- url / inbox (null for ad-hoc)
  active              BOOLEAN NOT NULL DEFAULT true,
  run_frequency_hours INTEGER NOT NULL DEFAULT 24,
  last_run_at         TIMESTAMPTZ,
  last_success_at     TIMESTAMPTZ,
  last_error          TEXT,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  origin              VARCHAR(12) NOT NULL DEFAULT 'human',
  approved            BOOLEAN NOT NULL DEFAULT true,
  rationale           TEXT,
  items_seen          INTEGER NOT NULL DEFAULT 0,
  items_new           INTEGER NOT NULL DEFAULT 0,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_rs_sources_tenant ON resources.sources(newsroom_id)`,

  `CREATE TABLE IF NOT EXISTS resources.criteria_versions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id   UUID NOT NULL,
  version       INTEGER NOT NULL,
  entity        VARCHAR(20) NOT NULL DEFAULT 'funding_call',
  status        VARCHAR(12) NOT NULL DEFAULT 'draft',
  thresholds    JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes         TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at  TIMESTAMPTZ,
  UNIQUE (newsroom_id, version)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rs_criteria_active_per_entity
  ON resources.criteria_versions(newsroom_id, entity) WHERE status = 'active'`,

  `CREATE TABLE IF NOT EXISTS resources.criteria_weights (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  criteria_version_id UUID NOT NULL REFERENCES resources.criteria_versions(id) ON DELETE CASCADE,
  component           VARCHAR(60) NOT NULL,
  weight              NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  source              VARCHAR(12) NOT NULL DEFAULT 'prior',
  rule                JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (criteria_version_id, component)
)`,

  `CREATE TABLE IF NOT EXISTS resources.raw_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id  UUID NOT NULL,
  source_id    UUID NOT NULL REFERENCES resources.sources(id) ON DELETE CASCADE,
  external_id  TEXT,
  url          TEXT,
  title        TEXT,
  content      TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload  JSONB,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
  funding_call_id UUID,
  CONSTRAINT rs_raw_items_dedup UNIQUE (source_id, external_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_rs_raw_items_tenant ON resources.raw_items(newsroom_id)`,

  // The scored entity. First-class columns are what the UI filters/sorts on;
  // the full extraction lives in `extracted` verbatim.
  `CREATE TABLE IF NOT EXISTS resources.funding_calls (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id         UUID NOT NULL,
  source_id           UUID REFERENCES resources.sources(id) ON DELETE SET NULL,
  raw_item_id         UUID REFERENCES resources.raw_items(id) ON DELETE SET NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  title               TEXT,
  funder              TEXT,
  funder_type         VARCHAR(20),                  -- institutional|corporate|philanthropic|multilateral|embassy|other
  url                 TEXT,
  closing_date        TIMESTAMPTZ,
  amount              TEXT,                          -- verbatim ("USD 50,000", "unknown")
  jurisdiction        TEXT,
  language            TEXT,
  extracted           JSONB NOT NULL DEFAULT '{}'::jsonb,

  component_scores    JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_score         NUMERIC(6,2),
  criteria_version_id UUID REFERENCES resources.criteria_versions(id),
  band                VARCHAR(6),
  routing_reason      TEXT,
  status              VARCHAR(16) NOT NULL DEFAULT 'new',  -- new|qualified|needs_review|rejected|pursuing|resolved

  funder_profile      JSONB,                         -- deck step 2: priorities + the funder's own language (AI-drafted, on demand)
  outcome             VARCHAR(16),                   -- applied|won|lost|dismissed — the most valuable field
  outcome_note        TEXT,
  outcome_recorded_by TEXT,                          -- named person (email) — outcomes are a human act
  outcome_at          TIMESTAMPTZ,

  corpus_record_id    UUID,                          -- set when projected into the news_opportunities corpus

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_rs_calls_tenant  ON resources.funding_calls(newsroom_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rs_calls_band    ON resources.funding_calls(newsroom_id, band)`,
  `CREATE INDEX IF NOT EXISTS idx_rs_calls_closing ON resources.funding_calls(newsroom_id, closing_date)`,

  `CREATE TABLE IF NOT EXISTS resources.funding_call_flags (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  funding_call_id UUID NOT NULL REFERENCES resources.funding_calls(id) ON DELETE CASCADE,
  flag_type       VARCHAR(60) NOT NULL,
  severity        SMALLINT NOT NULL DEFAULT 3,
  confidence      NUMERIC(3,2) NOT NULL DEFAULT 1.0,
  evidence_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_rs_flags_call ON resources.funding_call_flags(funding_call_id)`,

  `CREATE TABLE IF NOT EXISTS resources.runs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id  UUID NOT NULL,
  source_id    UUID REFERENCES resources.sources(id) ON DELETE SET NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  items_seen   INTEGER NOT NULL DEFAULT 0,
  items_new    INTEGER NOT NULL DEFAULT 0,
  items_green  INTEGER NOT NULL DEFAULT 0,
  items_amber  INTEGER NOT NULL DEFAULT 0,
  items_red    INTEGER NOT NULL DEFAULT 0,
  status       VARCHAR(12) NOT NULL DEFAULT 'running',
  error        TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_rs_runs_tenant ON resources.runs(newsroom_id, started_at DESC)`,
];

// uuid_generate_v4() needs uuid-ossp; the shared box DB has it, a fresh local
// one may not — creating it is idempotent and harmless where it exists.
export async function ensureSchema(pool) {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  for (const sql of STATEMENTS) await pool.query(sql);
}

export default ensureSchema;
