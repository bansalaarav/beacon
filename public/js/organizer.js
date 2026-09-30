import { $, $$, esc, api, avatar, clock, timeAgo, toast, storage } from '/js/common.js';

const code = location.pathname.split('/')[2].toUpperCase();
const hashKey = new URLSearchParams(location.hash.slice(1)).get('key');
if (hashKey) storage.set(`org:${code}`, hashKey);
const organizerKey = hashKey || storage.get(`org:${code}`);
const auth = { organizerKey };

const state = { data: null, activity: [], suggestions: [], search: '', statusFilter: 'here', lastRound: null };
const dash = $('#dash');

async function boot() {
  if (!organizerKey) return renderLocked();
  try {
    state.data = await api(`/api/org/${code}/dashboard`, auth);
  } catch (err) {
    return renderLocked(err.message);
  }
  state.activity = state.data.activity;
  render();
  loadSuggestions();
  setInterval(loadSuggestions, 20_000);

  const socket = io({ auth: { organizerKey, code } });
  socket.on('stats', stats => { state.data.stats = stats; renderStats(); reloadSoon(); });
  socket.on('activity', item => {
    state.activity.unshift(item);
    state.activity = state.activity.slice(0, 60);
    renderFeed();
  });
}

function renderLocked(msg = '') {
  dash.innerHTML = `
    <form class="card" style="max-width:420px;margin:15vh auto" id="key-form">
      <h2>Organizer access</h2>
      <p class="muted small">Paste the organizer key you got when you created event <b>${esc(code)}</b>.</p>
      <input id="key" placeholder="Organizer key" required>
      <button class="btn-block" style="margin-top:.8rem">Open dashboard</button>
      <p class="small" style="color:var(--bad)">${esc(msg)}</p>
    </form>`;
  $('#key-form').onsubmit = e => {
    e.preventDefault();
    storage.set(`org:${code}`, $('#key').value.trim());
    location.hash = '';
    location.reload();
  };
}

let reloadTimer;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const fresh = await api(`/api/org/${code}/dashboard`, auth);
    state.data.attendees = fresh.attendees;
    state.data.event = fresh.event;
    renderAttendees();
    renderWallflowers();
  }, 1500);
}

async function loadSuggestions() {
  const { pairs } = await api(`/api/org/${code}/suggestions`, auth);
  state.suggestions = pairs;
  renderSuggestions();
}

// ------------------------------------------------------------------ layout

function render() {
  const { event, joinUrl } = state.data;
  dash.innerHTML = `
    <div class="dash-head">
      <div class="brand"><span class="logo"></span></div>
      <div>
        <h2 style="margin:0">${esc(event.name)}</h2>
        <div class="muted small">${esc(event.venue || '')} · Event code <b>${esc(event.code)}</b> · <a href="${esc(joinUrl)}" target="_blank">${esc(joinUrl)}</a></div>
      </div>
      <div class="spacer"></div>
      <span class="pill live" id="live-pill"></span>
      <button class="btn-ghost btn-sm" id="qr-btn">▦ Check-in QR</button>
      <a class="btn btn-ghost btn-sm" href="/k/${esc(event.code)}" target="_blank">🖥 Kiosk screen</a>
      <button class="btn-ghost btn-sm" id="csv-btn">⬇ Export CSV</button>
      ${event.demo ? `<button class="btn-sm ${event.simulating ? 'btn-warm' : 'btn-soft'}" id="sim-btn">${event.simulating ? '⏸ Stop simulation' : '▶ Simulate live activity'}</button>` : ''}
    </div>

    <div class="stats" id="stats"></div>

    <div class="dash-grid">
      <div class="stack">
        <div class="card chart"><div class="row"><h3 style="margin:0">Attendance</h3><div class="spacer"></div><span class="muted small">people present over time</span></div><div id="chart"></div></div>
        <div class="card">
          <div class="row"><h3 style="margin:0">✦ Matchmaker</h3><div class="spacer"></div><button class="btn-ghost btn-sm" id="refresh-sugg">↻</button></div>
          <p class="muted small">Best pairs in the room who haven't connected yet. Introduce them and both get a notification.</p>
          <div id="suggestions"></div>
        </div>
        <div class="card">
          <h3>🌱 Haven't connected with anyone yet</h3>
          <p class="muted small">Here for 15+ minutes with no connections. Give them a warm intro.</p>
          <div id="wallflowers"></div>
        </div>
        <div class="card">
          <div class="row wrap"><h3 style="margin:0">Attendees</h3><div class="spacer"></div>
            <select id="status-filter" style="width:auto"><option value="here">Here now</option><option value="left">Left</option><option value="all">Everyone</option></select>
            <input id="att-search" type="search" placeholder="Search" style="width:180px"></div>
          <div class="table-wrap" style="margin-top:.6rem"><table id="att-table"></table></div>
        </div>
      </div>

      <div class="stack">
        <form class="card" id="announce-form">
          <h3>📣 Announce</h3>
          <textarea id="announce-text" rows="2" placeholder="Pizza is here! Talks start in 10 minutes on the main floor."></textarea>
          <button class="btn-block" style="margin-top:.6rem">Send to everyone</button>
        </form>
        <div class="card">
          <h3>🔀 Mixer round</h3>
          <p class="muted small">Put everyone who's open to chat into small groups of well-matched people. Each person gets their table and a topic on their phone.</p>
          <div class="row"><select id="group-size" style="width:auto">${[3, 4, 5, 6].map(n => `<option ${n === 4 ? 'selected' : ''} value="${n}">Groups of ${n}</option>`).join('')}</select>
            <button class="spacer" id="round-btn">Start round ${event.rounds + 1}</button></div>
          <div id="round-result" class="small" style="margin-top:.6rem"></div>
        </div>
        <div class="card"><h3>📍 Where people are</h3><div id="zones"></div></div>
        <div class="card"><h3>🔥 Hot topics in the room</h3><div class="cloud" id="cloud"></div></div>
        <div class="card"><h3>⚖️ Supply vs demand</h3><p class="muted small">What people want that few can offer. Useful for picking your next speaker or who to invite.</p><div id="gaps"></div></div>
        <div class="card"><h3>Live activity</h3><div class="feed" id="feed"></div></div>
      </div>
    </div>`;

  $('#qr-btn').onclick = showQr;
  $('#csv-btn').onclick = exportCsv;
  $('#refresh-sugg').onclick = loadSuggestions;
  $('#status-filter').value = state.statusFilter;
  $('#status-filter').onchange = e => { state.statusFilter = e.target.value; renderAttendees(); };
  $('#att-search').oninput = e => { state.search = e.target.value.toLowerCase(); renderAttendees(); };
  $('#announce-form').onsubmit = announce;
  $('#round-btn').onclick = startRound;
  const sim = $('#sim-btn');
  if (sim) sim.onclick = async () => {
    const { simulating } = await api(`/api/org/${code}/simulate`, { ...auth, method: 'POST' });
    state.data.event.simulating = simulating;
    sim.textContent = simulating ? '⏸ Stop simulation' : '▶ Simulate live activity';
    sim.className = `btn-sm ${simulating ? 'btn-warm' : 'btn-soft'}`;
    toast(simulating ? 'Simulation running: demo attendees will arrive, move around, connect and wave at real attendees.' : 'Simulation stopped.');
  };

  renderStats();
  renderSuggestions();
  renderWallflowers();
  renderAttendees();
  renderFeed();
}

function renderStats() {
  const s = state.data.stats;
  $('#live-pill').textContent = `${s.here} here now`;
  $('#stats').innerHTML = [
    [s.here, 'Here now'],
    [s.total, 'Checked in total'],
    [s.left, 'Have left'],
    [s.connections, 'Connections made'],
    [`${s.connectedPct}%`, 'Made ≥1 connection'],
    [s.pendingWaves, 'Waves awaiting reply'],
  ].map(([v, l]) => `<div class="card stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  renderChart(s.timeline);

  const zoneMax = Math.max(1, ...Object.values(s.zones), s.unplaced);
  $('#zones').innerHTML = Object.entries(s.zones).concat(s.unplaced ? [['Not set', s.unplaced]] : [])
    .map(([z, n]) => `<div class="bar-row"><span>${esc(z)}</span><div class="bar"><span style="width:${100 * n / zoneMax}%"></span></div><b>${n}</b></div>`).join('');

  const tagMax = Math.max(1, ...s.topTags.map(t => t[1]));
  $('#cloud').innerHTML = s.topTags.map(([t, n]) =>
    `<span style="font-size:${0.8 + 0.9 * n / tagMax}rem;font-weight:${n / tagMax > .5 ? 700 : 500};color:${n / tagMax > .5 ? 'var(--accent)' : 'var(--text)'}">${esc(t)} <sup class="muted">${n}</sup></span>`).join('') || '<span class="muted small">No tags yet</span>';

  $('#gaps').innerHTML = s.gaps.map(g => `<div class="bar-row" style="grid-template-columns:120px 1fr 60px"><span>${esc(g.tag)}</span>
      <div class="bar" title="${g.want} want / ${g.offer} offer"><span style="width:${100 * g.want / Math.max(g.want, g.offer, 1)}%;background:var(--accent-2)"></span></div>
      <span class="small">${g.want} ⇢ ${g.offer}</span></div>`).join('') || '<span class="muted small">Not enough data yet</span>';
}

function renderChart(series) {
  const el = $('#chart');
  if (!series.length) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
  const W = 600, H = 180, P = 28;
  const t0 = series[0].t, t1 = Math.max(series[series.length - 1].t, t0 + 60_000);
  const max = Math.max(5, ...series.map(p => p.here));
  const x = t => P + (W - 2 * P) * (t - t0) / (t1 - t0);
  const y = v => H - P - (H - 2 * P) * v / max;
  // Step line: attendance only changes at discrete check-in/out moments.
  let d = `M${x(series[0].t)},${y(series[0].here)}`;
  for (let i = 1; i < series.length; i++) d += ` H${x(series[i].t)} V${y(series[i].here)}`;
  const area = `${d} V${H - P} H${x(series[0].t)} Z`;
  const ticks = [0, .25, .5, .75, 1].map(f => t0 + f * (t1 - t0));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Attendance over time">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${[0, .5, 1].map(f => `<line x1="${P}" x2="${W - P}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="var(--border)"/><text x="${P - 6}" y="${y(max * f) + 4}" font-size="10" text-anchor="end" fill="var(--muted)">${Math.round(max * f)}</text>`).join('')}
    <path d="${area}" fill="url(#g)"/>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
    ${ticks.map(t => `<text x="${x(t)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="var(--muted)">${clock(t)}</text>`).join('')}
  </svg>`;
}

function pairRow(p) {
  return `<div class="pair">
    ${avatar(p.a, { size: 'sm' })}${avatar(p.b, { size: 'sm' })}
    <div class="names"><b>${esc(p.a.name)}</b> & <b>${esc(p.b.name)}</b><div class="muted small">${esc(p.reason)}</div></div>
    <span class="score">${p.score}%</span>
    <button class="btn-sm" data-intro="${p.a.id}|${p.b.id}">Introduce</button>
  </div>`;
}

function bindIntros(root) {
  $$('[data-intro]', root).forEach(b => b.onclick = async () => {
    const [a, bb] = b.dataset.intro.split('|');
    b.disabled = true;
    await api(`/api/org/${code}/introduce`, { ...auth, method: 'POST', body: { a, b: bb } });
    b.textContent = 'Introduced ✓';
  });
}

function renderSuggestions() {
  const el = $('#suggestions');
  if (!el) return;
  el.innerHTML = state.suggestions.length ? state.suggestions.map(pairRow).join('') : '<div class="muted small">No suggestions yet. They appear as people check in.</div>';
  bindIntros(el);
}

function renderWallflowers() {
  const el = $('#wallflowers');
  if (!el) return;
  const list = state.data.stats.wallflowers;
  el.innerHTML = list.length ? list.map(p => `
    <div class="pair" data-wf="${p.id}">
      ${avatar(p, { size: 'sm' })}
      <div class="names"><b>${esc(p.name)}</b><div class="muted small">${esc(p.headline)} · here since ${clock(p.checkedInAt)}${p.zone ? ` · 📍 ${esc(p.zone)}` : ''}</div></div>
      <button class="btn-soft btn-sm" data-find="${p.id}">Find a match</button>
    </div><div data-for="${p.id}"></div>`).join('') : '<div class="muted small">Everyone has made at least one connection 🎉</div>';
  $$('[data-find]', el).forEach(b => b.onclick = async () => {
    const { pairs } = await api(`/api/org/${code}/suggestions?for=${b.dataset.find}`, auth);
    const box = $(`[data-for="${b.dataset.find}"]`, el);
    box.innerHTML = pairs.length ? pairs.map(pairRow).join('') : '<div class="muted small">No strong matches. Try a mixer round.</div>';
    bindIntros(box);
  });
}

function renderAttendees() {
  const el = $('#att-table');
  if (!el) return;
  let list = state.data.attendees;
  if (state.statusFilter !== 'all') list = list.filter(a => a.status === state.statusFilter);
  if (state.search) list = list.filter(a => `${a.name} ${a.headline} ${a.company}`.toLowerCase().includes(state.search));
  list = [...list].sort((a, b) => b.checkedInAt - a.checkedInAt);
  el.innerHTML = `<tr><th></th><th>Name</th><th>Zone</th><th>Arrived</th><th>Connections</th><th>Status</th><th></th></tr>` +
    list.map(a => `<tr>
      <td>${avatar(a, { size: 'sm', showOnline: true })}</td>
      <td><b>${esc(a.name)}</b><div class="muted small">${esc(a.headline)}</div></td>
      <td>${esc(a.zone || '—')}</td>
      <td class="small">${clock(a.checkedInAt)}<div class="muted">${timeAgo(a.checkedInAt)}</div></td>
      <td>${a.connections}</td>
      <td>${a.status === 'here' ? (a.online ? '<span class="tag offer">here · online</span>' : '<span class="tag">here · app closed</span>') : `<span class="tag">left ${a.checkedOutAt ? clock(a.checkedOutAt) : ''}</span>`}</td>
      <td><button class="btn-ghost btn-sm" data-toggle="${a.id}" data-to="${a.status === 'here' ? 'left' : 'here'}">${a.status === 'here' ? 'Check out' : 'Check in'}</button></td>
    </tr>`).join('');
  $$('[data-toggle]', el).forEach(b => b.onclick = async () => {
    await api(`/api/org/${code}/attendees/${b.dataset.toggle}/status`, { ...auth, method: 'POST', body: { status: b.dataset.to } });
  });
}

function renderFeed() {
  const el = $('#feed');
  if (!el) return;
  el.innerHTML = state.activity.map(a => `<div><time>${clock(a.at)}</time><span>${esc(a.text)}</span></div>`).join('') || '<div class="muted small">Quiet so far…</div>';
}

// ------------------------------------------------------------------ actions

async function announce(e) {
  e.preventDefault();
  const text = $('#announce-text').value.trim();
  if (!text) return;
  await api(`/api/org/${code}/announce`, { ...auth, method: 'POST', body: { text } });
  $('#announce-text').value = '';
  toast('Announcement sent to every attendee.');
}

async function startRound() {
  const btn = $('#round-btn');
  btn.disabled = true;
  try {
    const { round } = await api(`/api/org/${code}/rounds`, { ...auth, method: 'POST', body: { size: Number($('#group-size').value) } });
    $('#round-result').innerHTML = `<b>Round ${round.n} sent.</b>` + round.groups.map(g =>
      `<div style="margin-top:.4rem"><b>${esc(g.table)}</b> · <span class="muted">${esc(g.topic)}</span><br>${g.members.map(esc).join(', ')}</div>`).join('');
    btn.textContent = `Start round ${round.n + 1}`;
  } catch (err) {
    toast(esc(err.message));
  }
  btn.disabled = false;
}

async function showQr() {
  const { joinUrl, event } = state.data;
  const svg = await (await fetch(`/api/events/${code}/qr.svg`)).text();
  const back = document.createElement('div');
  back.className = 'sheet-backdrop';
  back.style.display = 'grid';
  back.style.placeItems = 'center';
  back.innerHTML = `<div class="card" style="text-align:center;max-width:380px" onclick="event.stopPropagation()">
    <h2>${esc(event.name)}</h2><p class="muted">Scan to check in</p>
    <div style="background:#fff;padding:12px;border-radius:12px">${svg}</div>
    <div class="code-input" style="margin-top:.8rem">${esc(event.code)}</div>
    <div class="small muted">${esc(joinUrl)}</div>
    <button class="btn-ghost btn-sm" style="margin-top:.8rem" onclick="window.print()">Print</button></div>`;
  back.onclick = () => back.remove();
  document.body.append(back);
}

async function exportCsv() {
  const res = await api(`/api/org/${code}/export.csv`, { ...auth, raw: true });
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href: url, download: `${code}-attendance.csv` }).click();
  URL.revokeObjectURL(url);
}

boot();
