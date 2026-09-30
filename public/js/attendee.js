import { $, $$, esc, api, avatar, timeAgo, toast, resizeImage, storage, chipInput, SUGGESTED } from '/js/common.js';

const code = location.pathname.split('/')[2].toUpperCase();
const params = new URLSearchParams(location.search);
if (params.get('connect')) {
  storage.set(`connect:${code}`, params.get('connect'));
  history.replaceState(null, '', location.pathname);
}

const COLOR_NAMES = {
  '#ef4444': 'red', '#f97316': 'orange', '#eab308': 'yellow', '#22c55e': 'green', '#14b8a6': 'teal', '#06b6d4': 'cyan',
  '#3b82f6': 'blue', '#6366f1': 'indigo', '#a855f7': 'purple', '#ec4899': 'pink', '#84cc16': 'lime', '#f43f5e': 'rose',
};
const EMOJIS = ['👋', '🚀', '💡', '🎨', '💻', '📈', '🌱', '🤖', '🎤', '📚', '🧠', '☕'];

const state = {
  token: storage.get(`tok:${code}`),
  me: null,
  event: null,
  ai: false,
  attendees: new Map(),
  matches: [],
  waves: [],
  tab: storage.get('beacon:tab') || 'foryou',
  search: '',
  filter: 'all',
  showLeft: false,
  round: null,
  announcement: null,
  fresh: new Set(),
  socket: null,
};

const app = $('#app');
const auth = () => ({ token: state.token });

// ------------------------------------------------------------------ boot

async function boot() {
  let info;
  try {
    info = await api(`/api/events/${code}`);
  } catch {
    app.innerHTML = `<div class="view"><div class="empty"><h2>Event not found</h2><p>Check the code and try again.</p><a class="btn" href="/">Back</a></div></div>`;
    return;
  }
  document.title = `${info.name} · Beacon`;

  if (state.token) {
    try {
      const data = await api('/api/me', auth());
      Object.assign(state, { me: data.me, event: data.event, ai: data.ai, round: data.event.round, announcement: data.event.announcements[0] || null });
      return start();
    } catch {
      storage.del(`tok:${code}`);
      state.token = null;
    }
  }
  renderOnboarding(info);
}

async function start() {
  await Promise.all([loadAttendees(), loadMatches(), loadWaves()]);
  connectSocket();
  render();
  const pending = storage.get(`connect:${code}`);
  if (pending) {
    storage.del(`connect:${code}`);
    connectByBadge(pending);
  }
}

async function loadAttendees() {
  const { attendees } = await api('/api/me/attendees', auth());
  state.attendees = new Map(attendees.map(a => [a.id, a]));
}
async function loadMatches() {
  const { matches } = await api('/api/me/matches', auth());
  state.matches = matches;
}
async function loadWaves() {
  const { waves } = await api('/api/me/waves', auth());
  state.waves = waves;
}

let matchTimer;
function refreshMatchesSoon() {
  clearTimeout(matchTimer);
  matchTimer = setTimeout(async () => { await loadMatches(); if (state.tab === 'foryou') renderView(); }, 1200);
}

// ------------------------------------------------------------------ realtime

function connectSocket() {
  const s = io({ auth: { token: state.token } });
  state.socket = s;
  setInterval(() => s.connected && s.emit('heartbeat'), 60_000);

  s.on('attendee:upsert', a => {
    if (a.id === state.me.id) return;
    const prev = state.attendees.get(a.id);
    state.attendees.set(a.id, a);
    const arrived = a.status === 'here' && (!prev || prev.status !== 'here');
    if (arrived) {
      state.fresh.add(a.id);
      setTimeout(() => state.fresh.delete(a.id), 4000);
      const match = state.matches.find(m => m.person.id === a.id);
      if (match && match.score >= 50) {
        toast(`🔔 <b>${esc(a.name)}</b> just arrived. They're one of your top matches.`, { action: 'View', onAction: () => openPerson(a.id) });
      }
    }
    if (arrived || (prev && prev.status !== a.status) || !prev) refreshMatchesSoon();
    else state.matches.forEach(m => { if (m.person.id === a.id) m.person = a; });
    renderView(true);
  });

  s.on('me', me => { state.me = me; renderHeader(); });

  s.on('wave', w => {
    const i = state.waves.findIndex(x => x.id === w.id);
    const prev = i >= 0 ? state.waves[i] : null;
    if (i >= 0) state.waves[i] = { ...state.waves[i], ...w }; else state.waves.unshift(w);
    if (w.other) state.attendees.set(w.other.id, w.other);
    state.matches.forEach(m => { if (m.person.id === w.other?.id) { m.wave = w; m.connected = w.status === 'accepted'; } });

    if (w.direction === 'in' && w.status === 'pending' && !prev) {
      toast(`👋 <b>${esc(w.other.name)}</b> waved at you${w.note ? `: “${esc(w.note)}”` : ''}`, { action: 'View', onAction: () => openPerson(w.other.id), timeout: 8000 });
    }
    if (w.status === 'accepted' && prev?.status !== 'accepted') {
      toast(`🤝 You're connected with <b>${esc(w.other.name)}</b>`, { action: 'Find them', onAction: () => openPerson(w.other.id) });
    }
    renderTabs();
    renderView(true);
  });

  s.on('announcement', a => {
    state.announcement = a;
    toast(`📣 ${esc(a.text)}`, { timeout: 10000 });
    renderView(true);
  });

  s.on('intro', ({ person, reasons, note }) => {
    state.attendees.set(person.id, person);
    toast(`🤝 The organizer thinks you should meet <b>${esc(person.name)}</b>. ${esc(note || reasons[0] || '')}`, {
      action: 'View', onAction: () => openPerson(person.id), timeout: 12000,
    });
  });

  s.on('round', round => {
    state.round = round;
    toast(`🔀 Mixer round ${round.n}: head to <b>${esc(round.table)}</b>`, { action: 'See group', onAction: () => setTab('foryou'), timeout: 12000 });
    renderView(true);
  });

  s.on('beacon', ({ from }) => {
    state.attendees.set(from.id, from);
    const colour = COLOR_NAMES[from.color] || 'coloured';
    toast(`🔆 <b>${esc(from.name)}</b> is looking for you. They're holding up a <b style="color:${esc(from.color)}">${colour}</b> screen${from.zone ? ` near ${esc(from.zone)}` : ''}.`, {
      action: 'Flash back', onAction: () => showBeacon(from), timeout: 15000,
    });
  });

  s.on('connect_error', () => {});
}

// ------------------------------------------------------------------ onboarding

function profileForm(p = {}, { submitLabel }) {
  return `
    <form id="profile-form" class="stack">
      <div class="row" style="gap:1rem">
        <label class="avatar lg" id="photo-preview" style="--c:${esc(p.color || '#5b4cf0')};cursor:pointer" title="Add a photo">
          ${p.photo ? `<img src="${esc(p.photo)}" alt="">` : '📷'}
          <input type="file" accept="image/*" capture="user" id="photo" class="hidden">
        </label>
        <div class="spacer">
          <div class="field" style="margin:0"><label for="f-name">Your name *</label><input id="f-name" required value="${esc(p.name || '')}" autocomplete="name"></div>
        </div>
      </div>
      <p class="hint" style="margin-top:.2rem">A photo makes you <b>much</b> easier to find in a crowd.</p>
      <div class="field"><label for="f-headline">What do you do?</label><input id="f-headline" value="${esc(p.headline || '')}" placeholder="Founder, ML engineer, CS student…"></div>
      <div class="field"><label for="f-company">Company / school</label><input id="f-company" value="${esc(p.company || '')}"></div>
      <div class="field"><label>I'm looking for <span class="hint">(this drives your matches)</span></label><div id="f-looking"></div></div>
      <div class="field"><label>I can help with</label><div id="f-offering"></div></div>
      <div class="field"><label>Interests</label><div id="f-interests"></div></div>
      <div class="field"><label for="f-spot">How can people spot you? *</label>
        <input id="f-spot" required value="${esc(p.spotMe || '')}" placeholder="Red hoodie, glasses, near the bar"></div>
      <div class="field"><label>Pick an icon</label>
        <div class="row wrap" id="f-emoji">${EMOJIS.map(e => `<button type="button" class="btn-ghost btn-sm ${e === (p.emoji || '👋') ? 'btn-soft' : ''}" data-e="${e}">${e}</button>`).join('')}</div></div>
      <div class="field"><label for="f-bio">Short bio</label><textarea id="f-bio" rows="2" placeholder="What are you working on? What would you love to talk about?">${esc(p.bio || '')}</textarea></div>
      <div class="field"><label for="f-linkedin">LinkedIn <span class="hint">(only shared with people you connect with)</span></label><input id="f-linkedin" value="${esc(p.linkedin || '')}" placeholder="https://linkedin.com/in/…"></div>
      <div class="field"><label for="f-email">Email <span class="hint">(only shared with connections)</span></label><input id="f-email" type="email" value="${esc(p.email || '')}"></div>
      <button class="btn-block">${submitLabel}</button>
      <p class="small" id="form-error" style="color:var(--bad)"></p>
    </form>`;
}

function bindProfileForm(p, onSubmit) {
  let photo = p.photo || '';
  let emoji = p.emoji || '👋';
  const looking = chipInput($('#f-looking'), { value: p.lookingFor || [], suggestions: SUGGESTED.lookingFor, placeholder: 'e.g. co-founder, mentorship' });
  const offering = chipInput($('#f-offering'), { value: p.offering || [], suggestions: SUGGESTED.offering, placeholder: 'e.g. design, fundraising' });
  const interests = chipInput($('#f-interests'), { value: p.interests || [], suggestions: SUGGESTED.interests, placeholder: 'e.g. climate tech' });

  $('#photo').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    photo = await resizeImage(file);
    $('#photo-preview').innerHTML = `<img src="${photo}" alt="">`;
  };
  $$('#f-emoji button').forEach(b => b.onclick = () => {
    emoji = b.dataset.e;
    $$('#f-emoji button').forEach(x => x.classList.toggle('btn-soft', x === b));
  });

  $('#profile-form').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button:not([type])') || e.target.querySelector('.btn-block');
    btn.disabled = true;
    try {
      await onSubmit({
        name: $('#f-name').value, headline: $('#f-headline').value, company: $('#f-company').value,
        lookingFor: looking.value, offering: offering.value, interests: interests.value,
        spotMe: $('#f-spot').value, emoji, bio: $('#f-bio').value,
        linkedin: $('#f-linkedin').value, email: $('#f-email').value,
        ...(photo !== (p.photo || '') ? { photo } : {}),
      });
    } catch (err) {
      $('#form-error').textContent = err.message;
      btn.disabled = false;
    }
  };
}

function renderOnboarding(info) {
  app.innerHTML = `
    <div class="topbar"><div class="brand" style="font-size:1rem"><span class="logo" style="width:26px;height:26px"></span></div>
      <div class="title">${esc(info.name)}</div><div class="spacer"></div><span class="pill live">${info.here} here</span></div>
    <div class="view">
      <div class="banner">
        <h2 style="margin:0 0 .3rem">Check in to ${esc(info.name)}</h2>
        <div class="muted small">${esc(info.venue || '')}${info.description ? ` · ${esc(info.description)}` : ''}</div>
        <div class="muted small" style="margin-top:.4rem">Takes about 45 seconds. We'll show you who's worth meeting and why.</div>
      </div>
      ${profileForm({}, { submitLabel: "I'm here, check me in" })}
    </div>`;
  bindProfileForm({}, async profile => {
    const { token, me } = await api(`/api/events/${code}/checkin`, { method: 'POST', body: profile });
    state.token = token;
    storage.set(`tok:${code}`, token);
    const data = await api('/api/me', auth());
    Object.assign(state, { me, event: data.event, ai: data.ai, announcement: data.event.announcements[0] || null, tab: 'foryou' });
    await start();
    toast(`Welcome, ${esc(me.name.split(' ')[0])}! Here are the people you should meet.`);
  });
}

// ------------------------------------------------------------------ shell

function render() {
  app.innerHTML = `
    <div class="topbar" id="topbar"></div>
    <div class="view" id="view"></div>
    <nav class="tabbar"><div class="inner" id="tabs"></div></nav>`;
  renderHeader();
  renderTabs();
  renderView();
}

function hereCount() {
  let n = state.me.status === 'here' ? 1 : 0;
  for (const a of state.attendees.values()) if (a.status === 'here') n++;
  return n;
}

function renderHeader() {
  const top = $('#topbar');
  if (!top) return;
  top.innerHTML = `
    <div class="title">${esc(state.event.name)}</div>
    <span class="pill live">${hereCount()} here</span>
    <div class="spacer"></div>
    <select id="zone" style="width:auto;max-width:130px;padding:.35rem .5rem;font-size:.85rem" aria-label="Where are you?">
      <option value="">📍 I'm at…</option>
      ${state.event.zones.map(z => `<option ${z === state.me.zone ? 'selected' : ''}>${esc(z)}</option>`).join('')}
    </select>`;
  $('#zone').onchange = async e => {
    const { me } = await api('/api/me', { ...auth(), method: 'PATCH', body: { zone: e.target.value } });
    state.me = me;
  };
}

function renderTabs() {
  const pendingIn = state.waves.filter(w => w.direction === 'in' && w.status === 'pending').length;
  const tabs = [
    ['foryou', '✦', 'For you'],
    ['here', '🟢', 'Here now'],
    ['waves', '🤝', 'Connections', pendingIn],
    ['me', '🪪', 'My badge'],
  ];
  const el = $('#tabs');
  if (!el) return;
  el.innerHTML = tabs.map(([id, ico, label, count]) =>
    `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}"><span class="ico">${ico}</span>${label}${count ? `<span class="badge-count">${count}</span>` : ''}</button>`).join('');
  $$('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
}

function setTab(tab) {
  state.tab = tab;
  storage.set('beacon:tab', tab);
  renderTabs();
  renderView();
  window.scrollTo(0, 0);
}

function renderView(soft = false) {
  renderHeader();
  const view = $('#view');
  if (!view) return;
  // Don't clobber a search box the user is typing in.
  if (soft && document.activeElement?.id === 'search') { renderHereList(); return; }
  ({ foryou: renderForYou, here: renderHere, waves: renderWaves, me: renderMe })[state.tab](view);
}

// ------------------------------------------------------------------ cards

function personCard(p, { score, reasons, extra = '' } = {}) {
  const connected = state.waves.some(w => w.other?.id === p.id && w.status === 'accepted');
  return `
    <div class="person ${p.status === 'left' ? 'left' : ''} ${state.fresh.has(p.id) ? 'fresh' : ''}" data-person="${p.id}">
      ${avatar(p, { showOnline: true })}
      <div class="body">
        <div class="name">${esc(p.name)} ${connected ? '<span class="tag offer">connected</span>' : ''} ${!p.openToChat && p.status === 'here' ? '<span class="tag">busy</span>' : ''}</div>
        <div class="headline">${esc(p.headline)}${p.company ? ` · ${esc(p.company)}` : ''}</div>
        ${reasons?.length ? reasons.slice(0, 2).map(r => `<div class="reason">${esc(r.text)}</div>`).join('') : ''}
        <div class="meta">
          ${p.status === 'left' ? '<span>Left the event</span>' : ''}
          ${p.status === 'here' && p.zone ? `<span>📍 ${esc(p.zone)}</span>` : ''}
          ${p.status === 'here' && p.spotMe ? `<span>👀 ${esc(p.spotMe)}</span>` : ''}
        </div>
        ${extra}
      </div>
      ${score != null ? `<div class="score">${score}%</div>` : ''}
    </div>`;
}

function bindCards(root) {
  $$('[data-person]', root).forEach(el => el.onclick = e => {
    if (e.target.closest('button')) return;
    openPerson(el.dataset.person);
  });
}

function banners() {
  let html = '';
  if (state.me.status === 'left') {
    html += `<div class="banner warm"><b>You're checked out.</b><div class="muted small">Other people can't see you in the live list.</div>
      <button class="btn-sm" style="background:#fff;color:#000;margin-top:.6rem" id="rejoin">I'm back, check me in</button></div>`;
  }
  if (state.round) {
    const r = state.round;
    html += `<div class="banner"><div class="small muted">MIXER ROUND ${r.n}</div>
      <h2 style="margin:.2rem 0">Head to ${esc(r.table)}</h2>
      <div class="small">Suggested topic: <b>${esc(r.topic)}</b></div>
      <div class="row wrap" style="margin-top:.6rem">${r.members.map(m => `<span class="row" data-person="${m.id}" style="gap:.35rem;cursor:pointer">${avatar(m, { size: 'sm' })}<span class="small">${esc(m.name.split(' ')[0])}</span></span>`).join('')}</div></div>`;
  }
  if (state.announcement && Date.now() - state.announcement.at < 20 * 60_000) {
    html += `<div class="card" style="margin-bottom:.9rem">📣 <b>From the organizer:</b> ${esc(state.announcement.text)} <span class="muted small">· ${timeAgo(state.announcement.at)}</span></div>`;
  }
  return html;
}

function bindBanners(view) {
  const rejoin = $('#rejoin', view);
  if (rejoin) rejoin.onclick = async () => { state.me = (await api('/api/me/checkin', { ...auth(), method: 'POST' })).me; renderView(); };
}

function renderForYou(view) {
  const fresh = state.matches.filter(m => !m.connected);
  const incoming = state.waves.filter(w => w.direction === 'in' && w.status === 'pending');
  view.innerHTML = `
    ${banners()}
    ${incoming.length ? `<div class="card" style="margin-bottom:.9rem;cursor:pointer" id="go-waves">👋 <b>${incoming.length} ${incoming.length === 1 ? 'person wants' : 'people want'} to meet you</b> <span class="muted">· tap to respond</span></div>` : ''}
    <div class="row"><h2 style="margin:0">People to meet</h2><div class="spacer"></div><span class="muted small">${fresh.length} matches here now</span></div>
    <p class="muted small">Ranked by how well your needs, offers and interests line up. Tap anyone to see how to find them.</p>
    ${fresh.length ? fresh.map(m => personCard(m.person, m)).join('') :
      `<div class="empty">No matches yet. Add a few more things you're <b>looking for</b> and <b>can help with</b> in <a href="#" id="edit-link">your profile</a>, or check <b>Here now</b>.</div>`}`;
  bindCards(view);
  bindBanners(view);
  const go = $('#go-waves', view); if (go) go.onclick = () => setTab('waves');
  const edit = $('#edit-link', view); if (edit) edit.onclick = e => { e.preventDefault(); openEditProfile(); };
}

function renderHere(view) {
  const zones = state.event.zones;
  view.innerHTML = `
    ${banners()}
    <input id="search" type="search" placeholder="Search names, companies, interests…" value="${esc(state.search)}">
    <div class="filters">
      ${[['all', 'Everyone'], ['open', 'Open to chat'], ['new', 'Just arrived'], ...zones.map(z => [`zone:${z}`, `📍 ${z}`])]
        .map(([id, label]) => `<button class="btn-ghost btn-sm ${state.filter === id ? 'on' : ''}" data-filter="${esc(id)}">${esc(label)}</button>`).join('')}
    </div>
    <div id="here-list"></div>
    <label class="row small muted" style="justify-content:center;margin-top:1rem;font-weight:500"><input type="checkbox" id="show-left" style="width:auto" ${state.showLeft ? 'checked' : ''}> Show people who left</label>`;
  $('#search').oninput = e => { state.search = e.target.value; renderHereList(); };
  $$('[data-filter]', view).forEach(b => b.onclick = () => { state.filter = b.dataset.filter; renderView(); });
  $('#show-left').onchange = e => { state.showLeft = e.target.checked; renderHereList(); };
  bindBanners(view);
  renderHereList();
}

function renderHereList() {
  const list = $('#here-list');
  if (!list) return;
  const q = state.search.trim().toLowerCase();
  const scoreOf = new Map(state.matches.map(m => [m.person.id, m.score]));
  let people = [...state.attendees.values()].filter(p => state.showLeft || p.status === 'here');
  if (q) people = people.filter(p => [p.name, p.headline, p.company, p.bio, p.spotMe, ...p.interests, ...p.lookingFor, ...p.offering].join(' ').toLowerCase().includes(q));
  if (state.filter === 'open') people = people.filter(p => p.openToChat);
  if (state.filter === 'new') people = people.filter(p => Date.now() - p.checkedInAt < 20 * 60_000);
  if (state.filter.startsWith('zone:')) people = people.filter(p => p.zone === state.filter.slice(5));
  people.sort((a, b) => (a.status === 'left') - (b.status === 'left') || (scoreOf.get(b.id) || 0) - (scoreOf.get(a.id) || 0) || b.checkedInAt - a.checkedInAt);
  list.innerHTML = `<div class="section-title">${people.length} ${people.length === 1 ? 'person' : 'people'}</div>` +
    (people.length ? people.map(p => personCard(p, { score: scoreOf.get(p.id) })).join('') : '<div class="empty">Nobody matches that filter.</div>');
  bindCards(list);
}

function renderWaves(view) {
  const incoming = state.waves.filter(w => w.direction === 'in' && w.status === 'pending');
  const connected = state.waves.filter(w => w.status === 'accepted');
  const sent = state.waves.filter(w => w.direction === 'out' && w.status === 'pending');
  view.innerHTML = `
    <form class="card row" id="badge-form" style="margin-bottom:1rem">
      <div class="spacer"><b>Met someone in person?</b><div class="small muted">Enter their 4-digit badge code to swap contacts.</div></div>
      <input id="badge-code" inputmode="numeric" maxlength="4" placeholder="0000" style="width:90px;text-align:center;font-weight:700;letter-spacing:.2em">
      <button class="btn-sm">Connect</button>
    </form>
    ${incoming.length ? `<div class="section-title">Want to meet you</div>${incoming.map(w => personCard(w.other, {
      extra: `${w.note ? `<div class="small" style="margin-top:.35rem">“${esc(w.note)}”</div>` : ''}
        <div class="row" style="margin-top:.6rem"><button class="btn-sm btn-good" data-accept="${w.id}">Accept</button><button class="btn-sm btn-ghost" data-decline="${w.id}">Not now</button></div>`,
    })).join('')}` : ''}
    <div class="row"><div class="section-title">Connections (${connected.length})</div><div class="spacer"></div>
      ${connected.length ? '<button class="btn-sm btn-soft" id="vcf">⬇ Save all contacts</button>' : ''}</div>
    ${connected.length ? connected.map(w => personCard(w.other, {
      extra: `<div class="meta">${w.other.email ? `<span>✉ ${esc(w.other.email)}</span>` : ''}${w.other.linkedin ? `<span>in/ LinkedIn</span>` : ''}<span>${w.via === 'badge' ? 'Met in person' : 'Connected'} ${timeAgo(w.respondedAt || w.createdAt)}</span></div>`,
    })).join('') : '<div class="empty">No connections yet. Wave at someone from <b>For you</b>.</div>'}
    ${sent.length ? `<div class="section-title">Waiting for a reply</div>${sent.map(w => personCard(w.other)).join('')}` : ''}`;
  bindCards(view);
  $$('[data-accept]', view).forEach(b => b.onclick = () => respond(b.dataset.accept, true));
  $$('[data-decline]', view).forEach(b => b.onclick = () => respond(b.dataset.decline, false));
  $('#badge-form').onsubmit = e => { e.preventDefault(); connectByBadge($('#badge-code').value); };
  const vcf = $('#vcf'); if (vcf) vcf.onclick = downloadContacts;
}

async function respond(id, accept) {
  const { wave } = await api(`/api/waves/${id}/respond`, { ...auth(), method: 'POST', body: { accept } });
  const i = state.waves.findIndex(w => w.id === id);
  state.waves[i] = { ...state.waves[i], ...wave };
  renderTabs();
  renderView();
}

async function connectByBadge(badge) {
  try {
    const { wave } = await api('/api/me/connect', { ...auth(), method: 'POST', body: { badge: String(badge).trim() } });
    if (!state.waves.some(w => w.id === wave.id)) state.waves.unshift(wave);
    toast(`🤝 Connected with <b>${esc(wave.other.name)}</b>`);
    setTab('waves');
  } catch (err) {
    toast(`⚠️ ${esc(err.message)}`);
  }
}

async function downloadContacts() {
  const res = await api('/api/me/contacts.vcf', { ...auth(), raw: true });
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: `${code}-contacts.vcf` });
  a.click();
  URL.revokeObjectURL(url);
}

function renderMe(view) {
  const me = state.me;
  view.innerHTML = `
    <div class="badge-card" style="--c:${esc(me.color)}">
      ${avatar(me, { size: 'lg', style: 'margin:0 auto;border-color:#fff' })}
      <h2 style="margin:.6rem 0 0">${esc(me.name)}</h2>
      <div style="opacity:.9">${esc(me.headline)}${me.company ? ` · ${esc(me.company)}` : ''}</div>
      <div class="qr" id="my-qr"></div>
      <div class="small" style="opacity:.9">Let people scan this, or tell them your code</div>
      <div class="code">${esc(me.badge)}</div>
    </div>
    <div class="card" style="margin-top:1rem">
      <label class="row" style="margin:0"><span class="spacer">Open to chat<div class="hint">Turn off when you're in a deep conversation. You'll show as busy.</div></span>
        <input type="checkbox" id="open" style="width:22px;height:22px" ${me.openToChat ? 'checked' : ''}></label>
    </div>
    <div class="card" style="margin-top:1rem">
      <div class="section-title" style="margin-top:0">How people see you</div>
      <div class="spot">👀 ${esc(me.spotMe || 'Add how to spot you')}</div>
      <div class="tags" style="margin-top:.7rem">
        ${me.lookingFor.map(t => `<span class="tag need">needs ${esc(t)}</span>`).join('')}
        ${me.offering.map(t => `<span class="tag offer">offers ${esc(t)}</span>`).join('')}
        ${me.interests.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
      </div>
      <button class="btn-ghost btn-block" style="margin-top:1rem" id="edit">Edit profile</button>
    </div>
    <div style="margin-top:1rem">
      ${me.status === 'here'
        ? '<button class="btn-danger btn-block" id="leave">Leaving? Check out</button>'
        : '<button class="btn-good btn-block" id="back">I\'m back, check me in</button>'}
    </div>
    <p class="small muted" style="text-align:center;margin-top:1rem">Your email and LinkedIn are only visible to people you connect with.</p>`;

  fetch(`/api/events/${code}/qr.svg?connect=${me.badge}`).then(r => r.text()).then(svg => { const q = $('#my-qr'); if (q) q.innerHTML = svg; });
  $('#open').onchange = async e => { state.me = (await api('/api/me', { ...auth(), method: 'PATCH', body: { openToChat: e.target.checked } })).me; };
  $('#edit').onclick = openEditProfile;
  const leave = $('#leave');
  if (leave) leave.onclick = async () => {
    if (!confirm('Check out of the event? You can check back in anytime.')) return;
    state.me = (await api('/api/me/checkout', { ...auth(), method: 'POST' })).me;
    toast('You checked out. Your connections are saved.');
    renderView();
  };
  const back = $('#back');
  if (back) back.onclick = async () => { state.me = (await api('/api/me/checkin', { ...auth(), method: 'POST' })).me; renderView(); };
}

// ------------------------------------------------------------------ sheets

function openSheet(html) {
  closeSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `<div class="grab"></div>${html}`;
  backdrop.onclick = closeSheet;
  document.body.append(backdrop, sheet);
  document.body.style.overflow = 'hidden';
  return sheet;
}
function closeSheet() {
  $$('.sheet, .sheet-backdrop').forEach(n => n.remove());
  document.body.style.overflow = '';
}

function openEditProfile() {
  const sheet = openSheet(`<h2>Edit profile</h2>${profileForm(state.me, { submitLabel: 'Save' })}`);
  bindProfileForm(state.me, async profile => {
    state.me = (await api('/api/me', { ...auth(), method: 'PATCH', body: profile })).me;
    closeSheet();
    await loadMatches();
    renderView();
    toast('Profile updated. Your matches have been refreshed.');
  });
  sheet.scrollTop = 0;
}

function openPerson(id) {
  const p = state.attendees.get(id);
  if (!p) return;
  const match = state.matches.find(m => m.person.id === id);
  const wave = state.waves.find(w => w.other?.id === id);
  const connected = wave?.status === 'accepted';
  const mine = new Set([...state.me.interests, ...state.me.lookingFor, ...state.me.offering]);
  const hitTags = new Set(match?.reasons.flatMap(r => r.tags) || []);
  const tag = (t, cls, prefix = '') => `<span class="tag ${cls} ${mine.has(t) || hitTags.has(t) ? 'hit' : ''}">${prefix}${esc(t)}</span>`;

  let action;
  if (connected) action = `<button class="btn-warm btn-block" id="beacon-btn">🔆 Find each other</button>`;
  else if (wave?.direction === 'in' && wave.status === 'pending') action = `<div class="row"><button class="btn-good spacer" data-accept="${wave.id}">Accept their wave</button><button class="btn-ghost" data-decline="${wave.id}">Not now</button></div>`;
  else if (wave?.direction === 'out' && wave.status === 'pending') action = `<button class="btn-ghost btn-block" disabled>👋 Waved · waiting for them</button>`;
  else action = `<div class="row"><input id="wave-note" placeholder="Add a note (optional)" maxlength="200"><button id="wave-btn">👋 Wave</button></div>`;

  const sheet = openSheet(`
    <div class="row" style="gap:1rem;align-items:center">
      ${avatar(p, { size: 'lg', showOnline: true })}
      <div class="spacer">
        <h2 style="margin:0">${esc(p.name)}</h2>
        <div class="muted">${esc(p.headline)}${p.company ? ` · ${esc(p.company)}` : ''}</div>
        ${match ? `<span class="score" style="display:inline-block;margin-top:.35rem">${match.score}% match</span>` : ''}
      </div>
    </div>
    <div class="stack" style="margin-top:1rem">
      ${p.status === 'here'
        ? `<div class="spot">👀 <span><b>Spot them:</b> ${esc(p.spotMe || 'No description')}${p.zone ? `<br>📍 Last seen at <b>${esc(p.zone)}</b>` : ''}${p.openToChat ? '' : '<br>🔕 In a conversation right now'}</span></div>`
        : '<div class="spot">🚪 Left the event</div>'}
      ${match?.reasons.length ? `<div><div class="section-title" style="margin-top:.4rem">Why you should meet</div>${match.reasons.map(r => `<div class="reason">${esc(r.text)}</div>`).join('')}</div>` : ''}
      ${p.bio ? `<p style="margin:0">${esc(p.bio)}</p>` : ''}
      <div class="tags">
        ${p.lookingFor.map(t => tag(t, 'need', 'needs ')).join('')}
        ${p.offering.map(t => tag(t, 'offer', 'offers ')).join('')}
        ${p.interests.map(t => tag(t, '')).join('')}
      </div>
      <div id="ice-box"><button class="btn-soft btn-block" id="ice-btn">💬 What should I say?</button></div>
      ${action}
      ${connected ? `
        <div class="card" style="box-shadow:none">
          ${p.email ? `<div>✉ <a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div>` : ''}
          ${p.linkedin ? `<div>🔗 <a href="${esc(p.linkedin)}" target="_blank" rel="noopener">LinkedIn profile</a></div>` : ''}
          ${!p.email && !p.linkedin ? '<div class="muted small">No contact details shared.</div>' : ''}
          <label for="note" style="margin-top:.7rem">Private note</label>
          <textarea id="note" rows="2" placeholder="What did you talk about? Follow up on…">${esc(wave.myNote || '')}</textarea>
        </div>` : ''}
    </div>`);

  $('#ice-btn', sheet).onclick = async () => {
    $('#ice-box', sheet).innerHTML = '<div class="icebreaker muted">Thinking of a good opener…</div>';
    const { text, source } = await api(`/api/me/icebreaker/${id}`, auth());
    $('#ice-box', sheet).innerHTML = `<div class="icebreaker">“${esc(text)}”<div class="src">${source === 'ai' ? '✨ Written by Claude from both profiles' : 'Suggested from your match'}</div></div>`;
  };
  const waveBtn = $('#wave-btn', sheet);
  if (waveBtn) waveBtn.onclick = async () => {
    waveBtn.disabled = true;
    const { wave: w } = await api('/api/me/waves', { ...auth(), method: 'POST', body: { to: id, note: $('#wave-note', sheet).value } });
    if (!state.waves.some(x => x.id === w.id)) state.waves.unshift(w);
    else state.waves = state.waves.map(x => x.id === w.id ? { ...x, ...w } : x);
    toast(w.status === 'accepted' ? `🤝 You both waved, so you're connected with <b>${esc(p.name)}</b>` : `👋 Waved at ${esc(p.name)}. We'll let you know when they wave back.`);
    closeSheet();
    renderView();
  };
  $$('[data-accept]', sheet).forEach(b => b.onclick = async () => { await respond(b.dataset.accept, true); openPerson(id); });
  $$('[data-decline]', sheet).forEach(b => b.onclick = async () => { await respond(b.dataset.decline, false); closeSheet(); });
  const beaconBtn = $('#beacon-btn', sheet);
  if (beaconBtn) beaconBtn.onclick = () => { state.socket.emit('beacon', { to: id }); showBeacon(p, true); };
  const note = $('#note', sheet);
  if (note) note.onchange = () => {
    api(`/api/me/notes/${id}`, { ...auth(), method: 'PUT', body: { text: note.value } });
    wave.myNote = note.value;
  };
}

// Full-screen pulsing colour so two people can find each other across a room.
function showBeacon(other, initiated = false) {
  closeSheet();
  const me = state.me;
  const el = document.createElement('div');
  el.className = 'beacon';
  el.style.setProperty('--c', me.color);
  el.innerHTML = `
    <div style="font-size:4rem">${esc(me.emoji)}</div>
    <div class="big">${esc(me.name.split(' ')[0])}</div>
    <p style="font-size:1.1rem;max-width:420px;margin-top:1rem">Hold your phone up high. ${esc(other.name.split(' ')[0])} is looking for a <b>${COLOR_NAMES[me.color] || 'coloured'}</b> screen.</p>
    <p style="opacity:.9">They're wearing: ${esc(other.spotMe || '—')}${other.zone ? ` · near ${esc(other.zone)}` : ''}</p>
    <button>Found them ✓</button>`;
  el.querySelector('button').onclick = () => el.remove();
  document.body.append(el);
  if (!initiated) state.socket.emit('beacon', { to: other.id });
  if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate([200, 100, 200]);
}

boot();
