# Resources

A **GROUNDED Node** for resource mobilisation. It searches the live web for
funding and partnership opportunities that fit *your* organisation — formal
calls for proposals from institutional donors, plus corporate and philanthropic
openings — and explains, in writing, why each one fits who you are, what you've
done, and where your strategy is going. From there you can interrogate any
opportunity in a grounded discussion, and draft the proposal from your own past
proposals and strategy documents.

Three honest rules run through it:

- **It only reports opportunities it actually found**, with real URLs. Nothing invented.
- **Proposal drafts use only your material.** Missing facts show as `[FILL IN: …]` — a human finishes and verifies everything before it goes anywhere.
- **The backend is yours to adjust.** As your strategy shifts — new sectors, new themes (climate, women, youth, digital health), new funder types — edit the search criteria in the app and the next scan reflects it. No code change.

## Run it locally
One line in your computer's built-in terminal — nothing to install by hand:

**macOS**
```bash
curl -fsSL https://grounded.developai.co.za/nodes/resources/mac | bash
```
**Windows** (PowerShell)
```powershell
irm https://grounded.developai.co.za/nodes/resources/windows | iex
```
The first time, it asks for an AI key (it shows you where to get one); the key and
your data stay on your computer.

Or from a clone:
```bash
npm install
npm start        # → http://localhost:3000
```

## How to use it
1. Open **Search criteria** and describe who you are, your strategy, themes, geographies, funder types, and what you won't take.
2. Add your organisation's material under **Your organisation's documents** — past proposals, strategy, results reports.
3. **Scan the web now.** Each result comes with a written case for why it fits you. You can also paste an opportunity you found yourself for the same assessment.
4. Open an opportunity to **discuss** it (eligibility, angle, risks) and to **draft the proposal** from your material.

## What it gives you for free (via the shared runtime)
Local + hosted boots from one set of handlers, tracker-cookie auth when hosted, a
per-organisation data store, the GROUNDED nav + feedback chrome, and the "run it
locally" footer with step-by-step instructions.

By **Develop AI** · part of [Grounded](https://grounded.developai.co.za).
