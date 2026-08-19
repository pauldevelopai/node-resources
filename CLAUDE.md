# node-resources — Resources (GROUNDED Node)

> **ON HOLD — see NODE.md.** Do not create the GitHub repo, add the nodes.json
> card, or deploy. PV is gated on Caili's concept-note approval, and this
> functionality belongs in the shared Opportunity Finder engine (seed: LeadFinder).

Resource mobilisation for an organisation: find funding/partnership opportunities
that fit them, explain why, discuss each one, and draft proposals from their own
material. First user: PV. Built from `node-template`; runs **locally** (own AI key,
JSON files) and **hosted** (multi-tenant, tracker JWT auth, Postgres-backed
`host.store`) from the same handlers.

## Map
- **`index.js`** (LOCAL) / **`server-hosted.js`** (HOSTED) — slug `resources`,
  display name "Resources". Keep the no-cache app-shell middleware in
  `server-hosted.js`'s `mountRoutes`.
- **`lib/handlers.js`** — the standard generic handlers (`getSetupStatus` /
  `postSetup` = browser key flow, server-managed when `GROUNDED_HOSTED`;
  `getActivity`). Unchanged from the template pattern.
- **`lib/context.js`** — the grounding layer. `orgContext(host, {withDocs})`
  builds the block every AI call is prefixed with: shared `host.profile` +
  this Node's criteria (`host.store` `criteria/main`) + pasted internal docs.
  Also `opportunityId()` (stable `funder::title` key → idempotent re-scans) and
  `extractJson()` (tolerant JSON pull from AI replies).
- **`lib/routes.js`** — the real surface (all under `mountAppRoutes`):
  - `GET /api/overview` — criteria + opportunities + docs (no text) + profile in one call
  - `POST /api/criteria` — save the adjustable search backend
  - `POST /api/scan` — live web search via `host.ai.chat(..., {webSearch:{maxUses:8}})`,
    JSON-array reply parsed and upserted into `opportunities` (statuses survive re-scan)
  - `POST /api/opportunities/assess` — paste-your-own → same honest fit assessment
  - `POST /api/opportunities/status|delete`, `POST /api/opportunity` (one + chat + proposal)
  - `POST /api/chat` — per-opportunity discussion, grounded `withDocs:true`
  - `GET|POST /api/docs`, `POST /api/docs/delete` — internal material (60k chars cap each)
  - `POST /api/proposal` — draft/revise in passes; gaps are `[FILL IN: …]`, never invented
- **`public/`** — vanilla JS dashboard, RELATIVE paths, list view + per-opportunity
  detail view (discuss + draft). `mountKeyUI()` is the standard key UX, verbatim.

## Rules that shaped it (don't undo)
- **No fake data, ever.** The scan prompt demands real found URLs or `[]`; the
  proposal prompt forbids invented track record — `[FILL IN: …]` markers instead;
  empty states in the UI are honest.
- **GET handlers get no query params** (runtime wrap) — every parameterised
  endpoint here is a POST. Keep it that way.
- **Idempotent writes** — opportunities/chats/proposals are keyed `host.store`
  puts, so nothing duplicates on retry or re-scan.
- **Web search is Anthropic-only** (runtime ignores it for OpenAI). Local OpenAI
  users still get assess/chat/draft.
- Runtime pinned `github:pauldevelopai/grounded-node-runtime#v0.15.0`. If it runs
  stale after a tag bump: `rm -rf node_modules/@developai && npm install`.

## Deploy
Registered in `nodes/nodes.json` (products: grounded). Host: `deploy-node.sh
resources <port>` on the box, then the Caddy `handle_path /nodes/resources/app/*`
block + `sudo systemctl restart caddy`. Downloads `/nodes/resources/{mac,windows}`
work via the generic Caddy rule. See `nodes/ADD_A_NODE.md`.
