// Resources — LOCAL entry point.
//
// Runs on the organisation's own machine: their data + AI key stay local. The
// SAME handlers run hosted (server-hosted.js) — write logic once, against the
// host interface only.

import 'dotenv/config';
import { createLiteHost, createServer } from '@developai/grounded-node-runtime';
import * as handlers from './lib/handlers.js';
import { mountAppRoutes } from './lib/routes.js';
import { getPool } from './lib/pool.js';
import { ensureSchema } from './lib/schema.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

const SLUG = 'resources';
const DISPLAY_NAME = 'Resources';

async function main() {
  // Pipeline features (scan/assess/opportunities) need Postgres; the rest of
  // the app runs without it. Honest 503s guide the user when it's absent.
  const pool = getPool();
  if (pool) await ensureSchema(pool);
  else console.log('[resources] DATABASE_URL not set — running without the opportunity pipeline (docs/chat/key setup still work).');

  const host = createLiteHost({
    appSlug: SLUG,
    nodeVersion: pkg.version,
    newsroom: process.env.NEWSROOM, // unset → saved meta, then none
  });

  const app = createServer({
    slug: SLUG,
    host,
    handlers,
    displayName: DISPLAY_NAME,
    nodeVersion: pkg.version,
  });

  // Custom routes (same per-request host signature as hosted; here it's the one
  // fixed lite host).
  mountAppRoutes(app, () => host);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
