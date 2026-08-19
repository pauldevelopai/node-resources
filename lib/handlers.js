// Standard /api/* handlers, auto-mounted by the runtime (createServer locally,
// createHostedServer online). Each takes the host facade + a request-like object
// and returns a plain object (the JSON response). Written against the host
// interface only — the same module runs on a laptop and hosted.
//
// Resources keeps just the generic essentials here:
//   getSetupStatus / postSetup → the local API-key flow (server-managed when hosted)
//   getActivity                → the activity log
// Your Node's real actions live as custom routes in lib/routes.js (or add more
// standard handlers — see the runtime's route map: getReport, getQuality,
// postBrief, postIngest, listSources).

import fs from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ACTIVITY_LOG = './data/processed/node_resources_activity.json';
const ENV_PATH = '.env';
const HOSTED = () => !!process.env.GROUNDED_HOSTED;

// ─── Local API-key setup (laptop only) ───────────────────────────────
function readEnvFile() {
  if (!existsSync(ENV_PATH)) return {};
  const env = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
function writeEnvFile(updates) {
  const merged = { ...readEnvFile(), ...updates };
  const order = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'MODEL', 'OPENAI_BASE_URL', 'NEWSROOM', 'PORT'];
  const lines = [
    '# Saved by the in-app setup screen. Update through the app, not by editing this.',
    '# Keep this file private — it contains your API key. (Already in .gitignore.)',
    '',
  ];
  for (const k of order) if (merged[k] !== undefined && merged[k] !== '') lines.push(`${k}=${merged[k]}`);
  for (const k of Object.keys(merged)) if (!order.includes(k) && merged[k]) lines.push(`${k}=${merged[k]}`);
  writeFileSync(ENV_PATH, lines.join('\n') + '\n');
  for (const [k, v] of Object.entries(updates)) { if (v) process.env[k] = v; else delete process.env[k]; }
}

/** GET /api/setup — has an API key been configured? (Hosted: the server manages it.) */
export async function getSetupStatus() {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const explicit = (process.env.AI_PROVIDER || '').toLowerCase();
  let activeProvider = null;
  if (explicit === 'anthropic' || explicit === 'openai') activeProvider = explicit;
  else if (hasAnthropic) activeProvider = 'anthropic';
  else if (hasOpenAI) activeProvider = 'openai';
  return {
    configured: HOSTED() ? true : !!activeProvider,
    serverManaged: HOSTED(),
    activeProvider: activeProvider || (HOSTED() ? 'anthropic' : null),
    hasAnthropicKey: hasAnthropic,
    hasOpenAIKey: hasOpenAI,
  };
}

// Live key check — a zero-cost GET to the provider's models endpoint. 200 = the
// key works; 401/403 = rejected; anything else / network error = couldn't verify
// (we still save, so an offline newsroom isn't blocked). Caching-immune: it does
// NOT go through host.ai (whose client is built once and cached).
async function validateKey(provider, key) {
  try {
    const res = provider === 'anthropic'
      ? await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } })
      : await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, rejected: true };
    return { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, network: true, error: e.message };
  }
}

/** POST /api/setup — validate + save provider + key to .env (laptop only). */
export async function postSetup(host, body) {
  if (HOSTED()) {
    return { ok: false, serverManaged: true, message: 'When run online the AI key is managed by Grounded — nothing to set here.' };
  }
  const { provider, apiKey } = body || {};
  if (provider === null && apiKey === null) {
    writeEnvFile({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', AI_PROVIDER: '' });
    return { ok: true, reset: true };
  }
  if (!['anthropic', 'openai'].includes(provider)) return { ok: false, message: 'Pick Anthropic or OpenAI.' };
  const key = (apiKey || '').trim();
  if (key.length < 10) return { ok: false, message: 'Paste your API key into the key box.' };
  if (provider === 'anthropic' && !/^sk-ant-/.test(key)) return { ok: false, message: 'That doesn’t look like an Anthropic key — it should start with "sk-ant-".' };
  if (provider === 'openai' && !/^sk-/.test(key)) return { ok: false, message: 'That doesn’t look like an OpenAI key — it should start with "sk-".' };

  const v = await validateKey(provider, key);
  if (v.rejected) {
    return { ok: false, message: `That key was rejected by ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}. Check you copied the whole key.` };
  }

  const updates = { AI_PROVIDER: provider };
  if (provider === 'anthropic') updates.ANTHROPIC_API_KEY = key; else updates.OPENAI_API_KEY = key;
  writeEnvFile(updates);
  await host.log.run({ op: 'setup', provider, verified: !!v.ok });
  return {
    ok: true,
    provider,
    verified: !!v.ok,
    warning: v.network ? 'Saved — but we couldn’t reach the provider to confirm it (no internet?). It’ll be used when you run something.' : null,
  };
}

/** GET /api/activity — local only; hosted activity lives in Postgres → []. */
export async function getActivity() {
  try { return JSON.parse(await fs.readFile(ACTIVITY_LOG, 'utf8')); } catch { return []; }
}
