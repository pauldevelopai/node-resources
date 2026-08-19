// Resources — the AI checkpoints for the 'funding_call' entity, built on the
// engine's factories with our own prompts (prompts are consumer config). The
// model extracts and evidences; it NEVER scores — routing is arithmetic.
//
// Three checkpoints:
//   1. extractCallFields   — structured fields from a call/opportunity text
//   2. makeEvidence        — evidence flags + an honest org-fit note (needs org
//                            context, so it's a per-request factory)
//   3. extractFunderProfile — deck step 2: the funder's priorities in their own
//                            words, so proposals can mirror their language

import { makeFieldExtractor, makeEvidenceExtractor, parseJson } from '@developai/grounded-opportunity-engine';
import { callClaude } from './claude.js';

const chat = (args) => callClaude(args);

const EXTRACT_SYSTEM =
  `You extract structured fields from a funding/partnership opportunity text (a call for proposals, ` +
  `a foundation page, a corporate programme description, an email). ` +
  `CRITICAL: never guess. If a field is not clearly present, use null and add its name to "not_stated". ` +
  `Do not infer values that aren't written.\n\n` +
  `Return ONE JSON object, no prose, no code fence:\n` +
  `{\n` +
  `  "title": string|null,\n` +
  `  "funder": string|null,\n` +
  `  "funder_type": "institutional"|"corporate"|"philanthropic"|"multilateral"|"embassy"|"other"|null,\n` +
  `  "url": string|null,                        // only if a URL appears in the text\n` +
  `  "closing_date": "YYYY-MM-DD"|null,\n` +
  `  "amount": string|null,                     // verbatim, e.g. "USD 50,000 max" — never converted\n` +
  `  "jurisdiction": string|null,               // where applicants must be / where work happens\n` +
  `  "language": string|null,                   // language of the call\n` +
  `  "themes": string[],                        // e.g. ["climate","women","youth","digital health"]\n` +
  `  "geographies": string[],\n` +
  `  "eligibility": string|null,                // who may apply, verbatim requirements\n` +
  `  "summary": string|null,                    // 2-3 sentences on what it funds\n` +
  `  "not_stated": string[]\n` +
  `}`;

export const extractCallFields = makeFieldExtractor({
  chat,
  system: EXTRACT_SYSTEM,
  maxTokens: 1200,
  normalise: (p) => ({
    title: p.title ?? null,
    funder: p.funder ?? null,
    funder_type: p.funder_type ?? null,
    url: p.url ?? null,
    closing_date: p.closing_date ?? null,
    amount: p.amount ?? null,
    jurisdiction: p.jurisdiction ?? null,
    language: p.language ?? null,
    themes: Array.isArray(p.themes) ? p.themes.map(String) : [],
    geographies: Array.isArray(p.geographies) ? p.geographies.map(String) : [],
    eligibility: p.eligibility ?? null,
    summary: p.summary ?? null,
    not_stated: Array.isArray(p.not_stated) ? p.not_stated : [],
  }),
});

// Evidence + fit is org-specific, so the extractor is built per request with the
// tenant's context in the system prompt. The qualification_note doubles as the
// "why this fits YOU" explanation PV asked for — and it must stay honest about
// weak fits: a wrong pursuit costs the org more than a pass.
export const makeEvidence = (orgContext) => makeEvidenceExtractor({
  chat,
  maxTokens: 1200,
  system:
    `You are a resource-mobilisation analyst pulling the EVIDENCE behind a funding opportunity's routing — ` +
    `you do NOT score or decide the band. Given the call text, the extracted fields, and the deterministic ` +
    `routing already computed, return verbatim quotes a reviewer needs, plus a fit note.\n\n` +
    `THE ORGANISATION you assess fit FOR:\n${orgContext}\n\n` +
    `Return ONE JSON object, no prose, no code fence:\n` +
    `{\n` +
    `  "flags": [\n` +
    `    { "flag_type": "eligibility_gap"|"theme_fit"|"geography_fit"|"deadline_tight"|"amount_fit"|"missing_field"|"other",\n` +
    `      "severity": 1-5, "confidence": 0.0-1.0,\n` +
    `      "evidence_note": "a VERBATIM quote from the call, or a short factual note if no quote exists" }\n` +
    `  ],\n` +
    `  "qualification_note": "3-4 sentences: why this DOES or DOES NOT fit this organisation, citing its profile, strategy and themes. Be honest about weak fit."\n` +
    `}`,
});

// Deck step 2 — what does the funder stand for? Their priorities in THEIR OWN
// repeated words, so a proposal can mirror the language. On-demand, per call.
const FUNDER_PROFILE_SYSTEM =
  `You analyse what a funder stands for, from their call text and (if reachable) their public web presence. ` +
  `Report only what you actually find — never invent priorities.\n\n` +
  `Return ONE JSON object, no prose, no code fence:\n` +
  `{\n` +
  `  "priorities": string[],                    // their top 3-5 priorities, each a short phrase\n` +
  `  "their_language": string[],                // exact words/phrases the funder repeats (verbatim)\n` +
  `  "outcomes_wanted": string[],               // what results they say they want to see\n` +
  `  "application_advice": string|null          // anything they say about what makes a strong application\n` +
  `}`;

export async function extractFunderProfile({ funder, title, url, text }) {
  const raw = await callClaude({
    system: FUNDER_PROFILE_SYSTEM,
    userContent:
      `FUNDER: ${funder || 'unknown'}\nOPPORTUNITY: ${title || ''}\nURL: ${url || 'none'}\n\n` +
      `CALL TEXT:\n"""\n${String(text || '').slice(0, 10000)}\n"""\n\n` +
      `Search the web for this funder's stated priorities if you can; otherwise work from the call text alone.`,
    maxTokens: 1200,
    webSearch: { maxUses: 3 },
  });
  const p = parseJson(raw) || {};
  return {
    priorities: Array.isArray(p.priorities) ? p.priorities.map(String) : [],
    their_language: Array.isArray(p.their_language) ? p.their_language.map(String) : [],
    outcomes_wanted: Array.isArray(p.outcomes_wanted) ? p.outcomes_wanted.map(String) : [],
    application_advice: p.application_advice ? String(p.application_advice) : null,
    drafted_at: new Date().toISOString(),
  };
}
