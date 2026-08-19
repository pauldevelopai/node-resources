// Resources — the Node's real surface. A thin configuration of the shared
// Opportunity Finder engine (entity 'funding_call') plus the fundraising
// features around it: grounded discussion, funder profiles, proposal drafting.
//
//   Local  (index.js):         mountAppRoutes(app, () => host)
//   Hosted (server-hosted.js): mountAppRoutes(app, hostFor)   // per-request host
//
// Storage split:
//   resources.* tables (engine-standard, Postgres) — sources, criteria versions,
//     raw items, funding_calls + flags, runs. Tenant = resolved in-Node.
//   host.store — prose criteria card, org docs, chats, proposal drafts
//     (per-tenant working state, identical local + hosted).
//   host.corpus (runtime ≥ v0.16) — every kept funding call projects into the
//     news_opportunities corpus; guarded, so runtime v0.15 still runs.

import { toCorpusRecord } from '@developai/grounded-opportunity-engine';
import { orgContext, getCriteria, saveCriteria, listDocs, opportunityId, extractJson } from './context.js';
import { getPool, requirePool } from './pool.js';
import { callClaude } from './claude.js';
import { tenantOf, pipelineFor, refreshCriteriaFromForm, SCHEMA } from './engine.js';
import { extractFunderProfile } from './extract.js';

const STATUSES = ['new', 'qualified', 'needs_review', 'rejected', 'pursuing', 'resolved'];
const OUTCOMES = ['applied', 'won', 'lost', 'dismissed'];

export function mountAppRoutes(app, getHost) {
  const wrap = (fn) => async (req, res) => {
    let host;
    try {
      host = getHost(req);
      res.json(await fn(req, host));
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('route error:', err);
      res.status(status).json({ ok: false, error: err.message || 'route error' });
      try { if (status >= 500) await host?.log?.error?.({ op: req.path, error: err, context: { method: req.method } }); }
      catch { /* swallow */ }
    }
  };

  const listCalls = async (tenantId) => {
    const pool = requirePool();
    const { rows } = await pool.query(
      `SELECT id, title, funder, funder_type, url, closing_date, amount, jurisdiction,
              band, total_score, routing_reason, status, outcome, funder_profile IS NOT NULL AS has_funder_profile,
              corpus_record_id IS NOT NULL AS in_corpus, extracted->>'summary' AS summary, ingested_at
         FROM ${SCHEMA}.funding_calls
        WHERE newsroom_id = $1
        ORDER BY (status = 'pursuing') DESC, (band = 'green') DESC, closing_date ASC NULLS LAST, ingested_at DESC
        LIMIT 200`, [tenantId]);
    return rows;
  };

  const getCall = async (tenantId, id) => {
    const pool = requirePool();
    const { rows: [row] } = await pool.query(
      `SELECT * FROM ${SCHEMA}.funding_calls WHERE newsroom_id = $1 AND id = $2`, [tenantId, id]);
    return row || null;
  };

  // Project one kept call into the news & opportunities corpus. Guarded: on
  // runtime < v0.16 host.corpus is absent → honestly report not-written.
  async function corpusAdd(host, tenantId, callRow) {
    if (!host.corpus?.add) return { written: false, reason: 'runtime has no host.corpus yet' };
    try {
      const rec = toCorpusRecord({
        collection: 'news_opportunities',
        title: callRow.title || 'Untitled opportunity',
        source_url: callRow.url || null,
        date: callRow.closing_date || callRow.ingested_at || null,
        jurisdiction: callRow.jurisdiction || null,
        language: callRow.language || null,
        summary: callRow.extracted?.summary || null,
        entity: 'funding_call',
        tenant: tenantId,
        extra: { funder: callRow.funder, funder_type: callRow.funder_type, amount: callRow.amount, band: callRow.band },
      });
      const r = await host.corpus.add(rec);
      if (r?.id) {
        await requirePool().query(
          `UPDATE ${SCHEMA}.funding_calls SET corpus_record_id = $2, updated_at = NOW() WHERE id = $1`, [callRow.id, r.id]);
      }
      return { written: !!r?.inserted, id: r?.id || null };
    } catch (err) {
      console.error('corpus write-back failed:', err.message);
      return { written: false, reason: err.message };
    }
  }

  async function ensureNamedSource(tenantId, name, kind) {
    const pool = requirePool();
    const { rows: [found] } = await pool.query(
      `SELECT id FROM ${SCHEMA}.sources WHERE newsroom_id = $1 AND name = $2 LIMIT 1`, [tenantId, name]);
    if (found) return found.id;
    const { rows: [created] } = await pool.query(
      `INSERT INTO ${SCHEMA}.sources (newsroom_id, name, kind, origin) VALUES ($1, $2, $3, 'seed') RETURNING id`,
      [tenantId, name, kind]);
    return created.id;
  }

  // ─── Boot: everything the dashboard needs in one call ─────────────
  app.get('/api/overview', wrap(async (req, host) => {
    const [criteria, docs] = await Promise.all([getCriteria(host), listDocs(host)]);
    const profile = host.profile ? await host.profile.get().catch(() => null) : null;
    const dbReady = !!getPool();
    let opportunities = [], sources = [];
    if (dbReady) {
      const tenant = await tenantOf(req);
      opportunities = await listCalls(tenant.id);
      const { rows } = await requirePool().query(
        `SELECT id, name, kind, location, active, items_seen, items_new, last_success_at, last_error
           FROM ${SCHEMA}.sources WHERE newsroom_id = $1 AND active = true ORDER BY created_at`, [tenant.id]);
      sources = rows;
    }
    return {
      ok: true, dbReady, criteria, profile, opportunities, sources,
      docs: docs.map(({ text, ...d }) => ({ ...d, chars: String(text || '').length })),
    };
  }));

  // ─── The adjustable backend: criteria card (prose + scoring lists) ──
  app.post('/api/criteria', wrap(async (req, host) => {
    const b = req.body || {};
    const asList = (v) => Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean)
      : String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    const criteria = await saveCriteria(host, {
      identity: String(b.identity || '').trim(),
      strategy: String(b.strategy || '').trim(),
      themes: asList(b.themes),
      geographies: asList(b.geographies),
      donor_types: asList(b.donor_types),
      keywords: asList(b.keywords),
      eligibility: String(b.eligibility || '').trim(),
      exclusions: String(b.exclusions || '').trim(),
    });
    // The lists also drive the arithmetic routing: regenerate the tenant's
    // active engine criteria version (config edit — never a redeploy).
    let scoringRefreshed = false;
    if (getPool()) {
      const tenant = await tenantOf(req);
      await refreshCriteriaFromForm(requirePool(), tenant.id, criteria);
      scoringRefreshed = true;
    }
    await host.log.run({ op: 'criteria_save', details: { scoringRefreshed } });
    return { ok: true, criteria, scoringRefreshed };
  }));

  // ─── Source list (deck step 1: the places you look) ────────────────
  app.post('/api/sources', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const name = String(req.body?.name || '').trim();
    const location = String(req.body?.location || '').trim() || null;
    const kind = ['html', 'rss', 'upload', 'search'].includes(req.body?.kind) ? req.body.kind : 'html';
    if (!name) return { ok: false, message: 'Give the source a name.' };
    const pool = requirePool();
    await pool.query(
      `INSERT INTO ${SCHEMA}.sources (newsroom_id, name, kind, location, origin) VALUES ($1, $2, $3, $4, 'human')`,
      [tenant.id, name, kind, location]);
    await host.log.run({ op: 'source_add' });
    return { ok: true };
  }));

  app.post('/api/sources/delete', wrap(async (req, _host) => {
    const tenant = await tenantOf(req);
    // Deactivate, never delete — runs/raw_items history stays honest.
    await requirePool().query(
      `UPDATE ${SCHEMA}.sources SET active = false, updated_at = NOW() WHERE newsroom_id = $1 AND id = $2`,
      [tenant.id, String(req.body?.id || '')]);
    return { ok: true };
  }));

  // ─── Scan: web discovery → engine pipeline (extract→score→evidence) ─
  app.post('/api/scan', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const context = await orgContext(host);
    if (context.startsWith('No organisation profile')) {
      return { ok: false, message: 'Set your search criteria first — the scan is only as good as what it knows about you.' };
    }
    const pool = requirePool();
    const { rows: srcRows } = await pool.query(
      `SELECT name, location FROM ${SCHEMA}.sources WHERE newsroom_id = $1 AND active = true AND location IS NOT NULL`, [tenant.id]);
    const sourceHints = srcRows.length
      ? `\n\nPRIORITY PLACES TO LOOK (the org's own source list — check these first):\n` +
        srcRows.map((s) => `- ${s.name}: ${s.location}`).join('\n')
      : '';

    const raw = await callClaude({
      system: 'You are a resource-mobilisation researcher for a non-profit. You are rigorous: you only report opportunities you actually found on the web, with working URLs. You never fabricate funders, deadlines or amounts.',
      userContent:
        `${context}${sourceHints}\n\n` +
        `Search the live web for funding and partnership opportunities CURRENTLY OPEN that this organisation could realistically pursue. ` +
        `Include BOTH formal calls for proposals from institutional donors AND broader openings: corporate partnership programmes, philanthropic funds, foundation windows, embassy small-grant schemes, prize funds. ` +
        `Prioritise opportunities where a funder in a broader movement (climate justice, women's rights, youth, digital health…) would value a partner specialising in this organisation's niche. ` +
        `If you find nothing verifiable, return [].\n\n` +
        `Return ONLY a JSON array, each item: {"url": "the real URL you found", "title": "...", "funder": "...", ` +
        `"text": "everything you learned about this opportunity, in full sentences — what it funds, who may apply, deadline, amounts, themes; this text is re-read by an extraction step, so include ALL specifics you saw"}`,
      maxTokens: 4000,
      webSearch: { maxUses: 8 },
    });
    const found = extractJson(raw);
    if (!Array.isArray(found)) {
      return { ok: false, message: 'The scan came back in a shape we could not read. Try again.', raw: String(raw).slice(0, 600) };
    }
    const sourceId = await ensureNamedSource(tenant.id, 'Web scan', 'search');
    const pipeline = pipelineFor(context);
    const items = found.filter((f) => f && f.text).map((f) => ({
      text: `${f.title || ''}\nFunder: ${f.funder || ''}\nURL: ${f.url || ''}\n\n${f.text}`,
      externalId: (f.url && String(f.url).trim()) || opportunityId(f.title, f.funder),
      url: f.url || null,
      hints: { title: f.title || null, funder: f.funder || null, url: f.url || null },
    }));
    const out = await pipeline.runPipeline({ newsroomId: tenant.id, sourceId, items });

    // Corpus write-back for every NEW call this run created.
    let corpusWritten = 0;
    for (const r of out.results) {
      if (!r?.entity_id) continue;
      const row = await getCall(tenant.id, r.entity_id);
      if (row && (await corpusAdd(host, tenant.id, row)).written) corpusWritten++;
    }
    await host.log.run({ op: 'scan', details: { ...out.digest, corpusWritten } });
    return { ok: true, digest: out.digest, corpusWritten, opportunities: await listCalls(tenant.id) };
  }));

  // ─── Paste one you found yourself → same pipeline, same honesty ─────
  app.post('/api/opportunities/assess', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const text = String(req.body?.text || '').trim();
    if (text.length < 20) return { ok: false, message: 'Paste the call text or a description (a line or two at minimum).' };
    const context = await orgContext(host);
    const sourceId = await ensureNamedSource(tenant.id, 'Pasted by you', 'upload');
    const pipeline = pipelineFor(context);
    const r = await pipeline.ingestItem({
      newsroomId: tenant.id, sourceId,
      criteria: await pipeline.getCriteria(tenant.id),
      text, externalId: null, url: null,
    });
    if (r.duplicate) return { ok: false, message: 'That one is already in your list (same content).' };
    const row = await getCall(tenant.id, r.entity_id);
    if (row) await corpusAdd(host, tenant.id, row);
    await host.log.run({ op: 'assess', bytes: text.length });
    return { ok: true, opportunity: row, band: r.band, routing_reason: r.routing_reason };
  }));

  // ─── One opportunity, with flags, thread, draft, funder profile ─────
  app.post('/api/opportunity', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const id = String(req.body?.id || '');
    const opportunity = await getCall(tenant.id, id);
    if (!opportunity) return { ok: false, message: 'Opportunity not found.' };
    const { rows: flags } = await requirePool().query(
      `SELECT flag_type, severity, confidence, evidence_note FROM ${SCHEMA}.funding_call_flags
        WHERE funding_call_id = $1 ORDER BY severity DESC`, [id]);
    const chat = (await host.store.get('chats', id)) || { messages: [] };
    const proposal = (await host.store.get('proposals', id)) || null;
    return { ok: true, opportunity, flags, chat, proposal };
  }));

  app.post('/api/opportunities/status', wrap(async (req, _host) => {
    const tenant = await tenantOf(req);
    const { id, status } = req.body || {};
    if (!STATUSES.includes(status)) return { ok: false, message: `Status must be one of: ${STATUSES.join(', ')}.` };
    await requirePool().query(
      `UPDATE ${SCHEMA}.funding_calls SET status = $3, updated_at = NOW() WHERE newsroom_id = $1 AND id = $2`,
      [tenant.id, String(id || ''), status]);
    return { ok: true };
  }));

  // Outcome — the most valuable data we collect. Recorded by a named person.
  app.post('/api/opportunities/outcome', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const { id, outcome, note } = req.body || {};
    if (!OUTCOMES.includes(outcome)) return { ok: false, message: `Outcome must be one of: ${OUTCOMES.join(', ')}.` };
    const recordedBy = tenant.email || String(req.body?.recorded_by || '').trim();
    if (!recordedBy) return { ok: false, message: 'Outcomes are recorded by a named person — add your name.' };
    const row = await getCall(tenant.id, String(id || ''));
    if (!row) return { ok: false, message: 'Opportunity not found.' };
    await requirePool().query(
      `UPDATE ${SCHEMA}.funding_calls
          SET outcome = $3, outcome_note = $4, outcome_recorded_by = $5, outcome_at = NOW(), updated_at = NOW()
        WHERE newsroom_id = $1 AND id = $2`,
      [tenant.id, row.id, outcome, String(note || '').trim() || null, recordedBy]);
    if (row.corpus_record_id && host.corpus?.setOutcome) {
      try { await host.corpus.setOutcome(row.corpus_record_id, outcome); } catch (e) { console.error('corpus outcome:', e.message); }
    }
    await host.log.run({ op: 'outcome', details: { outcome } });
    return { ok: true };
  }));

  // Human verification — flips the corpus record to human_verified, by name.
  app.post('/api/opportunities/verify', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const verifiedBy = tenant.email || String(req.body?.verified_by || '').trim();
    if (!verifiedBy) return { ok: false, message: 'Verification is a named person\'s act — add your name.' };
    const row = await getCall(tenant.id, String(req.body?.id || ''));
    if (!row) return { ok: false, message: 'Opportunity not found.' };
    if (!row.corpus_record_id || !host.corpus?.verify) {
      return { ok: false, message: 'This record is not in the corpus yet (needs the corpus-enabled runtime).' };
    }
    await host.corpus.verify(row.corpus_record_id, verifiedBy);
    await host.log.run({ op: 'verify', details: { id: row.id } });
    return { ok: true, verified_by: verifiedBy };
  }));

  app.post('/api/opportunities/delete', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const id = String(req.body?.id || '');
    await requirePool().query(
      `DELETE FROM ${SCHEMA}.funding_calls WHERE newsroom_id = $1 AND id = $2`, [tenant.id, id]);
    await host.store.delete('chats', id);
    await host.store.delete('proposals', id);
    return { ok: true };
  }));

  // ─── Funder profile (deck step 2: what do they stand for?) ──────────
  app.post('/api/funderprofile', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const row = await getCall(tenant.id, String(req.body?.id || ''));
    if (!row) return { ok: false, message: 'Opportunity not found.' };
    const profile = await extractFunderProfile({
      funder: row.funder, title: row.title, url: row.url,
      text: row.raw_item_id
        ? (await requirePool().query(`SELECT content FROM ${SCHEMA}.raw_items WHERE id = $1`, [row.raw_item_id])).rows[0]?.content
        : row.extracted?.summary,
    });
    await requirePool().query(
      `UPDATE ${SCHEMA}.funding_calls SET funder_profile = $3::jsonb, updated_at = NOW() WHERE newsroom_id = $1 AND id = $2`,
      [tenant.id, row.id, JSON.stringify(profile)]);
    await host.log.run({ op: 'funder_profile', details: { id: row.id } });
    return { ok: true, funder_profile: profile };
  }));

  // ─── Discuss an opportunity (grounded in the org's experience) ──────
  app.post('/api/chat', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const id = String(req.body?.id || '');
    const message = String(req.body?.message || '').trim();
    if (!message) return { ok: false, message: 'Type a question first.' };
    const opp = await getCall(tenant.id, id);
    if (!opp) return { ok: false, message: 'Opportunity not found.' };

    const thread = (await host.store.get('chats', id)) || { messages: [] };
    const history = thread.messages.slice(-12).map((m) => `${m.role === 'user' ? 'THEM' : 'YOU'}: ${m.content}`).join('\n\n');
    const context = await orgContext(host, { withDocs: true, docLimit: 3 });
    const fp = opp.funder_profile
      ? `\nFUNDER PROFILE (their own language):\npriorities: ${opp.funder_profile.priorities?.join('; ')}\nphrases they repeat: ${opp.funder_profile.their_language?.join('; ')}\noutcomes they want: ${opp.funder_profile.outcomes_wanted?.join('; ')}`
      : '';

    const text = await callClaude({
      system:
        `You advise a non-profit's resource-mobilisation team on ONE specific opportunity. Ground every answer in the organisation context — its experience, strategy and past successes. Be direct about risks, eligibility doubts and weak fit; never invent facts about the funder or the org.\n\n` +
        `THE OPPORTUNITY:\nTitle: ${opp.title}\nFunder: ${opp.funder} (${opp.funder_type})\nDeadline: ${opp.closing_date || 'unknown'} · Amount: ${opp.amount || 'unknown'}\nURL: ${opp.url || 'none'}\nRouting: ${opp.band} — ${opp.routing_reason}\nSummary: ${opp.extracted?.summary || ''}\nFit note: ${opp.extracted?.qualification_note || ''}${fp}\n\n${context}`,
      userContent: (history ? `CONVERSATION SO FAR:\n${history}\n\n` : '') + `THEIR QUESTION:\n${message}`,
      maxTokens: 1500,
    });

    const now = new Date().toISOString();
    thread.messages.push({ role: 'user', content: message, at: now }, { role: 'assistant', content: text, at: now });
    await host.store.put('chats', id, thread);
    await host.log.run({ op: 'chat', details: { id } });
    return { ok: true, reply: text, chat: thread };
  }));

  // ─── Internal documents (ground the proposal writing) ──────────────
  app.get('/api/docs', wrap(async (_req, host) => ({
    ok: true,
    docs: (await listDocs(host)).map(({ text, ...d }) => ({ ...d, chars: String(text || '').length })),
  })));

  app.post('/api/docs', wrap(async (req, host) => {
    const title = String(req.body?.title || '').trim();
    const text = String(req.body?.text || '').trim();
    const kind = String(req.body?.kind || 'document').trim();
    if (!title || text.length < 40) return { ok: false, message: 'Give the document a title and paste its text (a paragraph at minimum).' };
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await host.store.put('docs', key, { title, kind, text: text.slice(0, 60000), added_at: new Date().toISOString() });
    await host.log.run({ op: 'doc_add', bytes: text.length });
    return { ok: true };
  }));

  app.post('/api/docs/delete', wrap(async (req, host) => {
    await host.store.delete('docs', String(req.body?.key || ''));
    return { ok: true };
  }));

  // ─── Draft (or revise) a proposal — funder-derived structure ────────
  app.post('/api/proposal', wrap(async (req, host) => {
    const tenant = await tenantOf(req);
    const id = String(req.body?.id || '');
    const instructions = String(req.body?.instructions || '').trim();
    const opp = await getCall(tenant.id, id);
    if (!opp) return { ok: false, message: 'Opportunity not found.' };

    const prev = (await host.store.get('proposals', id)) || null;
    const context = await orgContext(host, { withDocs: true, docLimit: 6 });
    const fp = opp.funder_profile;

    const text = await callClaude({
      system:
        'You are an experienced grant writer for a non-profit. You write in the organisation\'s plain, direct register. ' +
        'You never fabricate track record, figures or partnerships — every claim traces to the supplied material, and gaps are marked [FILL IN: …] for the human writer. ' +
        'The draft is a working document a named human finishes and verifies before anything is submitted.',
      userContent:
        `${context}\n\nTHE OPPORTUNITY:\nTitle: ${opp.title}\nFunder: ${opp.funder} (${opp.funder_type})\nDeadline: ${opp.closing_date || 'unknown'} · Amount: ${opp.amount || 'unknown'}\nURL: ${opp.url || 'none'}\nEligibility (verbatim): ${opp.extracted?.eligibility || 'not stated'}\nSummary: ${opp.extracted?.summary || ''}\n` +
        (fp ? `\nFUNDER PROFILE — mirror this language where it is true of the org:\nPriorities: ${fp.priorities?.join('; ')}\nTheir exact phrases: ${fp.their_language?.join('; ')}\nOutcomes they want: ${fp.outcomes_wanted?.join('; ')}\n${fp.application_advice ? `Their application advice: ${fp.application_advice}\n` : ''}` : '') +
        (prev?.draft ? `\nCURRENT DRAFT (revise it, don't start over unless asked):\n${prev.draft.slice(0, 20000)}\n` : '') +
        (instructions ? `\nTHE WRITER'S INSTRUCTIONS FOR THIS PASS:\n${instructions}\n` : '') +
        `\nWrite ${prev?.draft ? 'the revised' : 'a first'} proposal draft in markdown. ` +
        `DERIVE the section structure from what THIS call asks for (its eligibility and summary above)${fp ? ' and the funder profile' : ''}; ` +
        `always include, whatever else the call needs: a problem statement backed by evidence (mark unverified statistics [FILL IN: verify]), ` +
        `our track record and fit (ONLY from the organisation context and internal documents), the proposed approach, expected outcomes, ` +
        `a MONITORING & EVALUATION section, a SUSTAINABILITY section (how this reduces donor dependency, drawing on the org's real revenue streams if stated), ` +
        `a BUDGET table in markdown with percentage splits across staff, activities, equipment, training and M&E (realistic balance — never 90% salaries, never 0% M&E; use [FILL IN] for unknown figures), ` +
        `and a month-by-month WORKPLAN table. Where a needed fact is missing, write [FILL IN: what's needed] rather than inventing it.`,
      maxTokens: 4000,
    });

    const proposal = {
      opportunity_id: id,
      draft: text,
      passes: [...(prev?.passes || []), { instructions: instructions || '(first draft)', at: new Date().toISOString() }],
      updated_at: new Date().toISOString(),
    };
    await host.store.put('proposals', id, proposal);
    await host.log.run({ op: 'proposal_draft', details: { id, pass: proposal.passes.length } });
    return { ok: true, proposal };
  }));

  // ─── Shared org profile (cross-node data layer) ─────────────────────
  app.get('/api/profile', wrap(async (_req, host) => ({
    ok: true,
    profile: host.profile ? await host.profile.get() : null,
  })));
}
