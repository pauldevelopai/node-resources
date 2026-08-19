// Resources — the pg pool. Lazy, so the Node still boots (and the browser key
// flow, docs, chat all work) when DATABASE_URL isn't set; only the pipeline
// features (scan/assess/opportunities) need Postgres. requirePool() gives
// routes a clear, honest error instead of a crash.

import pg from 'pg';

let pool = null;

export function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export function requirePool() {
  const p = getPool();
  if (!p) {
    const err = new Error('This feature needs a database. Set DATABASE_URL in .env (hosted installs get it automatically).');
    err.status = 503;
    throw err;
  }
  return p;
}
