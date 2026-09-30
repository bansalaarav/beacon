// In-memory data store with debounced JSON snapshot persistence.
//
// Everything lives in Maps keyed by id so lookups are O(1). The store is the
// only module that mutates state; routes and sockets call its methods. To scale
// past a single process, swap this module for a Postgres/Redis-backed
// implementation with the same interface (see docs/ARCHITECTURE.md).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#84cc16', '#f43f5e',
];

const id = () => crypto.randomUUID();
const token = () => crypto.randomBytes(24).toString('base64url');

function eventCode() {
  // Unambiguous alphabet (no 0/O/1/I) so codes are easy to read aloud or off a screen.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

function normalizeTag(tag) {
  return String(tag || '')
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(list.map(normalizeTag).filter(Boolean))].slice(0, 15);
}

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

class Store {
  constructor() {
    this.events = new Map();     // id -> event
    this.codes = new Map();      // code -> event id
    this.attendees = new Map();  // id -> attendee
    this.tokens = new Map();     // token -> attendee id
    this.waves = new Map();      // id -> wave
    this.timeline = new Map();   // event id -> [{t, here}]
    this.saveTimer = null;
  }

  // ---------- persistence ----------

  load() {
    if (!fs.existsSync(DATA_FILE)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const e of raw.events || []) { this.events.set(e.id, e); this.codes.set(e.code, e.id); }
      for (const a of raw.attendees || []) { this.attendees.set(a.id, a); this.tokens.set(a.token, a.id); }
      for (const w of raw.waves || []) this.waves.set(w.id, w);
      for (const [k, v] of Object.entries(raw.timeline || {})) this.timeline.set(k, v);
    } catch (err) {
      console.error('Could not read data file, starting empty:', err.message);
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    const snapshot = {
      events: [...this.events.values()],
      attendees: [...this.attendees.values()],
      waves: [...this.waves.values()],
      timeline: Object.fromEntries(this.timeline),
    };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, DATA_FILE);
  }

  // ---------- events ----------

  createEvent({ name, description, venue, zones }) {
    let code;
    do { code = eventCode(); } while (this.codes.has(code));
    const event = {
      id: id(),
      code,
      name: clip(name, 80) || 'Untitled mixer',
      description: clip(description, 400),
      venue: clip(venue, 120),
      zones: normalizeZones(zones),
      organizerKey: token(),
      createdAt: Date.now(),
      announcements: [],
      rounds: [],
    };
    this.events.set(event.id, event);
    this.codes.set(code, event.id);
    this.timeline.set(event.id, []);
    this.save();
    return event;
  }

  eventByCode(code) {
    const eid = this.codes.get(String(code || '').toUpperCase());
    return eid ? this.events.get(eid) : null;
  }

  addAnnouncement(event, text) {
    const a = { id: id(), text: clip(text, 280), at: Date.now() };
    event.announcements.unshift(a);
    event.announcements = event.announcements.slice(0, 50);
    this.save();
    return a;
  }

  // ---------- attendees ----------

  checkIn(event, profile) {
    const existingColors = this.attendeesOf(event.id).map(a => a.color);
    const color = PALETTE.find(c => !existingColors.includes(c)) || PALETTE[crypto.randomInt(PALETTE.length)];
    const attendee = {
      id: id(),
      eventId: event.id,
      token: token(),
      badge: this.uniqueBadge(event.id),
      color,
      status: 'here',
      checkedInAt: Date.now(),
      checkedOutAt: null,
      lastSeen: profile.bot ? null : Date.now(),
      bot: !!profile.bot,
      openToChat: true,
      zone: '',
      notes: {},
      ...sanitizeProfile(profile),
    };
    this.attendees.set(attendee.id, attendee);
    this.tokens.set(attendee.token, attendee.id);
    this.recordTimeline(event.id);
    this.save();
    return attendee;
  }

  uniqueBadge(eventId) {
    const taken = new Set(this.attendeesOf(eventId).map(a => a.badge));
    let badge;
    do { badge = String(crypto.randomInt(1000, 10000)); } while (taken.has(badge));
    return badge;
  }

  attendeeByToken(t) {
    const aid = this.tokens.get(t);
    return aid ? this.attendees.get(aid) : null;
  }

  attendeesOf(eventId) {
    const out = [];
    for (const a of this.attendees.values()) if (a.eventId === eventId) out.push(a);
    return out;
  }

  presentOf(eventId) {
    return this.attendeesOf(eventId).filter(a => a.status === 'here');
  }

  updateAttendee(attendee, patch) {
    const clean = sanitizeProfile(patch, true);
    Object.assign(attendee, clean);
    if ('openToChat' in patch) attendee.openToChat = !!patch.openToChat;
    if ('zone' in patch) {
      const event = this.events.get(attendee.eventId);
      attendee.zone = event.zones.includes(patch.zone) ? patch.zone : '';
    }
    this.save();
    return attendee;
  }

  setStatus(attendee, status) {
    if (attendee.status === status) return attendee;
    attendee.status = status;
    if (status === 'left') attendee.checkedOutAt = Date.now();
    if (status === 'here') { attendee.checkedOutAt = null; attendee.lastSeen = Date.now(); }
    this.recordTimeline(attendee.eventId);
    this.save();
    return attendee;
  }

  recordTimeline(eventId) {
    const series = this.timeline.get(eventId) || [];
    series.push({ t: Date.now(), here: this.presentOf(eventId).length });
    this.timeline.set(eventId, series.slice(-2000));
  }

  setNote(attendee, otherId, text) {
    attendee.notes[otherId] = clip(text, 500);
    this.save();
  }

  // ---------- waves & connections ----------

  waveBetween(aId, bId) {
    for (const w of this.waves.values()) {
      if ((w.from === aId && w.to === bId) || (w.from === bId && w.to === aId)) return w;
    }
    return null;
  }

  createWave(from, to, note, { accepted = false, via = 'wave' } = {}) {
    const existing = this.waveBetween(from.id, to.id);
    if (existing) {
      // A wave in the opposite direction counts as acceptance: both people want to meet.
      if (existing.status === 'pending' && existing.to === from.id) {
        return this.respondWave(existing, true);
      }
      if (accepted && existing.status !== 'accepted') return this.respondWave(existing, true);
      return existing;
    }
    const wave = {
      id: id(),
      eventId: from.eventId,
      from: from.id,
      to: to.id,
      note: clip(note, 200),
      via,
      status: accepted ? 'accepted' : 'pending',
      createdAt: Date.now(),
      respondedAt: accepted ? Date.now() : null,
    };
    this.waves.set(wave.id, wave);
    this.save();
    return wave;
  }

  respondWave(wave, accept) {
    wave.status = accept ? 'accepted' : 'declined';
    wave.respondedAt = Date.now();
    this.save();
    return wave;
  }

  wavesOf(eventId) {
    const out = [];
    for (const w of this.waves.values()) if (w.eventId === eventId) out.push(w);
    return out;
  }

  wavesFor(attendeeId) {
    const out = [];
    for (const w of this.waves.values()) if (w.from === attendeeId || w.to === attendeeId) out.push(w);
    return out;
  }

  connectionIds(attendeeId) {
    const ids = new Set();
    for (const w of this.wavesFor(attendeeId)) {
      if (w.status === 'accepted') ids.add(w.from === attendeeId ? w.to : w.from);
    }
    return ids;
  }
}

function normalizeZones(zones) {
  const list = Array.isArray(zones) ? zones : String(zones || '').split(',');
  const clean = [...new Set(list.map(z => clip(z, 30)).filter(Boolean))].slice(0, 12);
  return clean.length ? clean : ['Entrance', 'Bar', 'Main floor', 'Patio'];
}

// Emoji like 🧑‍💼 are several code points joined together; slicing by length would split them.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function firstGrapheme(v) {
  const first = segmenter.segment(String(v ?? '').trim())[Symbol.iterator]().next().value;
  return first ? first.segment.slice(0, 16) : '👋';
}

function sanitizeProfile(p = {}, partial = false) {
  const out = {};
  const set = (key, fn) => { if (!partial || key in p) out[key] = fn(p[key]); };
  set('name', v => clip(v, 60) || 'Guest');
  set('headline', v => clip(v, 80));
  set('company', v => clip(v, 60));
  set('bio', v => clip(v, 400));
  set('interests', normalizeTags);
  set('lookingFor', normalizeTags);
  set('offering', normalizeTags);
  set('spotMe', v => clip(v, 80));
  set('emoji', firstGrapheme);
  set('linkedin', v => clip(v, 200));
  set('email', v => clip(v, 120));
  set('photo', v => (typeof v === 'string' && v.startsWith('data:image/') && v.length < 150_000 ? v : ''));
  return out;
}

module.exports = { Store, normalizeTag, normalizeTags, sanitizeProfile, PALETTE };
