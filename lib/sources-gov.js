// Resources — a REAL funding source: the US federal grants API (grants.gov).
//
// The first live feed behind this Node. Chosen because it is genuinely free
// (no key, no quota), stable, and returns structured records with eligibility
// and deadlines — so the pipeline can be proven end-to-end without asking the
// client to pay for a database subscription.
//
// HONEST ABOUT RELEVANCE: this is a US federal catalogue. A Southern African
// NGO is eligible for a minority of it — chiefly global-health, development and
// democracy programmes that accept foreign entities. So we FILTER on the
// applicant types the API states, keeping only opportunities that are
// unrestricted or explicitly open to non-US / non-profit applicants, and we
// record the eligibility verbatim so a human can check it. Everything else is
// dropped rather than dressed up as a lead. Other feeds (EU Funding & Tenders,
// UN, national lotteries) belong here as sibling adapters — the EU portal's
// search API needs a different request contract and is not wired yet.
//
// The SEARCH TERMS come from the tenant's own profile (themes/keywords in the
// criteria card), so what it looks for is config, never hardcoded.

const SEARCH_URL = 'https://api.grants.gov/v1/api/search2';
const DETAIL_URL = 'https://api.grants.gov/v1/api/fetchOpportunity';
const VIEW_URL = (id) => `https://www.grants.gov/search-results-detail/${id}`;
const TIMEOUT_MS = 30000;
const DELAY_MS = 400;            // politeness between detail calls

// Applicant-type text that means a foreign non-profit could apply. The API
// states these verbatim; anything else (state governments, US-only districts,
// individuals) is not a fit for an African NGO and is dropped.
const ELIGIBLE_HINTS = [
  'unrestricted', 'nonprofits', 'non-profits', 'others', 'foreign',
  'small businesses', 'private institutions of higher education',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripHtml = (s) => String(s || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

async function postJson(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally { clearTimeout(timer); }
}

function eligibleFor(applicantTypes) {
  const text = (applicantTypes || []).map((a) => String(a?.description || '').toLowerCase()).join(' | ');
  if (!text) return { ok: false, why: 'no eligibility stated' };
  const ok = ELIGIBLE_HINTS.some((h) => text.includes(h));
  return { ok, why: text.slice(0, 300) };
}

/**
 * Fetch open funding calls matching the tenant's themes.
 * Returns { items, note, error? } — items in the engine's ingest shape
 * ({ text, externalId, url, hints }), so the caller just hands them to
 * pipeline.runPipeline. Honest counts in `note`; never invents a record.
 *
 * @param {object} opts
 * @param {string[]} opts.keywords  search terms (from the tenant's profile)
 * @param {number}   opts.limit     max opportunities returned (cost control)
 */
export async function fetchGrantsGov({ keywords = [], limit = 15 } = {}) {
  const terms = (keywords.length ? keywords : ['global health', 'human rights', 'community development'])
    .map((k) => String(k).trim()).filter(Boolean).slice(0, 6);

  const seen = new Set();
  const items = [];
  let scanned = 0, droppedIneligible = 0, droppedClosed = 0;

  for (const term of terms) {
    if (items.length >= limit) break;
    let hits;
    try {
      const res = await postJson(SEARCH_URL, { rows: 25, keyword: term, oppStatuses: 'posted' });
      hits = (res?.data?.oppHits) || [];
    } catch (e) {
      return { items, note: `grants.gov: search for "${term}" failed — ${e.message}. Kept ${items.length}.`, error: e.message };
    }
    scanned += hits.length;

    for (const h of hits) {
      if (items.length >= limit) break;
      const id = String(h.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);

      let detail;
      try {
        await sleep(DELAY_MS);
        const res = await postJson(DETAIL_URL, { opportunityId: Number(id) });
        detail = res?.data || null;
      } catch { continue; }          // one bad record must not kill the run
      const syn = detail?.synopsis || {};

      const elig = eligibleFor(syn.applicantTypes);
      if (!elig.ok) { droppedIneligible++; continue; }

      const closing = syn.responseDate || h.closeDate || null;
      const closingDate = closing ? new Date(closing) : null;
      if (closingDate && !Number.isNaN(closingDate.valueOf()) && closingDate < new Date()) {
        droppedClosed++; continue;
      }

      const title = detail?.opportunityTitle || h.title || 'Untitled opportunity';
      const funder = syn.agencyName && !/^\s*$/.test(syn.agencyName)
        ? (detail?.topAgencyDetails?.agencyName || h.agency || syn.agencyName)
        : (h.agency || 'US federal agency');
      const amount = syn.awardCeiling && String(syn.awardCeiling) !== 'none' ? String(syn.awardCeiling) : null;

      items.push({
        text: [
          `Title: ${title}`,
          `Funder: ${funder}`,
          h.number ? `Opportunity number: ${h.number}` : null,
          closing ? `Closing date: ${closing}` : null,
          amount ? `Award ceiling: USD ${amount}` : null,
          syn.awardFloor && String(syn.awardFloor) !== 'none' ? `Award floor: USD ${syn.awardFloor}` : null,
          syn.numberOfAwards ? `Number of awards: ${syn.numberOfAwards}` : null,
          `Who may apply: ${elig.why}`,
          syn.applicantEligibilityDesc ? `Eligibility notes: ${stripHtml(syn.applicantEligibilityDesc).slice(0, 800)}` : null,
          `Source: grants.gov (US federal) — a foreign applicant must confirm eligibility on the notice itself.`,
          '',
          stripHtml(syn.synopsisDesc).slice(0, 6000),
        ].filter(Boolean).join('\n'),
        externalId: `grantsgov:${id}`,
        url: VIEW_URL(id),
        hints: {
          title,
          funder,
          funder_type: 'institutional (government)',
          url: VIEW_URL(id),
          closing_date: closing || null,
          amount: amount ? `USD ${amount}` : null,
          jurisdiction: 'US federal (international eligibility varies by notice)',
          language: 'en',
        },
      });
    }
  }

  return {
    items,
    note: `grants.gov: searched ${terms.length} theme(s) [${terms.join(', ')}], scanned ${scanned} listing(s), kept ${items.length}`
      + `${droppedIneligible ? `, dropped ${droppedIneligible} not open to this kind of applicant` : ''}`
      + `${droppedClosed ? `, dropped ${droppedClosed} already closed` : ''}.`,
  };
}

export default fetchGrantsGov;
