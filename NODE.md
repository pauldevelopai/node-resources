# Node identity card — Resources

- **Slug:** `resources`
- **Display name:** Resources
- **Repo:** `pauldevelopai/node-resources`
- **Storage:** `host.store` (per-org JSON collections: `criteria`, `opportunities`, `chats`, `proposals`, `docs`)
- **Hosted:** yes (multi-tenant on the box) + one-command local install
- **First user:** PV — resource mobilisation support (finding relevant opportunities + proposal writing from internal data)
- **What it does:** scans the live web (Claude web-search tool via `host.ai.chat({webSearch})`)
  for currently-open funding and partnership opportunities matched to the org's
  profile (`host.profile`) and its editable search criteria; explains why each fits;
  hosts a grounded discussion per opportunity; drafts proposals from the org's own
  pasted documents with `[FILL IN: …]` markers instead of invented facts.

## Behaviour notes
- The **search criteria** card is the "adjustable backend" PV asked for — themes,
  geographies, funder types, eligibility, exclusions all live in `host.store`
  (`criteria/main`) and feed every AI call. No code change to re-aim the scan.
- Scans are **idempotent**: opportunity key = normalised `funder::title`, so re-scans
  refresh instead of duplicating, and a status the org set (pursuing/dismissed) survives.
- Web search needs the **Anthropic provider**. Locally with an OpenAI key the scan
  still runs but can't browse — pasted assessment, discussion and drafting all work.
- Everything parameterised is a **POST** (the runtime's GET wrap passes no query params).
