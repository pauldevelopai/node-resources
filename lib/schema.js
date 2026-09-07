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
// Chats, proposal drafts and pasted org documents live in resources.tenant_store
// below (per-ORG working state, not corpus data — and per-org rather than
// per-user, which is the whole point of that table). Opportunities live HERE —
// relational, scored, audit-spined — and project into the news_opportunities
// corpus via host.corpus when the runtime provides it.

const STATEMENTS = [
  `CREATE SCHEMA IF NOT EXISTS resources`,

  `CREATE TABLE IF NOT EXISTS resources.sources (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  newsroom_id         UUID NOT NULL,
  name                VARCHAR(300) NOT NULL,
  kind                VARCHAR(20) NOT NULL DEFAULT 'html',   -- 'html'|'rss'|'upload'|'search'; 'subscription' is RESERVED, see credential_ref below — no adapter implements it, so setting it fetches nothing
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

  // ── Additive columns ───────────────────────────────────────────────────────
  // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
  // anything added after a tenant's first boot has to arrive as an ALTER.

  // Grant size, as a NUMBER the scorer can actually use.
  //
  // `amount` above stays exactly as the funder wrote it ("USD 50,000 max",
  // "ZAR 1.5 million") — that verbatim string is what a person quotes and
  // what makes the record citable, and it is never overwritten. But the
  // engine's `range` evaluator needs a real number, and deriving one from that
  // string at score time silently mangles the common formats: "ZAR 1.5
  // million" reads as 1.5 and "USD 50,000-100,000" as 50000100000, both of
  // which score ZERO against any sane bounds. A large grant then routes red
  // and nobody ever looks at it.
  //
  // So the model returns digits, exactly as LeadFinder already does for
  // estimated_value, and we store them alongside the verbatim string. A call
  // stating one figure sets both min and max to it; a stated range fills both.
  // Null stays null — an unstated amount is not a zero.
  `ALTER TABLE resources.funding_calls ADD COLUMN IF NOT EXISTS amount_min      NUMERIC(16,2)`,
  `ALTER TABLE resources.funding_calls ADD COLUMN IF NOT EXISTS amount_max      NUMERIC(16,2)`,
  `ALTER TABLE resources.funding_calls ADD COLUMN IF NOT EXISTS amount_currency VARCHAR(8)`,

  // Subscription/paywalled sources: the SLOT, deliberately empty.
  //
  // Some of the databases a fundraiser actually uses are paid. This names the
  // secret; it never holds one. The value is an env-var / secret-store KEY
  // (e.g. 'PV_FUNDSFORNGOS'), so a credential never lands in this database —
  // which matters because `tracker` also backs the tracker, africazero and
  // every other hosted Node, so a secret written here is exposed far wider
  // than the one tenant it belongs to.
  //
  // NOTHING READS THIS YET, on purpose. Two gates first: (1) confirm the
  // provider's terms permit automated access at all — most subscription
  // funding databases forbid it, and breaching them puts the CLIENT's account
  // at risk, not ours; (2) a decision on where the secret itself lives. Until
  // both clear, paid sources come in through the existing 'upload' kind: the
  // org exports from their own logged-in session and uploads the file.
  `ALTER TABLE resources.sources ADD COLUMN IF NOT EXISTS credential_ref VARCHAR(120)`,

  // ── The org's own key/value store ──────────────────────────────────────────
  // Same interface as host.store (get/put/list/delete over JSON), but keyed on
  // the NEWSROOM rather than the signed-in user. See lib/store.js for why that
  // difference decides whether a client's team can work together at all.
  `CREATE TABLE IF NOT EXISTS resources.tenant_store (
  newsroom_id  UUID NOT NULL,
  collection   VARCHAR(40) NOT NULL,
  key          VARCHAR(200) NOT NULL,
  value        JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (newsroom_id, collection, key)
)`,
  `CREATE INDEX IF NOT EXISTS idx_rs_tstore_coll ON resources.tenant_store(newsroom_id, collection)`,
];

// uuid_generate_v4() needs uuid-ossp; the shared box DB has it, a fresh local
// one may not — creating it is idempotent and harmless where it exists.
export async function ensureSchema(pool) {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  for (const sql of STATEMENTS) await pool.query(sql);
}

export default ensureSchema;
