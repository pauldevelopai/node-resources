// Resources — the Node's LLM caller, LeadFinder's pattern: Anthropic, env key
// (hosted → the shared server key; local → the user's own key saved through
// the in-app "API key" screen, which updates process.env live). Built lazily so
// a missing key at boot doesn't crash the Node. One retry on 429.
//
// This same function is what we inject into the engine's checkpoint factories —
// the engine never owns a key or a client.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = () => process.env.MODEL || 'claude-sonnet-4-6';

let client = null;
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured. Add your AI key in the app.');
  if (!client || client.__key !== apiKey) {
    client = new Anthropic({ apiKey });
    client.__key = apiKey;
  }
  return client;
}

export async function callClaude({ system, userContent, maxTokens = 2000, temperature = undefined, webSearch = false }) {
  const params = {
    model: MODEL(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  };
  if (temperature !== undefined) params.temperature = temperature;
  if (webSearch) {
    const maxUses = (typeof webSearch === 'object' && webSearch.maxUses) || 5;
    params.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }];
  }
  const c = getClient();
  try {
    const message = await c.messages.create(params);
    return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  } catch (err) {
    if (err.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      const message = await c.messages.create(params);
      return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    }
    throw err;
  }
}
