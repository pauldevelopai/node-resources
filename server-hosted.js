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
import { createHostedServer } from '@developai/grounded-node-runtime';
import * as handlers from './lib/handlers.js';
import { mountAppRoutes } from './lib/routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

await createHostedServer({
  slug: 'resources',
  productName: 'Resources',
  handlers,
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
  },
  nodeVersion: pkg.version,
  staticDir: join(__dirname, 'public'),
});
