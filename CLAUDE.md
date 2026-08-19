# node-resources — Resources (GROUNDED Node)

> **BUILT, NOT DEPLOYED — see NODE.md.** Do not create the GitHub repo, add the
> nodes.json card, or deploy without Paul's go-ahead: PV (the first user) is
> gated on Caili approving their concept note.

The **fundraising consumer of the shared Opportunity Finder engine**
(`@developai/grounded-opportunity-engine`, entity `funding_call`). Find funding
opportunities matched to an organisation, explain the fit honestly, discuss
each one grounded in the org's material, and draft funder-shaped proposals.
Runs local (own key + own Postgres) and hosted (multi-tenant) from one code path.

## Map
- **`index.js`** / **`server-hosted.js`** — entries; both run `ensureSchema`
  (hosted via the runtime's hook). Keep the no-cache app-shell middleware.
- **`lib/schema.js`** — engine-standard tables in the `resources` schema.
  Deliberate: NO FKs to public.newsrooms (standalone installs); runs uses the
  engine's new `items_green/amber/red` names.
- **`lib/engine.js`** — the wiring: `tenantOf` (JWT newsroom_id →
  team_members, fail closed; local = zero-UUID), `STARTER_FUNDING_CRITERIA`
  (seed), `refreshCriteriaFromForm` (criteria card → new active version;
  weights/thresholds carry over), `pipelineFor(orgContext)` (per-request
  pipeline — checkpoint 2 embeds tenant context).
- **`lib/extract.js`** — the prompts (consumer config): call-field extraction,
  per-tenant evidence/fit, and `extractFunderProfile` (deck step 2 — the
  funder's own language, web-search assisted).
- **`lib/claude.js`** — the injected model call (env key, 429 retry,
  webSearch support). The engine never owns a key.
- **`lib/context.js`** — prose criteria card + org docs + shared profile →
  the grounding block every AI call gets.
- **`lib/routes.js`** — the surface: overview, criteria, sources, scan,
  assess, opportunity (+flags/chat/proposal), status, **outcome** (named
  person → corpus setOutcome), **verify** (named person → corpus verify),
  funderprofile, chat, docs, proposal.
- **`lib/pool.js`** — lazy pg pool; absent DATABASE_URL → honest 503s on
  pipeline routes only.
- **`public/`** — vanilla JS dashboard; `mountKeyUI()` verbatim.

## Rules that shaped it (don't undo)
- **The model never scores.** Routing is arithmetic (engine) against versioned
  tenant criteria. The scan's discovery step finds candidates; the pipeline
  decides bands.
- **No fake data.** Discovery reports only real found URLs or nothing; drafts
  mark gaps `[FILL IN: …]`; unwired paths return honest errors; corpus
  write-back reports skipped when the runtime lacks host.corpus.
- **Verification and outcomes are a named person's acts** — email from the JWT
  hosted, an explicit name locally.
- **Criteria are config.** The card edit regenerates scoring rules — never a
  redeploy (vision layer 3).
- Engine dep is `file:` until the GitHub repo exists; runtime pin moves to
  v0.16.0 when that tag lands (host.corpus lights up automatically — the code
  already guards for it).

## Test setup that worked (2026-08-19)
Local Postgres :5433, database `resources_test`; boot with
`DATABASE_URL=postgres://localhost:5433/resources_test PORT=3097 npm start`.
Criteria save → verify `resources.criteria_versions` gains a version and
`theme_fit`/`geography_fit` rules carry the card's lists. Full pipeline test
needs a funded Anthropic key.
