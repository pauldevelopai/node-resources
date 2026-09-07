# node-resources — Resources (GROUNDED Node)

> **BUILT, NOT DEPLOYED — see NODE.md.** The GitHub repo exists now; do not add
> the nodes.json card, merge the V1 branch to `main`, or deploy without Paul's
> go-ahead: PV (the first user) is gated on Caili approving their concept note.
> The box deploys `main`, so the merge is part of going live, not preparation
> for it.

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
  (seed), `mergedBase` (the migration path — see below), `refreshCriteriaFromForm`
  (criteria card → new active version), `saveRules` (rules panel → new active
  version), `describeCriteria`/`describeRule` (the rules in plain English),
  `pipelineFor(orgContext)` (per-request pipeline — checkpoint 2 embeds tenant
  context).
- **`lib/extract.js`** — the prompts (consumer config): call-field extraction,
  per-tenant evidence/fit, and `extractFunderProfile` (deck step 2 — the
  funder's own language, web-search assisted).
- **`lib/claude.js`** — the injected model call (env key, 429 retry,
  webSearch support). The engine never owns a key.
- **`lib/context.js`** — prose criteria card + org docs + shared profile →
  the grounding block every AI call gets. Takes the org's store as an argument
  (see `lib/store.js`) rather than reaching for `host.store`.
- **`lib/store.js`** — the org's key/value store, keyed on the NEWSROOM instead
  of the signed-in user. `host.store` is per-user, which split a client's team;
  this is the fix. Read it before touching anything that reads the criteria
  card, documents, chats or proposals.
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
- **The org can SEE the rules, not just change them.** The rules panel
  (`/api/rules`, `describeCriteria`) reads out the stored criteria version:
  every component, its weight and share of the score, whether it can reject
  outright, and what it actually matches on — in plain English generated FROM
  the config, never a hand-written description that could drift from it. The
  panel edits weights and the green/red thresholds; the criteria card still
  decides what each rule looks for.
- **Exclusions are arithmetic, not just prose** (needs engine ≥ v0.2.0). The
  card's `exclusion_terms` become a `keyword_none` rule in the `exclusions`
  component, which is in `hard_rules` — a ruled-out funder routes red however
  well it scores. The prose `exclusions` field stays, and still grounds the AI.
  Whole-word matching, so "arms" does not bin the Armstrong Foundation; an
  empty list excludes nothing.
- **`mergedBase` is the migration path — keep it.** Both writers start from
  `STARTER_FUNDING_CRITERIA` and overlay the tenant's active version, so a
  tenant whose criteria predate a component picks it up on their next save.
  Two traps it exists to avoid, both found by test: overlaying only the weight
  BLANKS the tenant's keyword lists (themes/geographies/exclusions) on every
  rules-panel save, and spreading old thresholds over new ones silently drops a
  newly-hard component from `hard_rules`. Weights carry over, keyword lists
  carry over, rule SHAPE comes from the starter, hard rules are unioned.
- **A find is credited to the source it came from.** The org's source list
  promises a running count per source, so `/api/scan` matches every candidate
  URL back to a listed source (host match, `www`-insensitive, subdomain-
  tolerant, scheme-less input accepted, longest host wins) and stamps
  `item.sourceId`; unmatched finds go to the `Web scan` source. The engine
  already honours per-item `sourceId` and moves `sources.items_seen/items_new`
  — do NOT go back to one batch-level sourceId, which parked every count on
  `Web scan` and left the org's own sources reading a permanent `seen 0/new 0`.
  The scan response carries `attribution` (per named source) and the UI says it.
- Engine dep pinned `#v0.2.0` (`keyword_none`); the tag is pushed (2026-09-07),
  so a fresh `npm install` here resolves. Runtime is still pinned v0.15.0 while v0.16.0
  (host.corpus) is tagged and available** — so today `corpusAdd` honestly
  reports "runtime has no host.corpus yet", `corpus_record_id` stays null, and
  therefore the "Mark human-verified" button never renders and
  `/api/opportunities/verify` always refuses. Outcomes still record locally.
  Bumping the pin lights all of it up; nothing else to change.

## Tenancy: BOTH halves keyed on the newsroom (fixed 2026-09-07)

The runtime keys `host.store` on the **signed-in user** —
`grounded-node-runtime/src/server-hosted.js`: `const tenantOf = (u) => String(u.id)`.
This Node kept four ORG-level things there (criteria card, documents, chats,
proposal drafts) while its Postgres tables were correctly per-newsroom, so a
client's team split down the middle: one colleague filled the criteria card,
the next signed in to an empty one and the scan refused outright — and if they
filled it, they silently redefined the whole newsroom's scoring.

Fixed in-Node, not in the runtime: `lib/store.js` provides `tenantStore()` over
`resources.tenant_store`, keyed on the newsroom id `tenantOf` already resolves.
`orgStore(host, id)` returns it when a pool exists and falls back to
`host.store` only on a DB-less LOCAL install, where there is one person anyway.
The context helpers take the store as an argument now rather than reaching for
`host.store` themselves, so the keying is visible at every call site.

**Doing it here was the cheap option and the window is closing.** The tracker's
CLAUDE.md records the runtime's per-user keying as an open data decision rather
than a bug to quietly fix, because rekeying would orphan rows live Nodes have
already written. This Node has written none — it has never been deployed. Once
PV is live on it, this stops being free.

Two things fell out of the same fix:
- **The 03:30 sweep had never worked.** `nightly.js` hand-rolled a reader
  against the runtime's `node_resources_store` using a column called `kind`;
  that table's column is `collection`, so the query threw every time — into a
  `.catch(() => ({ rows: [] }))` that turned the error into "this org has set
  no criteria". Every night it logged "no themes in the profile — skipping" and
  did nothing, looking exactly like a tenant who hadn't finished onboarding.
- **MCP and the web UI were reading different stores.** `mcp.js` worked around
  the per-user keying by faking `user.id = newsroomId`, so it read the runtime
  table keyed on the newsroom while the routes read it keyed on the user.
  Criteria set in the UI were invisible over MCP and vice versa. Both now go
  through `orgStore`.

Verified against a real Postgres, two users in one org: before, A had the card
and B was blocked; after, both see the same card, documents and grant range,
and a third org stays isolated.

## Criteria the client hasn't sent yet (2026-09-07)

PV's real criteria — sites used, grant size, geography, conversion history —
are still with the client. What matters is that they land as a **config edit**,
so here is exactly where the line sits.

**Config, no redeploy:** theme / geography / exclusion keyword lists and the
grant-size range (criteria card → `refreshCriteriaFromForm`); each component's
weight 0–10 and the green/red thresholds (rules panel → `saveRules`); sources
added, deactivated, rescheduled. Every save writes a **new version**, and each
scored call records its `criteria_version_id` — so "did the new criteria
actually do better" is answerable from data already being written.

**Code, small:** a genuinely NEW criterion. `STARTER_FUNDING_CRITERIA` defines
the component set and `saveRules` skips anything it doesn't already score
(`if (!target) continue`). Add it to the starter and `mergedBase` carries it to
existing tenants on their next save. A new rule TYPE needs no engine change —
`registerEvaluator` takes it in-Node.

**`grant_size` ships INERT and must stay that way until configured.** Weight 0,
no bounds. This is not timidity: an unbounded `range` scores every stated
amount 1, so at any weight above zero it hands every call a free component and
moves the band lines. Hence *weight follows configuration* — `applyAmountRange`
raises the weight off 0 when a range first arrives and drops it back to 0 if
the range is cleared. Two traps here, both already sprung once:
- `mergedBase` resets each rule to the starter's shape. It now carries the
  tenant's `ideal_*`/`hard_*` bounds as well as keywords — **without that, a
  rules-panel save wipes the bounds while keeping the weight**, which is the
  free-marks failure arriving through the back door. Verified against all three
  save paths.
- **Never score the verbatim `amount` string.** It stays exactly as the funder
  wrote it (that's what makes a record citable) and is never parsed for
  scoring. Deriving a number from it at score time reads "ZAR 1.5 million" as
  1.5 and "USD 50,000-100,000" as 50000100000 — both score **zero**, so a large
  grant routes red and nobody looks. The model returns digits into
  `amount_min`/`amount_max` instead (LeadFinder's `estimated_value` precedent),
  and `grant_size` scores the derived `amount_for_scoring` (max, else min).
  `toAmount` refuses anything that isn't already a clean number rather than
  guessing — an unparseable amount scores "not stated", never a wrong figure.

**Subscription sources: the slot exists, empty on purpose.** `sources.kind`
reserves `'subscription'` with **no adapter behind it**, and `credential_ref`
names an env/secret KEY — never a secret. Two gates before wiring it: confirm
each provider's terms permit automated access (most paid funding databases
forbid it, and a breach risks the CLIENT's account), and decide where the
secret lives — not this DB, which also backs the tracker, africazero and every
other hosted Node. Until then paid sources come in via the existing `'upload'`
kind: the org exports from its own logged-in session.

**Still missing, deliberately not built yet:** `time_spent_hours` on outcome
capture, and any aggregation of outcomes. The data to answer "which sites and
which criteria actually convert" is already being written (`outcome` +
`source_id` + `criteria_version_id` on every call) but nothing computes it —
there isn't a single `GROUP BY` in `routes.js`. Without time spent there's no
cost-per-win either.

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
