const test = require('node:test');
const assert = require('node:assert/strict');
const { canonical, buildContext, scorePair, rankFor, buildGroups, topUnmetPairs } = require('../server/matching');

let n = 0;
const person = p => ({
  id: `p${++n}`, name: `Person ${n}`, headline: '', company: '', bio: '',
  interests: [], lookingFor: [], offering: [], ...p,
});

test('canonical folds synonyms and plurals', () => {
  assert.equal(canonical('ML'), 'machine learning');
  assert.equal(canonical('#Startups'), 'startup');
  assert.equal(canonical('Investors'), 'venture capital');
  assert.equal(canonical('mentors'), 'mentorship');
  assert.equal(canonical('internships'), 'internships');
});

test('need -> offer is the strongest signal and is explained', () => {
  const founder = person({ lookingFor: ['fundraising'] });
  const investor = person({ offering: ['fundraising'] });
  const bystander = person({ interests: ['music'] });
  const ctx = buildContext([founder, investor, bystander]);

  const m = scorePair(founder, investor, ctx);
  assert.ok(m.score > 20, `expected a meaningful score, got ${m.score}`);
  assert.equal(m.reasons[0].kind, 'need');
  assert.match(m.reasons[0].text, /fundraising/);
  assert.equal(scorePair(founder, bystander, ctx).score, 0);
});

test('matching is asymmetric: helping someone scores lower than being helped', () => {
  const a = person({ lookingFor: ['design'] });
  const b = person({ offering: ['design'] });
  const ctx = buildContext([a, b]);
  assert.ok(scorePair(a, b, ctx).raw > scorePair(b, a, ctx).raw);
  assert.equal(scorePair(b, a, ctx).reasons[0].kind, 'give');
});

test('rare shared interests outweigh common ones', () => {
  const crowd = Array.from({ length: 10 }, () => person({ interests: ['llms'] }));
  const me = person({ interests: ['llms', 'beekeeping'] });
  const common = crowd[0];
  const rare = person({ interests: ['beekeeping'] });
  const ctx = buildContext([...crowd, me, rare]);
  assert.ok(scorePair(me, rare, ctx).raw > scorePair(me, common, ctx).raw);
  assert.match(scorePair(me, rare, ctx).reasons[0].text, /only 2 people/);
});

test('colleagues are down-ranked', () => {
  const me = person({ company: 'Acme', interests: ['rust'] });
  const colleague = person({ company: 'acme', interests: ['rust'] });
  const stranger = person({ company: 'Other', interests: ['rust'] });
  const ctx = buildContext([me, colleague, stranger]);
  assert.ok(scorePair(me, stranger, ctx).score > scorePair(me, colleague, ctx).score);
});

test('rankFor sorts by score and honours exclusions', () => {
  const me = person({ lookingFor: ['co-founder', 'fundraising'], interests: ['climate tech'] });
  const best = person({ offering: ['fundraising'], lookingFor: ['co-founder'], interests: ['climate tech'] });
  const ok = person({ interests: ['climate tech'] });
  const none = person({ interests: ['knitting'] });
  const ranked = rankFor(me, [me, best, ok, none]);
  assert.deepEqual(ranked.map(r => r.person.id), [best.id, ok.id]);
  assert.deepEqual(rankFor(me, [me, best, ok], { exclude: new Set([best.id]) }).map(r => r.person.id), [ok.id]);
});

test('buildGroups puts everyone in exactly one group of roughly the right size', () => {
  const people = Array.from({ length: 17 }, (_, i) => person({ interests: [i % 2 ? 'design' : 'data'] }));
  const groups = buildGroups(people, 4, () => false);
  const ids = groups.flat().map(p => p.id).sort();
  assert.deepEqual(ids, people.map(p => p.id).sort());
  for (const g of groups) assert.ok(g.length >= 3 && g.length <= 6, `group size ${g.length}`);
});

test('topUnmetPairs skips pairs who already connected', () => {
  const a = person({ lookingFor: ['design'] });
  const b = person({ offering: ['design'] });
  const c = person({ offering: ['design'] });
  const pairs = topUnmetPairs([a, b, c], (x, y) => [x, y].sort().join() === [a.id, b.id].sort().join());
  assert.ok(pairs.length >= 1);
  assert.ok(pairs.every(p => !([p.a.id, p.b.id].includes(a.id) && [p.a.id, p.b.id].includes(b.id))));
});

test('scales: ranking 2,000 attendees is fast', () => {
  const tags = ['ai', 'design', 'fintech', 'climate', 'web3', 'data', 'frontend', 'backend', 'jobs', 'mentorship', 'sales', 'hardware'];
  const r = i => tags[(i * 7 + 3) % tags.length];
  const people = Array.from({ length: 2000 }, (_, i) => person({
    interests: [r(i), r(i + 1)], lookingFor: [r(i + 2)], offering: [r(i + 5)], bio: `I work on ${r(i)} and ${r(i + 4)}`,
  }));
  const start = performance.now();
  const ctx = buildContext(people);
  for (let i = 0; i < 20; i++) rankFor(people[i], people, { ctx });
  const ms = performance.now() - start;
  assert.ok(ms < 3000, `took ${ms.toFixed(0)}ms`);
});
