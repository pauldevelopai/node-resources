// Resources — dashboard JS. Plain vanilla, relative API paths.
//
// The API-KEY UX lives in mountKeyUI() below — the standard component from the
// template, unchanged: a first-run gate (no key → blocking setup) and an
// always-available Settings modal. Nobody edits .env by hand.

(function () {
  const $ = (sel) => document.querySelector(sel);

  let currentId = null; // the opportunity open in the detail view

  async function boot() {
    $('#app').style.display = 'block';
    wireApp();
    loadOverview();
    mountKeyUI({ onConfigured: () => {} });
  }

  function wireApp() {
    $('#scan-btn').addEventListener('click', runScan);
    $('#assess-btn').addEventListener('click', assessPasted);
    $('#criteria-btn').addEventListener('click', saveCriteria);
    $('#doc-btn').addEventListener('click', addDoc);
    $('#back-btn').addEventListener('click', showList);
    $('#chat-btn').addEventListener('click', sendChat);
    $('#proposal-btn').addEventListener('click', draftProposal);
    $('#copy-btn').addEventListener('click', copyDraft);
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendChat();
    });
  }

  // ─── Boot data ─────────────────────────────────────────────────────
  async function loadOverview() {
    const r = await fetchJson('api/overview').catch(() => null);
    if (!r || !r.ok) { $('#opps').innerHTML = '<span class="empty">Could not load. Refresh the page.</span>'; return; }
    renderOpportunities(r.opportunities || []);
    renderDocs(r.docs || []);
    fillCriteria(r.criteria || {});
  }

  // ─── Scan ──────────────────────────────────────────────────────────
  async function runScan() {
    const btn = $('#scan-btn'), status = $('#scan-status');
    btn.disabled = true;
    status.textContent = 'Searching the live web — this takes a minute or two…';
    try {
      const r = await postJson('api/scan', {});
      if (!r.ok) { status.textContent = r.message || 'Scan failed. Try again.'; return; }
      status.textContent = r.added || r.refreshed
        ? `Done: ${r.added} new, ${r.refreshed} refreshed.`
        : 'Done — nothing new found this time. Try widening the criteria.';
      renderOpportunities(r.opportunities || []);
    } catch (e) { status.textContent = 'Network error: ' + e.message; }
    finally { btn.disabled = false; }
  }

  // ─── Assess a pasted opportunity ───────────────────────────────────
  async function assessPasted() {
    const btn = $('#assess-btn'), status = $('#assess-status'), ta = $('#assess-text');
    const text = ta.value.trim();
    if (!text) { status.textContent = 'Paste the opportunity first.'; return; }
    btn.disabled = true; status.textContent = 'Assessing the fit…';
    try {
      const r = await postJson('api/opportunities/assess', { text });
      if (!r.ok) { status.textContent = r.message || 'Could not assess it.'; return; }
      ta.value = ''; status.textContent = 'Added below.';
      await refreshOpportunities();
    } catch (e) { status.textContent = 'Network error: ' + e.message; }
    finally { btn.disabled = false; }
  }

  async function refreshOpportunities() {
    const r = await fetchJson('api/opportunities').catch(() => null);
    if (r && r.ok) renderOpportunities(r.opportunities || []);
  }

  // ─── Opportunity list ──────────────────────────────────────────────
  const STATUSES = ['new', 'reviewing', 'pursuing', 'dismissed'];

  function renderOpportunities(opps) {
    const box = $('#opps');
    if (!opps.length) {
      box.innerHTML = '<span class="empty">Nothing yet. Set your search criteria below, then run a scan — or paste one you found yourself.</span>';
      return;
    }
    const order = { pursuing: 0, reviewing: 1, new: 2, dismissed: 3 };
    opps = [...opps].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
    box.innerHTML = opps.map((o) => `
      <div class="opp" data-id="${escapeHtml(o.id)}">
        <h3>${o.url ? `<a href="${escapeHtml(o.url)}" target="_blank" rel="noopener">${escapeHtml(o.title)}</a>` : escapeHtml(o.title)}</h3>
        <div class="meta">
          <span class="badge ${escapeHtml(o.status)}">${escapeHtml(o.status)}</span>
          ${escapeHtml(o.funder)} · ${escapeHtml(o.funder_type)} · deadline ${escapeHtml(o.deadline)} · ${escapeHtml(o.amount)}
          ${o.source === 'manual' ? ' · added by you' : ''}
        </div>
        <div>${(o.themes || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        <div class="why">${escapeHtml(o.why_relevant)}</div>
        <div class="row">
          <button class="primary" data-act="open">Discuss &amp; draft</button>
          <select data-act="status">
            ${STATUSES.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <button class="ghost" data-act="remove">Remove</button>
        </div>
      </div>`).join('');

    box.querySelectorAll('.opp').forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('[data-act=open]').addEventListener('click', () => openDetail(id));
      el.querySelector('[data-act=status]').addEventListener('change', async (e) => {
        await postJson('api/opportunities/status', { id, status: e.target.value });
        refreshOpportunities();
      });
      el.querySelector('[data-act=remove]').addEventListener('click', async () => {
        if (!confirm('Remove this opportunity, its discussion and its draft?')) return;
        await postJson('api/opportunities/delete', { id });
        refreshOpportunities();
      });
    });
  }

  // ─── Criteria ──────────────────────────────────────────────────────
  const CRIT_FIELDS = ['identity', 'strategy', 'themes', 'geographies', 'donor_types', 'keywords', 'eligibility', 'exclusions'];

  function fillCriteria(c) {
    for (const f of CRIT_FIELDS) {
      const el = $('#c-' + f);
      if (el) el.value = Array.isArray(c[f]) ? c[f].join(', ') : (c[f] || '');
    }
    const isEmpty = CRIT_FIELDS.every((f) => !c[f] || (Array.isArray(c[f]) && !c[f].length));
    if (isEmpty) $('#criteria-details').open = true;
  }

  async function saveCriteria() {
    const btn = $('#criteria-btn'), status = $('#criteria-status');
    const body = {};
    for (const f of CRIT_FIELDS) body[f] = $('#c-' + f).value;
    btn.disabled = true; status.textContent = 'Saving…';
    try {
      const r = await postJson('api/criteria', body);
      status.textContent = r.ok ? 'Saved. The next scan uses this.' : (r.message || 'Could not save.');
    } catch (e) { status.textContent = 'Network error: ' + e.message; }
    finally { btn.disabled = false; }
  }

  // ─── Documents ─────────────────────────────────────────────────────
  function renderDocs(docs) {
    const box = $('#docs');
    box.innerHTML = docs.length
      ? docs.map((d) => `
          <div class="doc" data-key="${escapeHtml(d.key)}">
            <span>${escapeHtml(d.title)} <span class="kind">· ${escapeHtml(d.kind || 'document')} · ${Math.round((d.chars || 0) / 1000)}k chars</span></span>
            <button class="ghost" data-act="del">Remove</button>
          </div>`).join('')
      : '<span class="empty">No documents yet. The more real material you add, the stronger the drafts.</span>';
    box.querySelectorAll('[data-act=del]').forEach((b) => b.addEventListener('click', async () => {
      await postJson('api/docs/delete', { key: b.closest('.doc').dataset.key });
      const r = await fetchJson('api/docs').catch(() => null);
      if (r && r.ok) renderDocs(r.docs || []);
    }));
  }

  async function addDoc() {
    const btn = $('#doc-btn'), status = $('#doc-status');
    btn.disabled = true; status.textContent = 'Adding…';
    try {
      const r = await postJson('api/docs', { title: $('#doc-title').value, kind: $('#doc-kind').value, text: $('#doc-text').value });
      if (!r.ok) { status.textContent = r.message || 'Could not add it.'; return; }
      $('#doc-title').value = ''; $('#doc-text').value = ''; status.textContent = 'Added.';
      const list = await fetchJson('api/docs').catch(() => null);
      if (list && list.ok) renderDocs(list.docs || []);
    } catch (e) { status.textContent = 'Network error: ' + e.message; }
    finally { btn.disabled = false; }
  }

  // ─── Detail view: discuss + draft ──────────────────────────────────
  async function openDetail(id) {
    currentId = id;
    const r = await postJson('api/opportunity', { id }).catch(() => null);
    if (!r || !r.ok) return;
    const o = r.opportunity;
    $('#detail-head').innerHTML = `
      <h2>${o.url ? `<a href="${escapeHtml(o.url)}" target="_blank" rel="noopener">${escapeHtml(o.title)}</a>` : escapeHtml(o.title)}</h2>
      <div class="meta" style="color:var(--muted);font-size:0.85rem">
        <span class="badge ${escapeHtml(o.status)}">${escapeHtml(o.status)}</span>
        ${escapeHtml(o.funder)} · ${escapeHtml(o.funder_type)} · deadline ${escapeHtml(o.deadline)} · ${escapeHtml(o.amount)}
      </div>
      <p style="margin:0.6rem 0 0.3rem">${escapeHtml(o.summary)}</p>
      <p style="margin:0.3rem 0 0;color:var(--muted);font-size:0.9rem"><strong>Why it fits:</strong> ${escapeHtml(o.why_relevant)}</p>`;
    renderThread(r.chat);
    renderProposal(r.proposal);
    $('#list-view').style.display = 'none';
    $('#detail').style.display = 'block';
    window.scrollTo(0, 0);
  }

  function showList() {
    currentId = null;
    $('#detail').style.display = 'none';
    $('#list-view').style.display = 'block';
    refreshOpportunities();
  }

  function renderThread(chat) {
    const box = $('#thread');
    const msgs = (chat && chat.messages) || [];
    box.innerHTML = msgs.length
      ? msgs.map((m) => `
          <div class="msg ${m.role === 'user' ? 'user' : ''}">
            <div class="who">${m.role === 'user' ? 'You' : 'Resources'}</div>
            <div class="body">${escapeHtml(m.content)}</div>
          </div>`).join('')
      : '<span class="empty">No discussion yet. Ask the first question below.</span>';
    box.scrollTop = box.scrollHeight;
  }

  async function sendChat() {
    if (!currentId) return;
    const btn = $('#chat-btn'), status = $('#chat-status'), ta = $('#chat-input');
    const message = ta.value.trim();
    if (!message) { status.textContent = 'Type a question first.'; return; }
    btn.disabled = true; status.textContent = 'Thinking…';
    try {
      const r = await postJson('api/chat', { id: currentId, message });
      if (!r.ok) { status.textContent = r.message || 'Could not answer.'; return; }
      ta.value = ''; status.textContent = '';
      renderThread(r.chat);
    } catch (e) { status.textContent = 'Network error: ' + e.message; }
    finally { btn.disabled = false; }
  }

  function renderProposal(p) {
    const box = $('#proposal-box'), copy = $('#copy-btn'), btn = $('#proposal-btn');
    if (p && p.draft) {
      box.innerHTML = `<div class="draft">${escapeHtml(p.draft)}</div>
        <p class="status-line" style="margin:0.4rem 0 0">Pass ${p.passes.length} · last updated ${new Date(p.updated_at).toLocaleString()}</p>`;
      copy.style.display = 'inline-block';
      btn.textContent = 'Revise draft';
    } else {
      box.innerHTML = '<span class="empty">No draft yet.</span>';
      copy.style.display = 'none';
      btn.textContent = 'Draft proposal';
    }
  }

  async function draftProposal() {
    if (!currentId) return;
    const btn = $('#proposal-btn'), status = $('#proposal-status');
    btn.disabled = true; status.textContent = 'Writing from your material — this takes a minute…';
    try {
      const r = await postJson('api/proposal', { id: currentId, instructions: $('#proposal-instructions').value.trim() });
      if (!r.ok) { status.textContent = r.message || 'Could not draft it.'; return; }
      $('#proposal-instructions').value = ''; status.textContent = 'Done. Read it critically — fill every [FILL IN] before it goes anywhere.';
      renderProposal(r.proposal);
    } catch (e) { status.textContent = 'Network error: ' + e.message; }
    finally { btn.disabled = false; }
  }

  function copyDraft() {
    const draft = $('#proposal-box .draft');
    if (!draft) return;
    navigator.clipboard.writeText(draft.textContent).then(() => { $('#proposal-status').textContent = 'Copied.'; });
  }

  // ─── Reusable API-key UX (standard — copied verbatim from the template) ──
  function mountKeyUI(opts = {}) {
    const PROVIDERS = { anthropic: { label: 'Anthropic (Claude)', link: 'https://console.anthropic.com/', hint: 'sk-ant-…' },
                        openai:    { label: 'OpenAI (GPT)',       link: 'https://platform.openai.com/api-keys', hint: 'sk-…' } };
    let picked = 'anthropic';

    // One-time styles + DOM
    const style = document.createElement('style');
    style.textContent = `
      #gk-ov{position:fixed;inset:0;background:rgba(20,20,18,.45);display:none;align-items:center;justify-content:center;z-index:9999;padding:1rem}
      #gk-ov.open{display:flex}
      #gk-card{background:#fff;border:1px solid #e5e3da;border-radius:12px;max-width:440px;width:100%;padding:1.6rem 1.7rem;font-family:inherit;box-shadow:0 10px 40px rgba(0,0,0,.18)}
      #gk-card h2{margin:0 0 .35rem;font-size:1.2rem}
      #gk-card p{color:#6b6b66;font-size:.9rem;margin:.2rem 0 1rem}
      .gk-prov{display:flex;gap:.5rem;margin:.5rem 0 1rem}
      .gk-prov button{flex:1;padding:.6rem;border:1px solid #e5e3da;background:#fff;border-radius:8px;cursor:pointer;font-family:inherit;font-size:.9rem}
      .gk-prov button.sel{border-color:#1d4e8a;background:#eef3f8;font-weight:600}
      #gk-key{width:100%;padding:.6rem .75rem;border:1px solid #e5e3da;border-radius:8px;font-family:inherit;font-size:.95rem}
      #gk-msg{font-size:.85rem;margin:.6rem 0 0;min-height:1.1em}
      #gk-msg.err{color:#8a2c2c}#gk-msg.ok{color:#2c6b35}
      .gk-row{display:flex;gap:.5rem;align-items:center;margin-top:1rem}
      .gk-row .gk-save{background:#1d4e8a;color:#fff;border:none;padding:.6rem 1.1rem;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:500}
      .gk-row .gk-save:disabled{background:#9a9a93}
      .gk-row .gk-ghost{background:none;border:1px solid #e5e3da;color:#1c1c1a;padding:.55rem .9rem;border-radius:8px;cursor:pointer;font-family:inherit;font-size:.88rem}
      .gk-row .gk-spacer{flex:1}
      .gk-link{font-size:.8rem;color:#1d4e8a}`;
    document.head.appendChild(style);

    const ov = document.createElement('div');
    ov.id = 'gk-ov';
    ov.innerHTML = `<div id="gk-card">
      <h2 id="gk-title">Add your AI key</h2>
      <p id="gk-sub">Paste your key below — it's saved on this computer only, never uploaded. Nothing to edit by hand.</p>
      <div id="gk-body">
        <div class="gk-prov" id="gk-prov"></div>
        <input type="text" id="gk-key" placeholder="Paste your key" autocomplete="off" />
        <p class="gk-link" id="gk-getlink"></p>
        <p id="gk-msg"></p>
      </div>
      <div class="gk-row" id="gk-actions"></div>
    </div>`;
    document.body.appendChild(ov);

    const el = (id) => ov.querySelector('#' + id);
    const setMsg = (t, kind) => { const m = el('gk-msg'); m.textContent = t || ''; m.className = kind || ''; };
    const renderProviders = () => {
      el('gk-prov').innerHTML = Object.entries(PROVIDERS).map(([k, v]) =>
        `<button data-p="${k}" class="${k === picked ? 'sel' : ''}">${v.label}</button>`).join('');
      el('gk-prov').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        picked = b.dataset.p; renderProviders();
        el('gk-key').placeholder = 'Paste your key (' + PROVIDERS[picked].hint + ')';
        el('gk-getlink').innerHTML = `Don't have one? <a href="${PROVIDERS[picked].link}" target="_blank" rel="noopener">Get a ${PROVIDERS[picked].label} key</a>`;
      }));
      el('gk-key').placeholder = 'Paste your key (' + PROVIDERS[picked].hint + ')';
      el('gk-getlink').innerHTML = `Don't have one? <a href="${PROVIDERS[picked].link}" target="_blank" rel="noopener">Get a ${PROVIDERS[picked].label} key</a>`;
    };

    async function save(required) {
      const key = el('gk-key').value.trim();
      if (!key) { setMsg('Paste your key first.', 'err'); return; }
      const btn = el('gk-savebtn'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Checking…';
      setMsg('Checking the key with ' + PROVIDERS[picked].label + '…', '');
      try {
        const r = await postJson('api/setup', { provider: picked, apiKey: key });
        if (!r.ok) { setMsg(r.message || 'Could not save the key.', 'err'); return; }
        if (r.warning) { setMsg(r.warning, 'ok'); }
        else { setMsg(r.verified ? '✓ Key works. Saved.' : '✓ Saved.', 'ok'); }
        if (typeof opts.onConfigured === 'function') opts.onConfigured();
        setTimeout(() => { if (required) location.reload(); else close(); }, r.warning ? 1400 : 750);
      } catch (e) { setMsg('Network error: ' + e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = old; }
    }

    async function removeKey() {
      if (!confirm('Remove the saved key from this computer? You can paste a new one any time.')) return;
      await postJson('api/setup', { provider: null, apiKey: null });
      location.reload();
    }

    function close() { ov.classList.remove('open'); }

    async function open(mode) {
      const status = await fetchJson('api/setup').catch(() => ({}));
      renderProviders();
      el('gk-key').value = '';
      setMsg('', '');
      if (status.serverManaged) {
        el('gk-title').textContent = 'AI key';
        el('gk-sub').textContent = 'When you use this online, the key is managed by Grounded — there’s nothing to set here.';
        el('gk-body').style.display = 'none';
        el('gk-actions').innerHTML = '<div class="gk-spacer"></div><button class="gk-ghost" id="gk-close">Close</button>';
        el('gk-close').addEventListener('click', close);
      } else {
        el('gk-body').style.display = 'block';
        const configured = !!status.configured;
        el('gk-title').textContent = configured ? 'Change your AI key' : 'Add your AI key';
        el('gk-sub').textContent = configured
          ? `A ${status.activeProvider === 'openai' ? 'OpenAI' : 'Anthropic'} key is set. Paste a new one to replace it — saved on this computer only.`
          : 'Paste your key below — saved on this computer only, never uploaded. Nothing to edit by hand.';
        picked = status.activeProvider === 'openai' ? 'openai' : 'anthropic';
        renderProviders();
        const required = mode === 'required';
        el('gk-actions').innerHTML =
          '<button class="gk-save" id="gk-savebtn">Test &amp; save</button>'
          + (configured ? '<button class="gk-ghost" id="gk-remove">Remove key</button>' : '')
          + '<div class="gk-spacer"></div>'
          + (required ? '' : '<button class="gk-ghost" id="gk-close">Close</button>');
        el('gk-savebtn').addEventListener('click', () => save(required));
        el('gk-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(required); });
        if (el('gk-remove')) el('gk-remove').addEventListener('click', removeKey);
        if (el('gk-close')) el('gk-close').addEventListener('click', close);
      }
      ov.classList.add('open');
      setTimeout(() => el('gk-key') && el('gk-key').focus(), 50);
    }

    // Wire a settings trigger if the page has one.
    const trigger = document.getElementById('key-settings');
    if (trigger) trigger.addEventListener('click', (e) => { e.preventDefault(); open('settings'); });

    // First-run gate: no key + not server-managed → require one now.
    fetchJson('api/setup').then((s) => {
      if (s && !s.configured && !s.serverManaged) open('required');
      else if (typeof opts.onConfigured === 'function') opts.onConfigured();
    }).catch(() => {});
  }

  // ─── Helpers ──
  async function fetchJson(url) { const r = await fetch(url); return r.json(); }
  async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  boot();
})();
