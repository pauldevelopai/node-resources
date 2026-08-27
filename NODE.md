# Node identity card — Resources

> **STATUS: BUILT, NOT DEPLOYED — do not publish, deploy, or card on the front door.**
> PV's tenant may not go live before Caili approves their concept note. Building
> is done ahead of that gate; going live is not. No GitHub repo exists yet; no
> nodes.json entry; nothing on the box.

- **Slug:** `resources`
- **Display name:** Resources
- **Repo:** `pauldevelopai/node-resources` (to be created)
- **What it is:** the shared **Opportunity Finder engine**'s fundraising
  consumer — entity `funding_call`. A thin configuration of
  `@developai/grounded-opportunity-engine` plus the fundraising features around
  it. First user: PV.
- **Storage:**
  - `resources.*` Postgres tables (engine-standard: sources, criteria_versions
    (+entity), criteria_weights, raw_items, funding_calls, funding_call_flags,
    runs with items_green/amber/red). **No FK to public.newsrooms** — works on
    a standalone DB; tenancy is a plain UUID column.
  - `host.store` — prose criteria card, org documents, chats, proposal drafts.
  - `host.corpus` (runtime ≥ v0.16) — every kept call projects into the
    `news_opportunities` corpus; guarded, so v0.15 still runs (write-back
    honestly reported as skipped).
- **AI:** Claude `claude-sonnet-4-6` (env `MODEL` overrides) via `lib/claude.js`
  — hosted: shared server key; local: user's own key through the browser key
  screen. Engine checkpoints (extract, evidence/fit) + web-search discovery +
  funder profiles + grounded chat + proposal drafting. The model NEVER scores —
  routing is arithmetic against the tenant's versioned criteria.
- **Tenancy:** resolved in-Node (engine field lesson): hosted = tracker JWT →
  `newsroom_id` claim else `team_members` lookup, fail closed; local = fixed
  zero-UUID tenant.

## The flow (deck-aligned: TRF "AI for funding proposals", 7 steps)
1. **Sources card** — the places the org already looks (step 1). Scan checks
   them first (as priority places in the discovery prompt), and every find is
   credited to the listed source its URL came from, so the per-source seen/new
   counts are real. Finds from elsewhere on the web are credited to `Web scan`.
2. **Scan** — live web discovery grounded in profile + criteria, then every
   candidate through the engine pipeline: extract (checkpoint 1) → score
   (green/amber/red + reason) → evidence + honest fit note (checkpoint 2) →
   persist with full audit spine. Paste-your-own gets the identical treatment.
3. **Funder profile** (step 2) — on demand per call: the funder's priorities in
   their own repeated words, so proposals mirror the language *where true*.
4. **Discuss** — per-opportunity chat grounded in profile, criteria, documents,
   flags and the funder profile.
5. **Proposal** (steps 3–7) — structure DERIVED from the call; always includes
   evidence-backed problem statement, track record (only from the org's real
   material), approach, outcomes, **M&E**, **sustainability**, a balanced
   **budget table with % splits**, and a **workplan**. Gaps are `[FILL IN: …]`,
   never invented.
6. **Outcomes** — applied/won/lost/dismissed, recorded by a named person,
   pushed to the corpus record (`setOutcome`). Outcome data is the most
   valuable thing collected.
7. **Verification** — "Mark human-verified" flips the corpus record via
   `host.corpus.verify(id, namedPerson)`. Dark until the runtime pin moves to
   v0.16.0 (the button is gated on `corpus_record_id`).
8. **Overnight sweep (V1)** — 03:30 per-tenant sweep of the wired feed against
   the tenant's own themes, capped by `RESOURCES_NIGHTLY_CAP`. A tenant with no
   themes is skipped and says so.

## Not in V1
- **MCP connector** (`lib/mcp.js`) — built, mounted only when `RESOURCES_MCP=1`.
  V2, per tenant, on written agreement: it exposes the funding pipeline to
  claude.ai / ChatGPT via a URL-borne bearer key. No UI references it.
- **Alerts and document export** — absent by design; the note prices them as
  second-version work. Drafts leave via the clipboard and are finished in Word.

## Criteria = config, never a redeploy
The criteria card saves prose (grounds every AI call, via host.store) AND
regenerates the tenant's ACTIVE engine criteria version: themes+keywords →
`theme_fit` rule, geographies → `geography_fit`, exclusion terms →
`exclusions` (a `keyword_none` HARD rule — a ruled-out funder routes red
whatever else it scores). Weights/thresholds carry over from the previous
version; history is never rewritten.

## The rules panel — "see and change the rules at any time"
`How opportunities are scored` reads out the active criteria version: each
component's weight, its share of the score, whether it can reject outright, and
what it matches on, described FROM the stored config rather than hand-written.
It edits the weights and the green/red thresholds; saving creates the next
version, so past scores stay traceable to the rules that produced them.
Validation refuses a red threshold at or above green, weights outside 0–10, and
an all-zero set.

## Run
- Local: `npm start` — full app needs `DATABASE_URL` (Postgres); without it the
  pipeline endpoints return honest 503s and docs/chat/key-setup still work.
- Hosted: `npm run start:hosted` — the runtime supplies DB + auth + chrome;
  `ensureSchema` creates the `resources` schema on boot.
- Engine dep is `file:../../grounded-opportunity-engine` until the GitHub repo
  exists — flip to `github:pauldevelopai/grounded-opportunity-engine#v0.1.0`
  before any deploy.
