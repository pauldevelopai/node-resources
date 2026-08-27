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
  funderprofile, chat, docs, proposal. Also `sourceMatcher` — URL → the org's
  own source (see the attribution rule below).
- **`lib/sources-gov.js`** — the one wired feed: grants.gov (free, no key).
  Honest that it's a US federal catalogue: filters on stated applicant types,
  keeps eligibility verbatim, drops the rest. EU/UN belong here as siblings.
- **`lib/nightly.js`** — the 03:30 sweep (V1, see below), scheduled from
  `server-hosted.js`. Per-tenant, capped by `RESOURCES_NIGHTLY_CAP`.
- **`lib/mcp.js`** — the claude.ai / ChatGPT connector. **V2, off by default**
  (see below).
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
- **A find is credited to the source it came from.** The org's source list
  promises a running count per source, so `/api/scan` matches every candidate
  URL back to a listed source (host match, `www`-insensitive, subdomain-
  tolerant, scheme-less input accepted, longest host wins) and stamps
  `item.sourceId`; unmatched finds go to the `Web scan` source. The engine
  already honours per-item `sourceId` and moves `sources.items_seen/items_new`
  — do NOT go back to one batch-level sourceId, which parked every count on
  `Web scan` and left the org's own sources reading a permanent `seen 0/new 0`.
  The scan response carries `attribution` (per named source) and the UI says it.
- Engine dep pinned `#v0.1.0`. **Runtime is still pinned v0.15.0 while v0.16.0
  (host.corpus) is tagged and available** — so today `corpusAdd` honestly
  reports "runtime has no host.corpus yet", `corpus_record_id` stays null, and
  therefore the "Mark human-verified" button never renders and
  `/api/opportunities/verify` always refuses. Outcomes still record locally.
  Bumping the pin lights all of it up; nothing else to change.

## V1 / V2 line (agreed with Paul 2026-08-27, against PV's concept note)
- **Overnight sweep: V1.** Built and scheduled (03:30, half an hour after
  LeadFinder's 03:00). The concept note originally listed scheduled searching
  as a second-version addition; the decision went the other way — it ships in
  V1 and the note is being updated to match. Alerts and document export stay V2
  and are correctly absent.
- **MCP connector: V2, off by default.** `RESOURCES_MCP=1` mounts it; without
  that flag `mountMcp`/`mountMcpKeyRoutes` never mount and `ensureMcpSchema`
  never runs, so a V1 tenant has no `mcp_keys`/`mcp_usage` tables at all.
  Reason: the connector puts the tenant's whole funding pipeline (search, call
  detail, profile read AND write, outcome logging, live scan) inside claude.ai
  or ChatGPT behind a bearer key that rides in the URL. That is third-party
  egress of client data and it is not what PV's note describes, so it ships per
  tenant, on written agreement. Keep `lib/mcp.js` wired and current — the flag
  is the gate, deletion is not.

## Test setup that worked (2026-08-19)
Local Postgres :5433, database `resources_test`; boot with
`DATABASE_URL=postgres://localhost:5433/resources_test PORT=3097 npm start`.
Criteria save → verify `resources.criteria_versions` gains a version and
`theme_fit`/`geography_fit` rules carry the card's lists. Full pipeline test
needs a funded Anthropic key.
