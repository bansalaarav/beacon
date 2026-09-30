// Beacon server: REST API + Socket.IO real-time layer + static frontend.

const path = require('path');
// Load .env before anything reads process.env (Node >= 20.12 has this built in).
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env file, or older Node */ }
const os = require('os');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const { Store } = require('./store');
const matching = require('./matching');
const { icebreaker, aiEnabled } = require('./icebreakers');
const { seedDemo, Simulator } = require('./seed');

const PORT = Number(process.env.PORT) || 3000;
const AUTO_CHECKOUT_MINUTES = Number(process.env.AUTO_CHECKOUT_MINUTES) || 45;
const WALLFLOWER_MINUTES = 15;

const store = new Store();
store.load();
if (!process.env.DISABLE_DEMO && !store.eventByCode('DEMO24')) seedDemo(store);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json({ limit: '300kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ---------------------------------------------------------------- helpers

const sockets = new Map();    // attendee id -> number of open sockets
const activity = new Map();   // event id -> recent activity feed
const simulators = new Map(); // event id -> Simulator

const isOnline = a => a.bot || (sockets.get(a.id) || 0) > 0;

function publicView(a, { connected = false } = {}) {
  const view = {
    id: a.id, name: a.name, headline: a.headline, company: a.company, bio: a.bio,
    interests: a.interests, lookingFor: a.lookingFor, offering: a.offering,
    spotMe: a.spotMe, emoji: a.emoji, color: a.color,
    photo: a.photo ? `/api/photo/${a.id}` : '',
    status: a.status, zone: a.zone, openToChat: a.openToChat,
    checkedInAt: a.checkedInAt, online: isOnline(a),
  };
  if (connected) Object.assign(view, { linkedin: a.linkedin, email: a.email });
  return view;
}

function selfView(a) {
  const { token, notes, ...rest } = a;
  return { ...rest, photo: a.photo, online: true };
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

// QR codes must be scannable by phones, so never encode "localhost".
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.get('host') || `localhost:${PORT}`;
  if (/^(localhost|127\.0\.0\.1)/.test(host)) {
    const lan = lanAddress();
    if (lan) return `${req.protocol}://${lan}:${host.split(':')[1] || PORT}`;
  }
  return `${req.protocol}://${host}`;
}

function logActivity(event, type, text, extra = {}) {
  const feed = activity.get(event.id) || [];
  const item = { id: Date.now() + Math.random(), type, text, at: Date.now(), ...extra };
  feed.unshift(item);
  activity.set(event.id, feed.slice(0, 60));
  io.to(`org:${event.id}`).emit('activity', item);
  if (type === 'checkin' || type === 'connection') io.to(`kiosk:${event.id}`).emit('activity', item);
  scheduleStats(event);
}

const isConnectedFn = () => (a, b) => {
  const w = store.waveBetween(a, b);
  return !!w && w.status === 'accepted';
};

function stats(event) {
  const all = store.attendeesOf(event.id);
  const here = all.filter(a => a.status === 'here');
  const waves = store.wavesOf(event.id);
  const accepted = waves.filter(w => w.status === 'accepted');

  const degree = new Map();
  for (const w of accepted) {
    degree.set(w.from, (degree.get(w.from) || 0) + 1);
    degree.set(w.to, (degree.get(w.to) || 0) + 1);
  }

  const tagCounts = {};
  for (const a of here) for (const t of new Set([...a.interests, ...a.lookingFor, ...a.offering].map(matching.canonical))) {
    tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
  const zoneCounts = Object.fromEntries(event.zones.map(z => [z, 0]));
  let unplaced = 0;
  for (const a of here) a.zone in zoneCounts ? zoneCounts[a.zone]++ : unplaced++;

  const now = Date.now();
  const wallflowers = here
    .filter(a => !degree.get(a.id) && now - a.checkedInAt > WALLFLOWER_MINUTES * 60_000)
    .map(a => publicView(a));

  const needs = {}, offers = {};
  for (const a of here) {
    for (const t of a.lookingFor.map(matching.canonical)) needs[t] = (needs[t] || 0) + 1;
    for (const t of a.offering.map(matching.canonical)) offers[t] = (offers[t] || 0) + 1;
  }
  // Supply/demand gaps: things lots of people want that few can offer.
  const gaps = Object.entries(needs)
    .map(([tag, n]) => ({ tag, want: n, offer: offers[tag] || 0 }))
    .sort((x, y) => (y.want - y.offer) - (x.want - x.offer))
    .slice(0, 6);

  return {
    here: here.length,
    total: all.length,
    left: all.length - here.length,
    online: here.filter(isOnline).length,
    connections: accepted.length,
    waves: waves.length,
    pendingWaves: waves.filter(w => w.status === 'pending').length,
    avgConnections: here.length ? +(2 * accepted.length / Math.max(all.length, 1)).toFixed(1) : 0,
    connectedPct: all.length ? Math.round(100 * [...degree.keys()].length / all.length) : 0,
    topTags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 18),
    zones: zoneCounts,
    unplaced,
    wallflowers,
    gaps,
    timeline: (store.timeline.get(event.id) || []).slice(-300),
  };
}

const statsTimers = new Map();
function scheduleStats(event) {
  if (statsTimers.has(event.id)) return;
  statsTimers.set(event.id, setTimeout(() => {
    statsTimers.delete(event.id);
    const s = stats(event);
    io.to(`org:${event.id}`).emit('stats', s);
    io.to(`kiosk:${event.id}`).emit('stats', kioskView(event, s));
  }, 400));
}

function kioskView(event, s = stats(event)) {
  const recent = store.presentOf(event.id)
    .sort((a, b) => b.checkedInAt - a.checkedInAt)
    .slice(0, 12)
    .map(a => ({ name: a.name, headline: a.headline, emoji: a.emoji, color: a.color, photo: a.photo ? `/api/photo/${a.id}` : '' }));
  return { here: s.here, connections: s.connections, topTags: s.topTags.slice(0, 12), recent, announcement: event.announcements[0] || null };
}

function broadcastAttendee(a) {
  const event = store.events.get(a.eventId);
  // Contact details are only revealed to connections, so each connection gets its own copy.
  io.to(`event:${a.eventId}`).except([...store.connectionIds(a.id)].map(id => `a:${id}`))
    .emit('attendee:upsert', publicView(a));
  for (const cid of store.connectionIds(a.id)) io.to(`a:${cid}`).emit('attendee:upsert', publicView(a, { connected: true }));
  io.to(`a:${a.id}`).emit('me', selfView(a));
  scheduleStats(event);
}

function waveView(w, viewerId) {
  const otherId = w.from === viewerId ? w.to : w.from;
  const other = store.attendees.get(otherId);
  return {
    id: w.id, status: w.status, note: w.note, via: w.via, createdAt: w.createdAt, respondedAt: w.respondedAt,
    direction: w.from === viewerId ? 'out' : 'in',
    other: other ? publicView(other, { connected: w.status === 'accepted' }) : null,
  };
}

function emitWave(w) {
  io.to(`a:${w.from}`).emit('wave', waveView(w, w.from));
  io.to(`a:${w.to}`).emit('wave', waveView(w, w.to));
  const event = store.events.get(w.eventId);
  const from = store.attendees.get(w.from), to = store.attendees.get(w.to);
  if (w.status === 'accepted') {
    // Now connected: push the contact-bearing profile to each side.
    io.to(`a:${w.from}`).emit('attendee:upsert', publicView(to, { connected: true }));
    io.to(`a:${w.to}`).emit('attendee:upsert', publicView(from, { connected: true }));
    logActivity(event, 'connection', `${from.name} ↔ ${to.name} connected${w.via === 'badge' ? ' in person' : ''}`);
  } else if (w.status === 'pending') {
    logActivity(event, 'wave', `${from.name} waved at ${to.name}`);
  } else {
    scheduleStats(event);
  }
  const sim = simulators.get(w.eventId);
  if (sim) sim.onWave(w);
}

// ---------------------------------------------------------------- middleware

function attendeeAuth(req, res, next) {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = t && store.attendeeByToken(t);
  if (!a) return res.status(401).json({ error: 'Not checked in' });
  req.attendee = a;
  req.event = store.events.get(a.eventId);
  a.lastSeen = Date.now();
  next();
}

function organizerAuth(req, res, next) {
  const event = store.eventByCode(req.params.code);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (req.get('x-organizer-key') !== event.organizerKey) return res.status(403).json({ error: 'Invalid organizer key' });
  req.event = event;
  next();
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- pages

const page = file => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', file));
app.get('/e/:code', page('event.html'));
app.get('/o/:code', page('organizer.html'));
app.get('/k/:code', page('kiosk.html'));

// ---------------------------------------------------------------- public API

app.get('/api/health', (req, res) => res.json({ ok: true, ai: aiEnabled }));

app.post('/api/events', (req, res) => {
  const event = store.createEvent(req.body || {});
  res.status(201).json({ code: event.code, organizerKey: event.organizerKey });
});

app.get('/api/events/:code', (req, res) => {
  const event = store.eventByCode(req.params.code);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json({
    code: event.code, name: event.name, description: event.description, venue: event.venue,
    zones: event.zones, here: store.presentOf(event.id).length, joinUrl: `${baseUrl(req)}/e/${event.code}`,
  });
});

app.get('/api/events/:code/qr.svg', wrap(async (req, res) => {
  const event = store.eventByCode(req.params.code);
  if (!event) return res.status(404).end();
  let url = `${baseUrl(req)}/e/${event.code}`;
  if (req.query.connect && /^\d{4}$/.test(req.query.connect)) url += `?connect=${req.query.connect}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(svg);
}));

app.get('/api/photo/:id', (req, res) => {
  const a = store.attendees.get(req.params.id);
  if (!a || !a.photo) return res.status(404).end();
  const [, mime, data] = a.photo.match(/^data:(image\/[a-z+]+);base64,(.*)$/) || [];
  if (!data) return res.status(404).end();
  res.type(mime).set('Cache-Control', 'private, max-age=60').send(Buffer.from(data, 'base64'));
});

app.post('/api/events/:code/checkin', (req, res) => {
  const event = store.eventByCode(req.params.code);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const body = req.body || {};
  if (!String(body.name || '').trim()) return res.status(400).json({ error: 'Name is required' });
  const { bot, ...profile } = body;
  const a = store.checkIn(event, profile);
  broadcastAttendee(a);
  logActivity(event, 'checkin', `${a.name} checked in`, { attendeeId: a.id });
  res.status(201).json({ token: a.token, me: selfView(a) });
});

// ---------------------------------------------------------------- attendee API

app.get('/api/me', attendeeAuth, (req, res) => {
  const e = req.event;
  res.json({
    me: selfView(req.attendee),
    event: { code: e.code, name: e.name, description: e.description, venue: e.venue, zones: e.zones,
      announcements: e.announcements.slice(0, 5), round: latestRoundFor(e, req.attendee.id) },
    ai: aiEnabled,
  });
});

app.patch('/api/me', attendeeAuth, (req, res) => {
  const a = store.updateAttendee(req.attendee, req.body || {});
  broadcastAttendee(a);
  res.json({ me: selfView(a) });
});

app.post('/api/me/checkout', attendeeAuth, (req, res) => {
  const a = store.setStatus(req.attendee, 'left');
  broadcastAttendee(a);
  logActivity(req.event, 'checkout', `${a.name} left`, { attendeeId: a.id });
  res.json({ me: selfView(a) });
});

app.post('/api/me/checkin', attendeeAuth, (req, res) => {
  const a = store.setStatus(req.attendee, 'here');
  broadcastAttendee(a);
  logActivity(req.event, 'checkin', `${a.name} is back`, { attendeeId: a.id });
  res.json({ me: selfView(a) });
});

app.get('/api/me/attendees', attendeeAuth, (req, res) => {
  const connected = store.connectionIds(req.attendee.id);
  const list = store.attendeesOf(req.event.id)
    .filter(a => a.id !== req.attendee.id)
    .map(a => publicView(a, { connected: connected.has(a.id) }));
  res.json({ attendees: list });
});

app.get('/api/me/matches', attendeeAuth, (req, res) => {
  const me = req.attendee;
  const present = store.presentOf(req.event.id);
  if (!present.some(p => p.id === me.id)) present.push(me);
  const connected = store.connectionIds(me.id);
  const ranked = matching.rankFor(me, present, { limit: 25 });
  res.json({
    matches: ranked.map(m => ({
      person: publicView(m.person, { connected: connected.has(m.person.id) }),
      score: m.score,
      reasons: m.reasons.map(r => ({ kind: r.kind, text: r.text, tags: r.tags })),
      connected: connected.has(m.person.id),
      wave: (w => w && waveView(w, me.id))(store.waveBetween(me.id, m.person.id)),
    })),
  });
});

app.get('/api/me/icebreaker/:id', attendeeAuth, wrap(async (req, res) => {
  const other = store.attendees.get(req.params.id);
  if (!other || other.eventId !== req.event.id) return res.status(404).json({ error: 'Not found' });
  const people = store.attendeesOf(req.event.id);
  const { reasons } = matching.scorePair(req.attendee, other, matching.buildContext(people));
  res.json(await icebreaker(req.attendee, other, reasons));
}));

app.get('/api/me/waves', attendeeAuth, (req, res) => {
  const waves = store.wavesFor(req.attendee.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(w => ({ ...waveView(w, req.attendee.id), myNote: req.attendee.notes[w.from === req.attendee.id ? w.to : w.from] || '' }));
  res.json({ waves });
});

app.post('/api/me/waves', attendeeAuth, (req, res) => {
  const to = store.attendees.get(req.body?.to);
  if (!to || to.eventId !== req.event.id || to.id === req.attendee.id) return res.status(400).json({ error: 'Invalid attendee' });
  const w = store.createWave(req.attendee, to, req.body.note);
  emitWave(w);
  res.status(201).json({ wave: waveView(w, req.attendee.id) });
});

app.post('/api/waves/:id/respond', attendeeAuth, (req, res) => {
  const w = store.waves.get(req.params.id);
  if (!w || w.to !== req.attendee.id) return res.status(404).json({ error: 'Wave not found' });
  if (w.status !== 'pending') return res.json({ wave: waveView(w, req.attendee.id) });
  store.respondWave(w, !!req.body?.accept);
  emitWave(w);
  res.json({ wave: waveView(w, req.attendee.id) });
});

// Scanning someone's badge QR (or typing their 4-digit code) = instant mutual connection.
app.post('/api/me/connect', attendeeAuth, (req, res) => {
  const badge = String(req.body?.badge || '').trim();
  const other = store.attendeesOf(req.event.id).find(a => a.badge === badge);
  if (!other || other.id === req.attendee.id) return res.status(404).json({ error: 'No attendee with that badge code' });
  const w = store.createWave(req.attendee, other, '', { accepted: true, via: 'badge' });
  emitWave(w);
  res.json({ wave: waveView(w, req.attendee.id) });
});

app.put('/api/me/notes/:id', attendeeAuth, (req, res) => {
  store.setNote(req.attendee, req.params.id, req.body?.text);
  res.json({ ok: true });
});

app.get('/api/me/contacts.vcf', attendeeAuth, (req, res) => {
  const esc = s => String(s || '').replace(/[,;\\]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const cards = [...store.connectionIds(req.attendee.id)].map(id => store.attendees.get(id)).filter(Boolean).map(a => [
    'BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(a.name)}`,
    a.company && `ORG:${esc(a.company)}`, a.headline && `TITLE:${esc(a.headline)}`,
    a.email && `EMAIL:${esc(a.email)}`, a.linkedin && `URL:${esc(a.linkedin)}`,
    `NOTE:${esc(`Met at ${req.event.name}. ${req.attendee.notes[a.id] || ''}`.trim())}`,
    'END:VCARD',
  ].filter(Boolean).join('\r\n'));
  res.type('text/vcard').attachment(`${req.event.code}-contacts.vcf`).send(cards.join('\r\n'));
});

function latestRoundFor(event, attendeeId) {
  const round = event.rounds[event.rounds.length - 1];
  if (!round || Date.now() - round.at > 30 * 60_000) return null;
  const idx = round.groups.findIndex(g => g.members.includes(attendeeId));
  if (idx < 0) return null;
  const g = round.groups[idx];
  return {
    n: round.n, at: round.at, table: g.table, topic: g.topic,
    members: g.members.filter(m => m !== attendeeId).map(m => store.attendees.get(m)).filter(Boolean).map(m => publicView(m)),
  };
}

// ---------------------------------------------------------------- organizer API

app.get('/api/org/:code/dashboard', organizerAuth, (req, res) => {
  const e = req.event;
  res.json({
    event: { code: e.code, name: e.name, description: e.description, venue: e.venue, zones: e.zones,
      announcements: e.announcements, demo: !!e.demo, simulating: simulators.has(e.id), rounds: e.rounds.length },
    stats: stats(e),
    activity: activity.get(e.id) || [],
    attendees: store.attendeesOf(e.id).map(a => ({
      ...publicView(a), connections: store.connectionIds(a.id).size, checkedOutAt: a.checkedOutAt,
    })),
    ai: aiEnabled,
    joinUrl: `${baseUrl(req)}/e/${e.code}`,
  });
});

app.get('/api/org/:code/suggestions', organizerAuth, (req, res) => {
  const present = store.presentOf(req.event.id);
  const focus = req.query.for && store.attendees.get(req.query.for);
  if (focus && focus.eventId === req.event.id) {
    // Best people for one specific attendee (e.g. someone nobody has talked to yet).
    const ranked = matching.rankFor(focus, present, { limit: 3, exclude: store.connectionIds(focus.id) });
    return res.json({ pairs: ranked.map(m => ({ a: publicView(focus), b: publicView(m.person), score: m.score, reason: m.reasons[0]?.text || '' })) });
  }
  const pairs = matching.topUnmetPairs(present, isConnectedFn(), { limit: 8 });
  res.json({ pairs: pairs.map(p => ({ a: publicView(p.a), b: publicView(p.b), score: p.score, reason: p.reasons[0]?.text || '' })) });
});

app.post('/api/org/:code/announce', organizerAuth, (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty announcement' });
  const a = store.addAnnouncement(req.event, text);
  io.to(`event:${req.event.id}`).emit('announcement', a);
  io.to(`kiosk:${req.event.id}`).emit('announcement', a);
  logActivity(req.event, 'announce', `📣 ${a.text}`);
  res.json({ announcement: a });
});

app.post('/api/org/:code/introduce', organizerAuth, (req, res) => {
  const a = store.attendees.get(req.body?.a), b = store.attendees.get(req.body?.b);
  if (!a || !b || a.eventId !== req.event.id || b.eventId !== req.event.id) return res.status(400).json({ error: 'Invalid attendees' });
  const ctx = matching.buildContext(store.attendeesOf(req.event.id));
  const note = String(req.body?.note || '').slice(0, 200);
  io.to(`a:${a.id}`).emit('intro', { person: publicView(b), reasons: matching.scorePair(a, b, ctx).reasons.slice(0, 3).map(r => r.text), note });
  io.to(`a:${b.id}`).emit('intro', { person: publicView(a), reasons: matching.scorePair(b, a, ctx).reasons.slice(0, 3).map(r => r.text), note });
  logActivity(req.event, 'intro', `🤝 Organizer introduced ${a.name} and ${b.name}`);
  res.json({ ok: true });
});

app.post('/api/org/:code/rounds', organizerAuth, (req, res) => {
  const e = req.event;
  const size = Math.min(Math.max(Number(req.body?.size) || 4, 2), 10);
  const people = store.presentOf(e.id).filter(a => a.openToChat);
  if (people.length < 2) return res.status(400).json({ error: 'Need at least 2 attendees open to chat' });
  const groups = matching.buildGroups(people, size, isConnectedFn());
  const round = {
    n: e.rounds.length + 1,
    at: Date.now(),
    groups: groups.map((g, i) => {
      // Conversation topic: the most common canonical tag within the group.
      const counts = {};
      for (const m of g) for (const t of new Set([...m.interests, ...m.lookingFor, ...m.offering].map(matching.canonical))) counts[t] = (counts[t] || 0) + 1;
      const topic = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0] || 'what brought you here';
      return { table: `Table ${i + 1}`, topic, members: g.map(m => m.id) };
    }),
  };
  e.rounds.push(round);
  store.save();
  for (const g of round.groups) for (const m of g.members) io.to(`a:${m}`).emit('round', latestRoundFor(e, m));
  logActivity(e, 'round', `🔀 Mixer round ${round.n}: ${round.groups.length} groups of ~${size}`);
  res.json({ round: { ...round, groups: round.groups.map(g => ({ ...g, members: g.members.map(m => store.attendees.get(m).name) })) } });
});

app.post('/api/org/:code/attendees/:id/status', organizerAuth, (req, res) => {
  const a = store.attendees.get(req.params.id);
  if (!a || a.eventId !== req.event.id) return res.status(404).json({ error: 'Not found' });
  store.setStatus(a, req.body?.status === 'here' ? 'here' : 'left');
  broadcastAttendee(a);
  logActivity(req.event, a.status === 'here' ? 'checkin' : 'checkout', `${a.name} ${a.status === 'here' ? 'checked in' : 'checked out'} by organizer`);
  res.json({ ok: true });
});

app.get('/api/org/:code/export.csv', organizerAuth, (req, res) => {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['name', 'headline', 'company', 'email', 'status', 'zone', 'checked_in', 'checked_out', 'connections', 'interests', 'looking_for', 'offering']];
  for (const a of store.attendeesOf(req.event.id)) {
    rows.push([a.name, a.headline, a.company, a.email, a.status, a.zone,
      new Date(a.checkedInAt).toISOString(), a.checkedOutAt ? new Date(a.checkedOutAt).toISOString() : '',
      store.connectionIds(a.id).size, a.interests.join('; '), a.lookingFor.join('; '), a.offering.join('; ')]);
  }
  res.type('text/csv').attachment(`${req.event.code}-attendance.csv`).send(rows.map(r => r.map(q).join(',')).join('\n'));
});

app.post('/api/org/:code/simulate', organizerAuth, (req, res) => {
  const e = req.event;
  if (!e.demo) return res.status(400).json({ error: 'Simulation is only available for the demo event' });
  if (simulators.has(e.id)) {
    simulators.get(e.id).stop();
    simulators.delete(e.id);
  } else {
    const sim = new Simulator(store, e, {
      onUpsert: broadcastAttendee,
      onWave: emitWave,
      onActivity: (type, text) => logActivity(e, type, text),
    });
    simulators.set(e.id, sim);
    sim.start();
  }
  res.json({ simulating: simulators.has(e.id) });
});

app.get('/api/kiosk/:code', (req, res) => {
  const e = store.eventByCode(req.params.code);
  if (!e) return res.status(404).json({ error: 'Event not found' });
  res.json({ event: { code: e.code, name: e.name, venue: e.venue }, joinUrl: `${baseUrl(req)}/e/${e.code}`, ...kioskView(e) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

// ---------------------------------------------------------------- sockets

io.on('connection', socket => {
  const { token, organizerKey, code, kiosk } = socket.handshake.auth || {};

  if (token) {
    const a = store.attendeeByToken(token);
    if (!a) return socket.disconnect(true);
    socket.join([`event:${a.eventId}`, `a:${a.id}`]);
    sockets.set(a.id, (sockets.get(a.id) || 0) + 1);
    a.lastSeen = Date.now();
    if (sockets.get(a.id) === 1) broadcastAttendee(a);

    socket.on('heartbeat', () => { a.lastSeen = Date.now(); });

    // "Find me" beacon: both phones flash the same colour so two strangers can spot each other.
    socket.on('beacon', ({ to } = {}) => {
      const other = store.attendees.get(to);
      if (!other || other.eventId !== a.eventId) return;
      io.to(`a:${other.id}`).emit('beacon', { from: publicView(a), color: a.color });
    });

    socket.on('disconnect', () => {
      const n = (sockets.get(a.id) || 1) - 1;
      n ? sockets.set(a.id, n) : sockets.delete(a.id);
      a.lastSeen = Date.now();
      if (!n) broadcastAttendee(a);
    });
    return;
  }

  const event = store.eventByCode(code);
  if (!event) return socket.disconnect(true);
  if (organizerKey && organizerKey === event.organizerKey) {
    socket.join(`org:${event.id}`);
  } else if (kiosk) {
    socket.join(`kiosk:${event.id}`);
  } else {
    socket.disconnect(true);
  }
});

// Attendees who closed the app and haven't been seen in a while are checked out automatically,
// so the "here now" list reflects reality even when people forget to tap "Leave".
setInterval(() => {
  const cutoff = Date.now() - AUTO_CHECKOUT_MINUTES * 60_000;
  for (const a of store.attendees.values()) {
    if (a.status === 'here' && !a.bot && !sockets.get(a.id) && a.lastSeen && a.lastSeen < cutoff) {
      store.setStatus(a, 'left');
      broadcastAttendee(a);
      logActivity(store.events.get(a.eventId), 'checkout', `${a.name} left (inactive)`);
    }
  }
  for (const e of store.events.values()) {
    const series = store.timeline.get(e.id) || [];
    const last = series[series.length - 1];
    if (!last || Date.now() - last.t > 60_000) store.recordTimeline(e.id);
  }
}, 60_000).unref();

process.on('SIGINT', () => { store.flush(); process.exit(0); });
process.on('SIGTERM', () => { store.flush(); process.exit(0); });

if (require.main === module || process.env.BEACON_LISTEN) server.listen(PORT, () => {
  const lan = lanAddress();
  console.log(`\n  Beacon is running`);
  console.log(`  Local:    http://localhost:${PORT}`);
  if (lan) console.log(`  Network:  http://${lan}:${PORT}   (open this on phones on the same Wi-Fi)`);
  console.log(`  Demo:     http://localhost:${PORT}/o/DEMO24#key=demo-organizer-key`);
  console.log(`  AI icebreakers: ${aiEnabled ? 'Claude (' + (process.env.BEACON_MODEL || 'claude-opus-5-5') + ')' : 'templates (set ANTHROPIC_API_KEY to enable Claude)'}\n`);
});

module.exports = { app, server, io, store };
