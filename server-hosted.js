/**
 * server-hosted.js — the ONLINE (multi-tenant) entry. The runtime's
 * createHostedServer provides tracker-cookie auth, a per-request newsroom-scoped
 * host (host.store backed by Postgres), the standard /api route map, and the
 * GROUNDED chrome + "run locally" footer. We add our custom routes via the
 * mountRoutes hook (per-request host). index.js is the LOCAL mirror.
 *
 * Env (box .env, never committed): JWT_SECRET (matches the tracker's),
 * ANTHROPIC_API_KEY (shared), DATABASE_URL or PG*. Optional: PORT, MODEL.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });
// Tell the handlers the AI key is server-managed (skip the local .env setup flow).
process.env.GROUNDED_HOSTED = '1';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import cron from 'node-cron';
import { createHostedServer } from '@developai/grounded-node-runtime';
import * as handlers from './lib/handlers.js';
import { mountAppRoutes } from './lib/routes.js';
import { ensureSchema } from './lib/schema.js';
import { mountMcp, mountMcpKeyRoutes, ensureMcpSchema } from './lib/mcp.js';
import { sweepAllTenants } from './lib/nightly.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

await createHostedServer({
  slug: 'resources',
  productName: 'Resources',
  handlers,
  ensureSchema: async (pool) => {
    await ensureSchema(pool);      // engine-standard tables in the `resources` schema
    await ensureMcpSchema(pool);   // connector keys + usage log
  },

  mountRoutes: (app, { hostFor }) => {
    // MUST-HAVE: keep the chrome-injected app shell uncached, or browsers
    // heuristically cache index.html and your UI updates won't show until a
    // hard refresh. Runs before the static/catch-all handlers; /api is untouched.
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) res.set('Cache-Control', 'no-cache');
      next();
    });
    // Your custom routes (per-request, newsroom-scoped host via hostFor).
    mountAppRoutes(app, hostFor);
    // Connector key management (inside the cookie-authed /api surface)…
    mountMcpKeyRoutes(app, hostFor);
    // …and the MCP front door, which authenticates with its own bearer key
    // (claude.ai / ChatGPT carry no tracker cookie), so it mounts outside /api.
    mountMcp(app, hostFor);
  },
  nodeVersion: pkg.version,
  staticDir: join(__dirname, 'public'),
});

// Nightly (03:30) funding sweep — the job that makes the morning shortlist
// exist instead of only appearing when someone asks. Half an hour after
// LeadFinder's 03:00 so the two Nodes don't hit the shared database and the
// model API at the same moment. A tenant with no themes in its profile is
// skipped and says so (a themeless search returns noise, not leads).
cron.schedule('30 3 * * *', async () => {
  try {
    const r = await sweepAllTenants();
    console.log(`[resources nightly] done — tenants=${r.tenants} found=${r.found} kept=${r.kept} errors=${r.errors}`);
  } catch (e) { console.error('[resources nightly]', e.message); }
});
