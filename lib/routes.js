// Resources — the Node's real surface. Mounted on the express app the runtime
// returns, alongside the standard /api/* handlers.
//
//   Local  (index.js):         mountAppRoutes(app, () => host)
//   Hosted (server-hosted.js): mountAppRoutes(app, hostFor)   // per-request host
//
// ALWAYS go through the host interface (host.store / host.ai / host.profile /
// host.log) so the same code runs locally and hosted. NOTE the runtime's GET
// wrap passes no query params — anything parameterised is a POST.
//
// Collections (host.store):
//   criteria       key 'main'         — the adjustable search "backend"
//   opportunities  key = stable id    — found/added opportunities (re-scan upserts)
//   chats          key = opportunity  — the discussion thread per opportunity
//   proposals      key = opportunity  — the working proposal draft per opportunity
//   docs           key = generated    — internal material grounding proposals

import { orgContext, getCriteria, saveCriteria, listDocs, opportunityId, extractJson } from './context.js';

const STATUSES = ['new', 'reviewing', 'pursuing', 'dismissed'];

export function mountAppRoutes(app, getHost) {
  const wrap = (fn) => async (req, res) => {
    let host;
    try {
      host = getHost(req);
      res.json(await fn(req, host));
    } catch (err) {
      console.error('route error:', err);
      res.status(500).json({ ok: false, error: err.message || 'route error' });
      try { await host?.log?.error?.({ op: req.path, error: err, context: { method: req.method } }); }
      catch { /* swallow */ }
    }
  };

  const listOpportunities = async (host) =>
    (await host.store.list('opportunities')).map((o) => o.value).filter(Boolean)
      .sort((a, b) => String(b.found_at).localeCompare(String(a.found_at)));

  // ─── Boot: everything the dashboard needs in one call ─────────────
  app.get('/api/overview', wrap(async (_req, host) => {
    const [criteria, opportunities, docs] = await Promise.all([
      getCriteria(host), listOpportunities(host), listDocs(host),
    ]);
    const profile = host.profile ? await host.profile.get().catch(() => null) : null;
    return { ok: true, criteria, opportunities, docs: docs.map(({ text, ...d }) => ({ ...d, chars: String(text || '').length })), profile };
  }));

  // ─── The adjustable backend: search criteria ───────────────────────
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
    await host.log.run({ op: 'criteria_save' });
    return { ok: true, criteria };
  }));

  // ─── Scan the live web for opportunities ───────────────────────────
  app.post('/api/scan', wrap(async (_req, host) => {
    const context = await orgContext(host);
    if (context.startsWith('No organisation profile')) {
      return { ok: false, message: 'Set your search criteria first — the scan is only as good as what it knows about you.' };
    }
    const r = await host.ai.chat(
      `${context}\n\n` +
      `Search the live web for funding and partnership opportunities CURRENTLY OPEN that this organisation could realistically pursue. ` +
      `Include BOTH formal calls for proposals from institutional donors AND broader openings: corporate partnership programmes, philanthropic funds, foundation windows, embassy small-grant schemes, prize funds. ` +
      `Prioritise opportunities where a funder in a broader movement (climate justice, women's rights, youth, digital health…) would value a partner specialising in marginalised groups and human rights. ` +
      `Only include real opportunities you actually found, with their real URLs — never invent one. If you find nothing verifiable, return [].\n\n` +
      `Return ONLY a JSON array, each item: {"title": "...", "funder": "...", "funder_type": "institutional|corporate|philanthropic|multilateral|embassy|other", ` +
      `"url": "...", "deadline": "YYYY-MM-DD or unknown", "amount": "... or unknown", "summary": "2-3 sentences on what it funds", ` +
      `"why_relevant": "3-4 sentences on why THIS org fits, citing its profile, strategy and themes", "themes": ["..."]}`,
      {
        system: 'You are a resource-mobilisation researcher for a non-profit. You are rigorous: you only report opportunities you actually found on the web, with working URLs. You never fabricate funders, deadlines or amounts — unknown fields are the string "unknown".',
        maxTokens: 4000,
        webSearch: { maxUses: 8 },
      }
    );
    const found = extractJson(r.text);
    if (!Array.isArray(found)) {
      return { ok: false, message: 'The scan came back in a shape we could not read. Try again.', raw: r.text.slice(0, 600) };
    }
    const existing = new Map((await host.store.list('opportunities')).map((o) => [o.key, o.value]));
    let added = 0, refreshed = 0;
    for (const f of found) {
      if (!f || !f.title) continue;
      const id = opportunityId(f.title, f.funder);
      const prev = existing.get(id);
      const opp = {
        id,
        title: String(f.title).slice(0, 300),
        funder: String(f.funder || 'unknown').slice(0, 200),
        funder_type: String(f.funder_type || 'other'),
        url: String(f.url || ''),
        deadline: String(f.deadline || 'unknown'),
        amount: String(f.amount || 'unknown'),
        summary: String(f.summary || ''),
        why_relevant: String(f.why_relevant || ''),
        themes: Array.isArray(f.themes) ? f.themes.map(String) : [],
        source: 'scan',
        status: prev?.status || 'new',            // never resurrect a dismissed one as "new"? keep the org's decision
        found_at: prev?.found_at || new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      };
      await host.store.put('opportunities', id, opp);
      prev ? refreshed++ : added++;
    }
    await host.log.run({ op: 'scan', details: { added, refreshed, searched: found.length } });
    return { ok: true, added, refreshed, citations: r.citations || [], opportunities: await listOpportunities(host) };
  }));

  // ─── Opportunities: list / assess a pasted one / status / delete ───
  app.get('/api/opportunities', wrap(async (_req, host) => ({ ok: true, opportunities: await listOpportunities(host) })));

  // Paste an opportunity you found yourself (text and/or URL) → AI assesses fit.
  app.post('/api/opportunities/assess', wrap(async (req, host) => {
    const text = String(req.body?.text || '').trim();
    if (text.length < 20) return { ok: false, message: 'Paste the call text or a description (a line or two at minimum).' };
    const context = await orgContext(host);
    const r = await host.ai.chat(
      `${context}\n\nHere is a funding/partnership opportunity the organisation found:\n\n${text.slice(0, 12000)}\n\n` +
      `Assess it for THIS organisation. Return ONLY JSON: {"title": "...", "funder": "...", "funder_type": "institutional|corporate|philanthropic|multilateral|embassy|other", ` +
      `"url": "the URL if one appears in the text, else empty string", "deadline": "YYYY-MM-DD or unknown", "amount": "... or unknown", ` +
      `"summary": "2-3 sentences", "why_relevant": "honest 3-4 sentence fit assessment — say plainly if the fit is weak and why", "themes": ["..."]}`,
      { system: 'You assess funding opportunities for a non-profit. Be honest about weak fits — a wrong pursuit costs the org more than a pass. Use only what is in the text and the organisation context; never invent details.', maxTokens: 1200 }
    );
    const f = extractJson(r.text);
    if (!f || !f.title) return { ok: false, message: 'Could not read an opportunity out of that text. Add a title or a bit more detail and try again.' };
    const id = opportunityId(f.title, f.funder);
    const opp = {
      id, title: String(f.title).slice(0, 300), funder: String(f.funder || 'unknown').slice(0, 200),
      funder_type: String(f.funder_type || 'other'), url: String(f.url || ''),
      deadline: String(f.deadline || 'unknown'), amount: String(f.amount || 'unknown'),
      summary: String(f.summary || ''), why_relevant: String(f.why_relevant || ''),
      themes: Array.isArray(f.themes) ? f.themes.map(String) : [],
      source: 'manual', status: 'new',
      found_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    };
    await host.store.put('opportunities', id, opp);
    await host.log.run({ op: 'assess', bytes: text.length });
    return { ok: true, opportunity: opp };
  }));

  app.post('/api/opportunities/status', wrap(async (req, host) => {
    const { id, status } = req.body || {};
    if (!STATUSES.includes(status)) return { ok: false, message: `Status must be one of: ${STATUSES.join(', ')}.` };
    const opp = await host.store.get('opportunities', String(id || ''));
    if (!opp) return { ok: false, message: 'Opportunity not found.' };
    opp.status = status;
    await host.store.put('opportunities', opp.id, opp);
    return { ok: true, opportunity: opp };
  }));

  app.post('/api/opportunities/delete', wrap(async (req, host) => {
    const id = String(req.body?.id || '');
    await host.store.delete('opportunities', id);
    await host.store.delete('chats', id);
    await host.store.delete('proposals', id);
    return { ok: true };
  }));

  // ─── One opportunity, with its thread and draft ────────────────────
  app.post('/api/opportunity', wrap(async (req, host) => {
    const id = String(req.body?.id || '');
    const opportunity = await host.store.get('opportunities', id);
    if (!opportunity) return { ok: false, message: 'Opportunity not found.' };
    const chat = (await host.store.get('chats', id)) || { messages: [] };
    const proposal = (await host.store.get('proposals', id)) || null;
    return { ok: true, opportunity, chat, proposal };
  }));

  // ─── Discuss an opportunity (grounded in the org's experience) ─────
  app.post('/api/chat', wrap(async (req, host) => {
    const id = String(req.body?.id || '');
    const message = String(req.body?.message || '').trim();
    if (!message) return { ok: false, message: 'Type a question first.' };
    const opp = await host.store.get('opportunities', id);
    if (!opp) return { ok: false, message: 'Opportunity not found.' };

    const thread = (await host.store.get('chats', id)) || { messages: [] };
    const history = thread.messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
    const context = await orgContext(host, { withDocs: true, docLimit: 3 });

    const r = await host.ai.chat(
      [...history, { role: 'user', content: message }],
      {
        system:
          `You advise a non-profit's resource-mobilisation team on ONE specific opportunity. Ground every answer in the organisation context below — its experience, strategy and past successes. Be direct about risks, eligibility doubts and weak fit; never invent facts about the funder or the org.\n\n` +
          `THE OPPORTUNITY:\nTitle: ${opp.title}\nFunder: ${opp.funder} (${opp.funder_type})\nDeadline: ${opp.deadline} · Amount: ${opp.amount}\nURL: ${opp.url || 'none'}\nSummary: ${opp.summary}\nWhy flagged as relevant: ${opp.why_relevant}\n\n${context}`,
        maxTokens: 1500,
      }
    );

    const now = new Date().toISOString();
    thread.messages.push({ role: 'user', content: message, at: now }, { role: 'assistant', content: r.text, at: now });
    await host.store.put('chats', id, thread);
    await host.log.run({ op: 'chat', details: { id } });
    return { ok: true, reply: r.text, chat: thread };
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

  // ─── Draft (or redraft) a proposal for an opportunity ──────────────
  app.post('/api/proposal', wrap(async (req, host) => {
    const id = String(req.body?.id || '');
    const instructions = String(req.body?.instructions || '').trim();
    const opp = await host.store.get('opportunities', id);
    if (!opp) return { ok: false, message: 'Opportunity not found.' };

    const prev = (await host.store.get('proposals', id)) || null;
    const context = await orgContext(host, { withDocs: true, docLimit: 6 });

    const r = await host.ai.chat(
      `${context}\n\nTHE OPPORTUNITY:\nTitle: ${opp.title}\nFunder: ${opp.funder} (${opp.funder_type})\nDeadline: ${opp.deadline} · Amount: ${opp.amount}\nURL: ${opp.url || 'none'}\nSummary: ${opp.summary}\nWhy relevant: ${opp.why_relevant}\n\n` +
      (prev?.draft ? `CURRENT DRAFT (revise it, don't start over unless asked):\n${prev.draft.slice(0, 20000)}\n\n` : '') +
      (instructions ? `THE WRITER'S INSTRUCTIONS FOR THIS PASS:\n${instructions}\n\n` : '') +
      `Write ${prev?.draft ? 'the revised' : 'a first'} proposal draft in markdown: problem statement, our track record and fit, proposed approach, expected outcomes, and (if the opportunity states an amount) an indicative budget outline. ` +
      `Draw the track record ONLY from the organisation context and internal documents above. Where a needed fact is missing (dates, figures, named projects), write [FILL IN: what's needed] rather than inventing it. This is a working draft a human will finish and verify — say nothing you can't back from the material given.`,
      {
        system: 'You are an experienced grant writer for a non-profit. You write in the organisation\'s plain, direct register. You never fabricate track record, figures or partnerships — every claim traces to the supplied material, and gaps are marked [FILL IN: …] for the human writer.',
        maxTokens: 4000,
      }
    );

    const proposal = {
      opportunity_id: id,
      draft: r.text,
      passes: [ ...(prev?.passes || []), { instructions: instructions || '(first draft)', at: new Date().toISOString() } ],
      updated_at: new Date().toISOString(),
    };
    await host.store.put('proposals', id, proposal);
    await host.log.run({ op: 'proposal_draft', details: { id, pass: proposal.passes.length } });
    return { ok: true, proposal };
  }));

  // ─── Shared newsroom/org profile (cross-node data layer) ───────────
  app.get('/api/profile', wrap(async (_req, host) => ({
    ok: true,
    profile: host.profile ? await host.profile.get() : null,
  })));
}
