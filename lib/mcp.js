// Resources — the MCP front door (Model Context Protocol, JSON-RPC 2.0).
//
// The fundraising twin of node-leadfinder's connector: a fundraiser adds this
// to Claude.ai or ChatGPT and works the whole loop conversationally — "what
// funding calls fit us?", "tell me about this funder", "we applied", "we won
// it". Same shape, same auth model, same honesty rules; the entity is a
// funding call rather than a company.
//
// Ported from node-leadfinder/lib/mcp.js (the reference implementation). Both
// hand-roll the same remote-MCP plumbing — JSON-RPC + SSE envelope, per-tenant
// bearer key, the keyed URL claude.ai needs, OAuth-discovery 404s, usage
// logging. That duplication is deliberate for now and is the case FOR lifting
// this into grounded-node-runtime as createHostedMcp(); see the MCP-layer plan.
//
// Auth: a per-tenant key, SHA-256 hashed at rest. The key IS the tenancy —
// every tool call is scoped to its newsroom (Wall 1). No public endpoint: a
// funder pipeline is the organisation's own working data.
//
// Keyed URL: claude.ai / ChatGPT connector UIs offer only "no auth" or full
// OAuth, and a 401 sends them hunting for a sign-in service that does not
// exist. So each key also works as a path: /mcp/k/<key>. The key then rides in
// the URL (our access log, their stored config) — acceptable for a revocable,
// per-tenant key; the real fix is an MCP OAuth server, shared runtime-side.

import { Router } from 'express';
import crypto from 'node:crypto';
import { requirePool } from './pool.js';
import { SCHEMA, tenantOf, pipelineFor } from './engine.js';
import { orgContext, getCriteria, saveCriteria } from './context.js';
import { fetchGrantsGov } from './sources-gov.js';

const OUTCOMES = ['applied', 'won', 'lost', 'dismissed'];
const STATUSES = ['new', 'qualified', 'needs_review', 'rejected', 'pursuing', 'resolved'];

// ── schema for keys + usage (additive; mirrors leadfinder's) ─────────────────
export async function ensureMcpSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.mcp_keys (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    newsroom_id  UUID NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rs_mcp_keys_hash ON ${SCHEMA}.mcp_keys(key_hash) WHERE is_active`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.mcp_usage (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    newsroom_id UUID NOT NULL,
    key_id      UUID,
    tool        VARCHAR(60) NOT NULL,
    args        JSONB,
    ok          BOOLEAN NOT NULL DEFAULT true,
    called_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rs_mcp_usage_tenant ON ${SCHEMA}.mcp_usage(newsroom_id, called_at DESC)`);
}

// Key management, mounted inside the cookie-authed /api surface.
export function mountMcpKeyRoutes(app, getHost) {
  app.get('/api/mcp-keys', async (req, res) => {
    try {
      const tenant = await tenantOf(req);
      const { rows } = await requirePool().query(
        `SELECT id, label, is_active, last_used_at, created_at FROM ${SCHEMA}.mcp_keys
          WHERE newsroom_id = $1 ORDER BY created_at DESC`, [tenant.id]);
      res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/mcp-keys', async (req, res) => {
    try {
      const tenant = await tenantOf(req);
      const label = String(req.body?.label || '').trim().slice(0, 200);
      if (!label) return res.status(400).json({ error: 'label is required — say whose key this is' });
      const key = `rs_${crypto.randomBytes(24).toString('base64url')}`;
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      const { rows: [row] } = await requirePool().query(
        `INSERT INTO ${SCHEMA}.mcp_keys (newsroom_id, key_hash, label) VALUES ($1,$2,$3)
         RETURNING id, label, created_at`, [tenant.id, hash, label]);
      res.status(201).json({ ...row, key, note: 'Copy this key now — it is shown once and never stored.' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.delete('/api/mcp-keys/:id', async (req, res) => {
    try {
      const tenant = await tenantOf(req);
      const { rowCount } = await requirePool().query(
        `UPDATE ${SCHEMA}.mcp_keys SET is_active = false WHERE id = $1 AND newsroom_id = $2`,
        [req.params.id, tenant.id]);
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true, note: 'Key revoked. Connectors using it stop working on their next call.' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
}

// ── tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_funding',
    description: 'The funding shortlist: open calls found and scored against your organisation\'s own profile (what you do, where, for whom). Each result carries why it fits, what is missing, and its deadline. HOW TO PRESENT — never a bare list: give the top 3-5 calls a short readable paragraph each (what the funder wants, why it fits this organisation, the deadline, and what would make the application hard), then list the rest briefly. Link the notice. Say plainly when eligibility for a non-US or African applicant is unconfirmed.',
    inputSchema: { type: 'object', properties: {
      band: { type: 'string', enum: ['green', 'amber', 'red'], description: 'green = strongest fit' },
      status: { type: 'string', enum: STATUSES },
      q: { type: 'string', description: 'Title or funder contains…' },
      limit: { type: 'number', description: 'Max results (default 20, cap 50)' },
    }, required: [] },
  },
  {
    name: 'get_funding_call',
    description: 'Everything on one funding call: the fit score with its per-component reasoning, the funder, deadline, amount, eligibility, the evidence quotes behind the scoring, and any decision or outcome recorded so far.',
    inputSchema: { type: 'object', properties: {
      call_id: { type: 'string' },
      title: { type: 'string', description: 'Exact-ish title, if you have no id' },
    }, required: [] },
  },
  {
    name: 'log_funding_outcome',
    description: 'THE FEEDBACK LOOP — the most valuable thing you can record. Say what happened to a call: applied / won / lost / dismissed, and ALWAYS the reason (what made it win, why it was dropped or lost). Outcome data is what teaches the scoring which calls are actually worth an application; after enough outcomes the system proposes better weights for a human to approve.',
    inputSchema: { type: 'object', properties: {
      call_id: { type: 'string' },
      outcome: { type: 'string', enum: OUTCOMES },
      reason: { type: 'string', description: 'WHY — ask if not given' },
      amount: { type: 'string', description: 'Amount won, if any' },
    }, required: ['call_id', 'outcome'] },
  },
  {
    name: 'get_org_profile',
    description: 'The organisation profile the scoring uses: identity, strategy, themes, geographies, donor types, eligibility and exclusions. Read this before judging any call\'s fit, and before researching new funders — it is what "fits us" means.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_org_profile',
    description: 'Update the organisation profile from what the user tells you — their themes, the countries they work in, the kinds of funder they want, what they will not take. Only record what the user actually says; never infer or invent a mission. This is config, so it takes effect immediately and future scoring uses it.',
    inputSchema: { type: 'object', properties: {
      identity: { type: 'string' }, strategy: { type: 'string' },
      themes: { type: 'array', items: { type: 'string' } },
      geographies: { type: 'array', items: { type: 'string' } },
      donor_types: { type: 'array', items: { type: 'string' } },
      keywords: { type: 'array', items: { type: 'string' } },
      eligibility: { type: 'string' }, exclusions: { type: 'string' },
    }, required: [] },
  },
  {
    name: 'scan_funding_sources',
    description: 'Look for new funding calls now: searches the live grants.gov feed using this organisation\'s own themes, keeps only calls a non-US non-profit could apply for, and scores them against the profile. Slow (a minute or two) and it uses the organisation\'s AI budget, so prefer the overnight run unless the user asks for fresh results.',
    inputSchema: { type: 'object', properties: {
      limit: { type: 'number', description: 'Max calls to bring in (default 10)' },
    }, required: [] },
  },
];

// ── implementations (every one scoped by the key's newsroom) ─────────────────
async function toolSearchFunding(newsroomId, args) {
  const pool = requirePool();
  const clauses = ['newsroom_id = $1']; const params = [newsroomId];
  if (args.band)   { params.push(args.band);   clauses.push(`band = $${params.length}`); }
  if (args.status) { params.push(args.status); clauses.push(`status = $${params.length}`); }
  if (args.q)      { params.push(`%${String(args.q).toLowerCase()}%`); clauses.push(`(LOWER(title) LIKE $${params.length} OR LOWER(funder) LIKE $${params.length})`); }
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
  const { rows } = await pool.query(
    `SELECT id, title, funder, funder_type, url, closing_date, amount, jurisdiction,
            total_score, band, status, routing_reason
       FROM ${SCHEMA}.funding_calls WHERE ${clauses.join(' AND ')}
      ORDER BY total_score DESC NULLS LAST, closing_date ASC NULLS LAST LIMIT ${limit}`, params);
  const { rows: [k] } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE band='green')::int AS strong_fit,
            COUNT(*) FILTER (WHERE band='amber')::int AS worth_a_look,
            COUNT(*) FILTER (WHERE closing_date > NOW())::int AS still_open
       FROM ${SCHEMA}.funding_calls WHERE newsroom_id = $1`, [newsroomId]);
  return {
    counts_summary: `${k.total} funding calls on file — ${k.strong_fit} a strong fit, ${k.worth_a_look} worth a look, ${k.still_open} still open. Showing ${rows.length}.`,
    counters: k,
    presentation_hint: 'Quote counts_summary as-is if you state numbers. Give the top few calls a real paragraph each — funder, what they fund, why it fits this organisation, the deadline, and the catch. Then the rest briefly. Flag unconfirmed eligibility for a non-US applicant plainly.',
    calls: rows,
  };
}

async function toolGetCall(newsroomId, args) {
  const pool = requirePool();
  let row;
  if (args.call_id) {
    ({ rows: [row] } = await pool.query(
      `SELECT * FROM ${SCHEMA}.funding_calls WHERE id = $1 AND newsroom_id = $2`, [args.call_id, newsroomId]));
  } else if (args.title) {
    ({ rows: [row] } = await pool.query(
      `SELECT * FROM ${SCHEMA}.funding_calls WHERE newsroom_id = $1 AND LOWER(title) LIKE $2
        ORDER BY total_score DESC NULLS LAST LIMIT 1`, [newsroomId, `%${String(args.title).toLowerCase()}%`]));
  }
  if (!row) throw { code: -32602, message: 'Funding call not found — search_funding first.' };
  const { rows: flags } = await pool.query(
    `SELECT flag_type, severity, evidence_note FROM ${SCHEMA}.funding_call_flags
      WHERE funding_call_id = $1 ORDER BY severity DESC LIMIT 20`, [row.id]);
  return { ...row, evidence: flags,
    presentation_hint: 'Present as a briefing a fundraiser can act on: the funder and what they fund, why it fits (use the component scores and evidence), the deadline and how much runway that leaves, the amount, and what would make this application hard or ineligible.' };
}

async function toolLogOutcome(newsroomId, args) {
  if (!OUTCOMES.includes(args.outcome)) throw { code: -32602, message: `outcome must be one of: ${OUTCOMES.join(', ')}` };
  const pool = requirePool();
  const { rows: [c] } = await pool.query(
    `SELECT id, title FROM ${SCHEMA}.funding_calls WHERE id = $1 AND newsroom_id = $2`, [args.call_id, newsroomId]);
  if (!c) throw { code: -32602, message: 'Funding call not found.' };
  const status = args.outcome === 'applied' ? 'pursuing' : args.outcome === 'dismissed' ? 'rejected' : 'resolved';
  await pool.query(
    `UPDATE ${SCHEMA}.funding_calls
        SET status = $3, outcome = $4, outcome_note = $5, outcome_amount = $6, updated_at = NOW()
      WHERE id = $1 AND newsroom_id = $2`,
    [c.id, newsroomId, status, args.outcome, args.reason || null, args.amount || null])
    .catch(async () => {
      // Older schema without the outcome columns — record the status at least.
      await pool.query(`UPDATE ${SCHEMA}.funding_calls SET status = $3, updated_at = NOW() WHERE id = $1 AND newsroom_id = $2`,
        [c.id, newsroomId, status]);
    });
  return { ok: true, call: c.title, outcome: args.outcome,
    note: 'Recorded. Outcomes are what teach the scoring — the more you log, including the ones you dropped and why, the better the shortlist gets.' };
}

async function toolGetProfile(newsroomId, args, host) {
  const criteria = await getCriteria(host);
  const filled = Object.entries(criteria).filter(([k, v]) =>
    k !== 'updated_at' && (Array.isArray(v) ? v.length : String(v || '').trim())).map(([k]) => k);
  return { profile: criteria, filled_fields: filled,
    note: filled.length ? undefined : 'The profile is empty — scoring cannot judge fit properly until it is filled in. Ask the user about their themes, the countries they work in, and the kinds of funder they want, then call update_org_profile.' };
}

async function toolUpdateProfile(newsroomId, args, host) {
  const allowed = ['identity', 'strategy', 'themes', 'geographies', 'donor_types', 'keywords', 'eligibility', 'exclusions'];
  const patch = {};
  for (const k of allowed) if (args[k] !== undefined) patch[k] = args[k];
  if (!Object.keys(patch).length) throw { code: -32602, message: `Give at least one of: ${allowed.join(', ')}` };
  const saved = await saveCriteria(host, patch);
  return { ok: true, updated: Object.keys(patch), profile: saved,
    note: 'Saved. Future scans and scoring use this immediately.' };
}

async function toolScan(newsroomId, args, host) {
  const criteria = await getCriteria(host);
  const keywords = [...(criteria.themes || []), ...(criteria.keywords || [])].filter(Boolean);
  const context = await orgContext(host);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 25);

  const r = await fetchGrantsGov({ keywords, limit });
  if (!r.items.length) return { found: 0, note: r.note, error: r.error };

  const pool = requirePool();
  const { rows: [src] } = await pool.query(
    `SELECT id FROM ${SCHEMA}.sources WHERE newsroom_id = $1 AND name = 'grants.gov' LIMIT 1`, [newsroomId]);
  const sourceId = src?.id || (await pool.query(
    `INSERT INTO ${SCHEMA}.sources (newsroom_id, name, kind, origin) VALUES ($1,'grants.gov','api','seed') RETURNING id`,
    [newsroomId])).rows[0].id;

  const pipeline = pipelineFor(context);
  const out = await pipeline.runPipeline({ newsroomId, sourceId, items: r.items });
  return {
    searched_with: keywords.length ? keywords : '(profile has no themes — used general development terms; fill the profile for better results)',
    source_note: r.note,
    result: out.digest || out,
    note: 'New calls are scored against your profile. Ask for the shortlist with search_funding.',
  };
}

const dispatch = {
  search_funding:       toolSearchFunding,
  get_funding_call:     toolGetCall,
  log_funding_outcome:  toolLogOutcome,
  get_org_profile:      toolGetProfile,
  update_org_profile:   toolUpdateProfile,
  scan_funding_sources: toolScan,
};

// ── the endpoint ─────────────────────────────────────────────────────────────
const SERVER_INFO = { name: 'Resources', version: '0.2.0' };

function keyLookup(hashSql) {
  return async (token) => {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows: [k] } = await requirePool().query(
      `SELECT id, newsroom_id FROM ${SCHEMA}.mcp_keys WHERE key_hash = $1 AND is_active = true`, [hash]);
    if (k) requirePool().query(`UPDATE ${SCHEMA}.mcp_keys SET last_used_at = NOW() WHERE id = $1`, [k.id]).catch(() => {});
    return k || null;
  };
}
const findKey = keyLookup();

export function mountMcp(app, hostFor) {
  const router = Router();

  const authHeader = async (req, res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'Authorization: Bearer <key> required. Keys are minted in the app.' });
    const k = await findKey(token);
    if (!k) return res.status(403).json({ error: 'Invalid or revoked key.' });
    req.mcpKey = k; next();
  };
  const authParam = async (req, res, next) => {
    const k = await findKey(String(req.params.key || ''));
    if (!k) return res.status(403).json({ error: 'Invalid or revoked key.' });
    req.mcpKey = k; next();
  };

  const sse = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'server/info', params: {
      ...SERVER_INFO,
      description: 'Resources — funding calls found and scored against your organisation\'s profile, with the outcome loop that teaches it. Tools: ' + TOOLS.map((t) => t.name).join(', '),
      capabilities: { tools: {} } } })}\n\n`);
    const hb = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => clearInterval(hb));
  };

  const rpc = async (req, res) => {
    const { jsonrpc, id, method, params } = req.body || {};
    if (jsonrpc !== '2.0') return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    if (method === 'initialize') {
      return res.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    }
    if (method === 'tools/list') return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });
    if (typeof method === 'string' && method.startsWith('notifications/')) return res.status(204).send();
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      const newsroomId = req.mcpKey.newsroom_id;
      let ok = true;
      try {
        const fn = dispatch[name];
        if (!fn) throw { code: -32601, message: `Unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(', ')}` };
        // A host scoped to the key's tenant, for host.store-backed profile reads.
        const host = hostFor ? hostFor({ ...req, user: { id: newsroomId, newsroom_id: newsroomId } }) : null;
        const result = await fn(newsroomId, args, host);
        return res.json({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }], isError: false } });
      } catch (err) {
        ok = false;
        const isRpc = err.code !== undefined;
        return res.json({ jsonrpc: '2.0', id, error: isRpc ? { code: err.code, message: err.message } : { code: -32603, message: err.message || 'Internal error' } });
      } finally {
        requirePool().query(
          `INSERT INTO ${SCHEMA}.mcp_usage (newsroom_id, key_id, tool, args, ok) VALUES ($1,$2,$3,$4::jsonb,$5)`,
          [newsroomId, req.mcpKey.id, String(name || 'unknown').slice(0, 60), JSON.stringify(args || {}), ok]).catch(() => {});
      }
    }
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  };

  router.get('/', authHeader, sse);
  router.post('/', authHeader, rpc);
  router.get('/k/:key', authParam, sse);
  router.post('/k/:key', authParam, rpc);
  // Nothing under /mcp may fall through to the SPA or a login redirect: a
  // 200-HTML answer to an OAuth-discovery probe makes connector UIs believe a
  // sign-in service exists and abort registration.
  router.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // A malformed percent-encoding in the key path throws a URIError inside
  // Express's param decoder before any handler runs (e.g. someone pasting a
  // masked example URL). Answer it cleanly rather than with a 500 stack.
  router.use((err, req, res, next) => {
    if (err instanceof URIError) {
      return res.status(403).json({ error: 'Invalid key in the URL — paste the full connector link, not the shortened example.' });
    }
    return next(err);
  });

  app.use('/mcp', router);
}

export default mountMcp;
