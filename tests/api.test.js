// End-to-end API flow against a real server instance on a random port.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
process.env.DISABLE_DEMO = '1';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { server, io } = require('../server/index');

let base;
test.before(() => new Promise(resolve => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); })));
test.after(() => { io.close(); server.close(); });

async function call(method, url, { body, token, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['x-organizer-key'] = key;
  const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

test('full event flow: create, check in, match, wave, connect, check out', async () => {
  const created = await call('POST', '/api/events', { body: { name: 'Test Mixer', zones: 'Bar, Patio' } });
  assert.equal(created.status, 201);
  const { code, organizerKey } = created.data;
  assert.match(code, /^[A-Z2-9]{6}$/);

  const ana = await call('POST', `/api/events/${code}/checkin`, { body: { name: 'Ana', lookingFor: ['fundraising'], spotMe: 'red hat', email: 'ana@x.io' } });
  const ben = await call('POST', `/api/events/${code}/checkin`, { body: { name: 'Ben', offering: ['fundraising'], spotMe: 'blue scarf', email: 'ben@x.io' } });
  assert.equal(ana.status, 201);
  const A = ana.data.token, B = ben.data.token;

  // Missing name is rejected.
  assert.equal((await call('POST', `/api/events/${code}/checkin`, { body: {} })).status, 400);

  // Ana's top match is Ben, with a reason; contact details are hidden until connected.
  const matches = (await call('GET', '/api/me/matches', { token: A })).data.matches;
  assert.equal(matches[0].person.name, 'Ben');
  assert.match(matches[0].reasons[0].text, /fundraising/);
  assert.equal(matches[0].person.email, undefined);

  // Zone update is validated against the event's zones.
  assert.equal((await call('PATCH', '/api/me', { token: A, body: { zone: 'Bar' } })).data.me.zone, 'Bar');
  assert.equal((await call('PATCH', '/api/me', { token: A, body: { zone: 'Moon' } })).data.me.zone, '');

  // Wave + accept => connected, and contact details become visible.
  const wave = (await call('POST', '/api/me/waves', { token: A, body: { to: ben.data.me.id, note: 'hi!' } })).data.wave;
  assert.equal(wave.status, 'pending');
  const accepted = (await call('POST', `/api/waves/${wave.id}/respond`, { token: B, body: { accept: true } })).data.wave;
  assert.equal(accepted.status, 'accepted');
  const list = (await call('GET', '/api/me/attendees', { token: A })).data.attendees;
  assert.equal(list.find(p => p.name === 'Ben').email, 'ben@x.io');

  // Badge connect creates an instant connection.
  const cara = await call('POST', `/api/events/${code}/checkin`, { body: { name: 'Cara' } });
  const byBadge = await call('POST', '/api/me/connect', { token: A, body: { badge: cara.data.me.badge } });
  assert.equal(byBadge.data.wave.status, 'accepted');
  assert.equal(byBadge.data.wave.via, 'badge');

  // vCard export contains both connections.
  const vcf = await call('GET', '/api/me/contacts.vcf', { token: A });
  assert.match(vcf.data, /FN:Ben/);
  assert.match(vcf.data, /FN:Cara/);

  // Icebreaker falls back to a template without credentials.
  const ice = (await call('GET', `/api/me/icebreaker/${ben.data.me.id}`, { token: A })).data;
  assert.equal(ice.source, 'template');
  assert.match(ice.text, /Ben/);

  // Organizer dashboard reflects everything; wrong key is rejected.
  assert.equal((await call('GET', `/api/org/${code}/dashboard`, { key: 'nope' })).status, 403);
  const dash = (await call('GET', `/api/org/${code}/dashboard`, { key: organizerKey })).data;
  assert.equal(dash.stats.here, 3);
  assert.equal(dash.stats.connections, 2);

  // Mixer round assigns everyone.
  const round = (await call('POST', `/api/org/${code}/rounds`, { key: organizerKey, body: { size: 3 } })).data.round;
  assert.equal(round.groups.flatMap(g => g.members).length, 3);

  // Checkout updates presence.
  await call('POST', '/api/me/checkout', { token: B });
  const after = (await call('GET', `/api/org/${code}/dashboard`, { key: organizerKey })).data.stats;
  assert.equal(after.here, 2);
  assert.equal(after.left, 1);

  const csv = await call('GET', `/api/org/${code}/export.csv`, { key: organizerKey });
  assert.match(csv.data, /"Ben".*"left"/);
});

test('unauthenticated requests are rejected', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/events/NOPE00')).status, 404);
});
