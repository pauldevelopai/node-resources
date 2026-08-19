// Builds the organisation grounding block that every AI call in this Node is
// prefixed with: the shared cross-node profile (host.profile — who the org is,
// where, for whom) + this Node's own search criteria (the adjustable "backend")
// + any internal documents the org has added (past proposals, strategy notes).
//
// Everything goes through the host interface so the same code runs locally and
// hosted. Empty sections are omitted honestly — never padded with invented facts.

const CRITERIA_KEY = 'main';

export const emptyCriteria = () => ({
  identity: '',        // who the org is, in their own words (supplements the profile)
  strategy: '',        // current resource-mobilisation strategy / direction of travel
  themes: [],          // cross-cutting themes, e.g. climate, women, youth, digital health
  geographies: [],     // countries / regions of work
  donor_types: [],     // institutional, corporate, philanthropic, embassy, multilateral…
  keywords: [],        // extra search terms
  eligibility: '',     // what the org is (and isn't) eligible for
  exclusions: '',      // funders / conditions the org won't take
  updated_at: null,
});

export async function getCriteria(host) {
  const saved = await host.store.get('criteria', CRITERIA_KEY);
  return { ...emptyCriteria(), ...(saved || {}) };
}

export async function saveCriteria(host, patch) {
  const merged = { ...(await getCriteria(host)), ...patch, updated_at: new Date().toISOString() };
  await host.store.put('criteria', CRITERIA_KEY, merged);
  return merged;
}

export async function listDocs(host) {
  const docs = (await host.store.list('docs')).map((d) => ({ key: d.key, ...d.value }));
  return docs.sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)));
}

/**
 * The grounding block. `withDocs` pulls internal documents in (proposal drafting
 * needs them; a scan prompt usually doesn't need full text, just the criteria).
 */
export async function orgContext(host, { withDocs = false, docLimit = 6 } = {}) {
  const parts = [];

  const p = host.profile ? await host.profile.get().catch(() => null) : null;
  if (p && Object.keys(p).length) {
    const line = (label, v) => (v ? `${label}: ${v}` : null);
    const profileLines = [
      line('Organisation', p.name),
      line('Country/location', p.country || p.location),
      line('Audience/communities served', p.audience),
      line('About', p.about),
      line('Focus areas', Array.isArray(p.beats) ? p.beats.join(', ') : p.beats),
    ].filter(Boolean);
    if (profileLines.length) parts.push('ORGANISATION PROFILE (shared, maintained by the org):\n' + profileLines.join('\n'));
  }

  const c = await getCriteria(host);
  const list = (v) => (Array.isArray(v) && v.length ? v.join(', ') : null);
  const critLines = [
    c.identity && `Who we are: ${c.identity}`,
    c.strategy && `Resource-mobilisation strategy: ${c.strategy}`,
    list(c.themes) && `Cross-cutting themes we are moving into: ${list(c.themes)}`,
    list(c.geographies) && `Where we work: ${list(c.geographies)}`,
    list(c.donor_types) && `Funder types we pursue: ${list(c.donor_types)}`,
    list(c.keywords) && `Extra search terms: ${list(c.keywords)}`,
    c.eligibility && `Eligibility notes: ${c.eligibility}`,
    c.exclusions && `We will NOT pursue: ${c.exclusions}`,
  ].filter(Boolean);
  if (critLines.length) parts.push('SEARCH CRITERIA (set by the org, editable any time):\n' + critLines.join('\n'));

  if (withDocs) {
    const docs = (await listDocs(host)).slice(0, docLimit);
    if (docs.length) {
      parts.push(
        'INTERNAL DOCUMENTS (the org’s own material — past proposals, strategy, track record):\n' +
        docs.map((d) => `--- ${d.title} (${d.kind || 'document'}) ---\n${String(d.text).slice(0, 8000)}`).join('\n\n')
      );
    }
  }

  return parts.join('\n\n') || 'No organisation profile or criteria set yet.';
}

/** Stable id for an opportunity so re-scans update rather than duplicate. */
export function opportunityId(title, funder) {
  return `${String(funder || '')}::${String(title || '')}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || `opp-${Date.now()}`;
}

/** Pull the first JSON array/object out of an AI reply (tolerates prose around it). */
export function extractJson(text) {
  const s = String(text || '');
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  for (let end = s.length; end > start; end--) {
    const cut = s.slice(start, end).trim();
    if (!cut) continue;
    try { return JSON.parse(cut); } catch { /* keep shrinking */ }
  }
  return null;
}
