// Conversation starters for a specific pair of attendees.
//
// If Anthropic credentials are configured, Claude writes a short, personalised
// opener from both profiles. Otherwise (or if the call fails) we fall back to
// deterministic templates built from the match reasons, so the feature always
// works offline and at a live event with flaky Wi-Fi.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.BEACON_MODEL || 'claude-opus-5-5';
const aiEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = aiEnabled ? new Anthropic({ timeout: 20_000, maxRetries: 1 }) : null;

const cache = new Map(); // "viewerId|otherId" -> result

const SYSTEM = `You help people break the ice at in-person networking events.
Given two attendee profiles and why they were matched, write ONE natural opening line
the first person could say out loud when walking up to the second person.
Rules: under 35 words, specific to their profiles, warm and casual, no flattery,
no emojis, no hashtags, no quotation marks. Output only the line.`;

function describe(p) {
  return [
    `Name: ${p.name}`,
    p.headline && `Headline: ${p.headline}`,
    p.company && `Company: ${p.company}`,
    p.bio && `Bio: ${p.bio}`,
    p.interests?.length && `Interests: ${p.interests.join(', ')}`,
    p.lookingFor?.length && `Looking for: ${p.lookingFor.join(', ')}`,
    p.offering?.length && `Can offer: ${p.offering.join(', ')}`,
  ].filter(Boolean).join('\n');
}

function templateFor(viewer, other, reasons) {
  const first = other.name.split(' ')[0];
  const top = reasons[0];
  if (top?.kind === 'need') {
    return `Hi ${first}! I saw you can help with ${top.tags[0]}. That's exactly what I'm trying to figure out right now. Mind if I pick your brain for a minute?`;
  }
  if (top?.kind === 'give') {
    return `Hey ${first}, I noticed you're looking for ${top.tags[0]}. I've done a fair bit of that, so happy to share what's worked for me.`;
  }
  if (top?.kind === 'shared' || top?.kind === 'adjacent') {
    return `Hi ${first}! Beacon says we're both into ${top.tags[0]}. What got you into it?`;
  }
  if (other.headline) {
    return `Hi ${first}, I'm ${viewer.name.split(' ')[0]}. I saw you're ${other.headline}. What are you working on these days?`;
  }
  return `Hi ${first}, I'm ${viewer.name.split(' ')[0]}. What brought you here tonight?`;
}

async function icebreaker(viewer, other, reasons) {
  const key = `${viewer.id}|${other.id}`;
  if (cache.has(key)) return cache.get(key);

  const fallback = { text: templateFor(viewer, other, reasons), source: 'template' };
  if (!client) return fallback;

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Person A (speaking):\n${describe(viewer)}\n\nPerson B (approached):\n${describe(other)}\n\n` +
          `Why they were matched:\n${reasons.map(r => `- ${r.text}`).join('\n') || '- General networking'}`,
      }],
    });

    if (response.stop_reason === 'refusal') return fallback;
    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join(' ')
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!text) return fallback;

    const result = { text, source: 'ai' };
    cache.set(key, result);
    return result;
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.warn(`Icebreaker AI call failed (${err.status ?? 'network'}): ${err.message}`);
    } else {
      console.warn('Icebreaker AI call failed:', err.message);
    }
    return fallback;
  }
}

module.exports = { icebreaker, templateFor, aiEnabled };
