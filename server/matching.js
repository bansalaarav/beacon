// Explainable matching engine.
//
// For a viewer A and a candidate B we compute a score from four signals and
// keep a human-readable reason for each one, so the UI can say *why* two
// people should meet instead of showing an opaque number:
//
//   1. Need -> offer   A is looking for something B offers        (strongest)
//   2. Offer -> need   B is looking for something A offers        (you can help them)
//   3. Shared interests, weighted by rarity (IDF) — two people who both like
//      "quantum computing" at a web-dev meetup is a stronger signal than two
//      people who both like "ai" when half the room does.
//   4. Free-text similarity of bio + headline (TF-IDF cosine).
//
// Scalability: candidates are generated from an inverted tag index, so each
// viewer is only scored against people who share at least one tag (plus a
// small random sample for serendipity), not the whole room.

const { normalizeTag } = require('./store');

// Collapse common synonyms so "ML" and "machine learning" match.
const ALIASES = {
  ml: 'machine learning', ai: 'artificial intelligence', 'a.i.': 'artificial intelligence',
  llm: 'llms', llms: 'llms', 'large language models': 'llms', genai: 'generative ai',
  ux: 'design', ui: 'design', 'ui/ux': 'design', 'product design': 'design',
  vc: 'venture capital', investing: 'venture capital', investors: 'venture capital', investor: 'venture capital',
  'fund raising': 'fundraising', 'raising money': 'fundraising', seed: 'fundraising',
  cofounder: 'co-founder', 'co founder': 'co-founder', cofounders: 'co-founder',
  js: 'javascript', ts: 'typescript', react: 'frontend', 'front-end': 'frontend', 'back-end': 'backend',
  mentor: 'mentorship', mentoring: 'mentorship', mentors: 'mentorship',
  job: 'jobs', hiring: 'jobs', 'job search': 'jobs', internship: 'internships',
  crypto: 'web3', blockchain: 'web3', climate: 'climate tech', sustainability: 'climate tech',
  'data science': 'data', analytics: 'data', dev: 'engineering', developers: 'engineering',
  'growth marketing': 'marketing', gtm: 'go-to-market', sales: 'go-to-market',
};

function canonical(tag) {
  const t = normalizeTag(tag);
  if (ALIASES[t]) return ALIASES[t];
  // cheap plural folding: "startups" -> "startup"
  if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) {
    const singular = t.slice(0, -1);
    return ALIASES[singular] || singular;
  }
  return t;
}

const STOPWORDS = new Set(('a an and are as at be but by for from has have i i\'m im in is it its me my of on or ' +
  'our so that the their this to was we with you your about into love like work working currently ' +
  'based also who what when where how all am been can do more most not now just very').split(' '));

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

const set = arr => new Set((arr || []).map(canonical));

// Precompute per-event statistics once per request batch.
function buildContext(people) {
  const n = Math.max(people.length, 1);
  const df = new Map();       // tag -> number of people mentioning it anywhere
  const wordDf = new Map();   // word -> number of bios containing it
  const index = new Map();    // tag -> Set(attendee id)
  const profiles = new Map(); // id -> derived profile

  for (const p of people) {
    const interests = set(p.interests);
    const lookingFor = set(p.lookingFor);
    const offering = set(p.offering);
    const all = new Set([...interests, ...lookingFor, ...offering]);
    for (const t of all) {
      df.set(t, (df.get(t) || 0) + 1);
      if (!index.has(t)) index.set(t, new Set());
      index.get(t).add(p.id);
    }
    const words = tokenize(`${p.headline} ${p.bio}`); // company is handled separately (colleague penalty)
    for (const w of new Set(words)) wordDf.set(w, (wordDf.get(w) || 0) + 1);
    profiles.set(p.id, { interests, lookingFor, offering, all, words });
  }

  // IDF normalised to ~[0.5, 1.5]: rare tags matter more, but common tags still count.
  const idf = tag => {
    const d = df.get(tag) || 1;
    return 0.5 + Math.log(1 + n / d) / Math.log(1 + n);
  };

  const vectors = new Map();
  for (const [pid, prof] of profiles) {
    const tf = new Map();
    for (const w of prof.words) tf.set(w, (tf.get(w) || 0) + 1);
    const vec = new Map();
    let norm = 0;
    for (const [w, c] of tf) {
      const weight = c * Math.log(1 + n / (wordDf.get(w) || 1));
      vec.set(w, weight);
      norm += weight * weight;
    }
    vectors.set(pid, { vec, norm: Math.sqrt(norm) || 1 });
  }

  return { n, df, idf, index, profiles, vectors };
}

function cosine(a, b) {
  let dot = 0;
  const [small, large] = a.vec.size < b.vec.size ? [a, b] : [b, a];
  for (const [w, x] of small.vec) {
    const y = large.vec.get(w);
    if (y) dot += x * y;
  }
  return dot / (a.norm * b.norm);
}

function pretty(tag) {
  return tag;
}

function scorePair(viewer, other, ctx) {
  const A = ctx.profiles.get(viewer.id);
  const B = ctx.profiles.get(other.id);
  if (!A || !B) return { score: 0, raw: 0, reasons: [], shared: [] };

  const reasons = [];
  let raw = 0;

  const needs = [...A.lookingFor].filter(t => B.offering.has(t));
  if (needs.length) {
    const w = needs.reduce((s, t) => s + 3 * ctx.idf(t), 0);
    raw += w;
    reasons.push({ kind: 'need', weight: w, tags: needs,
      text: `Can help with what you're looking for: ${needs.map(pretty).join(', ')}` });
  }

  const gives = [...B.lookingFor].filter(t => A.offering.has(t));
  if (gives.length) {
    const w = gives.reduce((s, t) => s + 2 * ctx.idf(t), 0);
    raw += w;
    reasons.push({ kind: 'give', weight: w, tags: gives,
      text: `Looking for ${gives.map(pretty).join(', ')}, which you offer` });
  }

  const shared = [...A.interests].filter(t => B.interests.has(t));
  if (shared.length) {
    const w = shared.reduce((s, t) => s + 1.2 * ctx.idf(t), 0);
    raw += w;
    const rare = shared.filter(t => (ctx.df.get(t) || 0) <= Math.max(3, ctx.n * 0.1));
    reasons.push({ kind: 'shared', weight: w, tags: shared,
      text: rare.length
        ? `You both love ${rare.map(pretty).join(', ')}, which only ${ctx.df.get(rare[0])} people here listed`
        : `Shared interests: ${shared.map(pretty).join(', ')}` });
  }

  // They're into the thing you're looking for, even if they didn't list it as an offer.
  const adjacent = [...A.lookingFor].filter(t => B.interests.has(t) && !needs.includes(t));
  if (adjacent.length) {
    const w = adjacent.reduce((s, t) => s + 0.8 * ctx.idf(t), 0);
    raw += w;
    reasons.push({ kind: 'adjacent', weight: w, tags: adjacent,
      text: `Into ${adjacent.map(pretty).join(', ')}, which is on your wishlist` });
  }

  const sim = cosine(ctx.vectors.get(viewer.id), ctx.vectors.get(other.id));
  if (sim > 0.08) {
    const w = sim * 4;
    raw += w;
    reasons.push({ kind: 'bio', weight: w, tags: [], text: 'Your backgrounds sound similar' });
  }

  if (viewer.company && other.company &&
      viewer.company.trim().toLowerCase() === other.company.trim().toLowerCase()) {
    raw *= 0.4;
    reasons.push({ kind: 'colleague', weight: 0, tags: [], text: `You both work at ${other.company}` });
  }

  reasons.sort((a, b) => b.weight - a.weight);
  // Squash to 0–100 so the UI can show a stable percentage.
  const score = Math.round(100 * (1 - Math.exp(-raw / 6)));
  return { score, raw, reasons, shared };
}

// Candidates share at least one canonical tag with the viewer, plus a handful
// of random others so small or sparse events still get suggestions.
function candidatesFor(viewer, people, ctx, extra = 8) {
  const me = ctx.profiles.get(viewer.id);
  const ids = new Set();
  if (me) for (const t of me.all) for (const pid of ctx.index.get(t) || []) ids.add(pid);
  ids.delete(viewer.id);
  const byId = new Map(people.map(p => [p.id, p]));
  const out = [...ids].map(i => byId.get(i)).filter(Boolean);
  const rest = people.filter(p => p.id !== viewer.id && !ids.has(p.id));
  for (let i = 0; i < Math.min(extra, rest.length); i++) {
    out.push(rest[Math.floor(Math.random() * rest.length)]);
  }
  return [...new Set(out)];
}

function rankFor(viewer, people, { limit = 20, exclude = new Set(), ctx } = {}) {
  ctx = ctx || buildContext(people);
  return candidatesFor(viewer, people, ctx)
    .filter(p => !exclude.has(p.id))
    .map(p => ({ person: p, ...scorePair(viewer, p, ctx) }))
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function mutualScore(a, b, ctx) {
  const ab = scorePair(a, b, ctx);
  const ba = scorePair(b, a, ctx);
  return { score: Math.round((ab.score + ba.score) / 2), reasons: ab.reasons };
}

// Organizer view: the highest-value pairs that haven't connected yet.
function topUnmetPairs(people, isConnected, { limit = 10 } = {}) {
  const ctx = buildContext(people);
  const seen = new Set();
  const pairs = [];
  for (const a of people) {
    for (const b of candidatesFor(a, people, ctx, 0)) {
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (seen.has(key) || isConnected(a.id, b.id)) continue;
      seen.add(key);
      const m = mutualScore(a, b, ctx);
      if (m.score > 0) pairs.push({ a, b, ...m });
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, limit);
}

// Mixer rounds: greedily build groups that maximise average pairwise score
// while avoiding pairs who have already connected.
function buildGroups(people, size, isConnected) {
  const ctx = buildContext(people);
  const pool = [...people].sort(() => Math.random() - 0.5);
  const groups = [];
  const cache = new Map();
  const pairScore = (a, b) => {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (!cache.has(key)) {
      cache.set(key, isConnected(a.id, b.id) ? -50 : mutualScore(a, b, ctx).score);
    }
    return cache.get(key);
  };

  const groupCount = Math.max(1, Math.round(pool.length / size));
  for (let g = 0; g < groupCount && pool.length; g++) groups.push([pool.shift()]);

  // Round-robin draft: each group picks the remaining person who fits it best.
  while (pool.length) {
    for (const group of groups) {
      if (!pool.length) break;
      let bestIdx = 0, best = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const fit = group.reduce((s, m) => s + pairScore(m, pool[i]), 0) / group.length;
        if (fit > best) { best = fit; bestIdx = i; }
      }
      group.push(pool.splice(bestIdx, 1)[0]);
    }
  }
  return groups;
}

module.exports = { canonical, tokenize, buildContext, scorePair, rankFor, mutualScore, topUnmetPairs, buildGroups };
