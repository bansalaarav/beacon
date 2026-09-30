// Demo data: a realistic mixer with ~30 attendees, plus an optional simulator
// that makes the room "move" (arrivals, departures, waves, zone changes) so
// the product can be demoed by one person.
//
//   npm run seed      -> resets data/db.json to just the demo event
//   (server start)    -> the demo event is created automatically if missing

const { Store } = require('./store');

const DEMO_CODE = 'DEMO24';
const DEMO_KEY = 'demo-organizer-key';

const PEOPLE = [
  ['Priya Raman', 'Founder, stealth climate startup', 'Carbonloop', '🌱', 'Green scarf, near the window', ['climate tech', 'startups', 'hardware'], ['co-founder', 'fundraising', 'engineering'], ['product strategy', 'climate tech'], 'Building a sensor network that measures soil carbon for farmers. Ex-Tesla battery team.'],
  ['Marcus Chen', 'Partner', 'Northstar Ventures', '💼', 'Navy blazer, glasses', ['venture capital', 'climate tech', 'fintech'], ['startups', 'deal flow'], ['fundraising', 'mentorship', 'go-to-market'], 'Early-stage investor focused on climate and fintech. Always happy to give pitch feedback.'],
  ['Aisha Bello', 'ML Engineer', 'Lumen AI', '🤖', 'Yellow sneakers', ['machine learning', 'llms', 'open source'], ['jobs', 'research collaboration'], ['machine learning', 'python'], 'Training small language models for on-device use. Contributor to a few open-source ML libraries.'],
  ['Diego Alvarez', 'Senior Product Designer', 'Figment', '🎨', 'Black turtleneck, tote bag', ['design', 'accessibility', 'photography'], ['side projects', 'startups'], ['design', 'user research'], 'Design systems nerd. I care a lot about accessible interfaces and good typography.'],
  ['Hannah Kim', 'CS student', 'BITS Pilani', '📚', 'Red hoodie with university logo', ['machine learning', 'web3', 'hackathons'], ['internships', 'mentorship'], ['frontend'], 'Final year student. Built three hackathon projects this year, looking for a summer internship in ML.'],
  ['Tom Okafor', 'Head of Talent', 'Gridwise', '🧲', 'Grey suit, lanyard', ['jobs', 'climate tech', 'culture'], ['engineering', 'design'], ['jobs', 'career advice'], 'Hiring 12 engineers and 2 designers for our grid optimisation platform. Ask me about roles!'],
  ['Sofia Rossi', 'Growth Lead', 'Pocketbank', '📈', 'Purple dress', ['marketing', 'fintech', 'data'], ['co-founder', 'data'], ['marketing', 'go-to-market'], 'Scaled a fintech app from 10k to 2M users. Thinking about starting something of my own.'],
  ['Arjun Mehta', 'Backend Engineer', 'Freelance', '⚙️', 'Denim jacket, beard', ['backend', 'rust', 'distributed systems'], ['startups', 'co-founder'], ['backend', 'engineering', 'devops'], 'Ten years building payment infrastructure. Looking to join an early team as technical co-founder.'],
  ['Lena Fischer', 'Research Scientist', 'Institute for Energy Systems', '🔬', 'Orange glasses', ['climate tech', 'data', 'policy'], ['startups', 'go-to-market'], ['research collaboration', 'climate tech'], 'I model power grids and want to turn my research into a product. No idea how to sell anything.'],
  ['Kwame Asante', 'Angel investor & operator', 'Independent', '🦁', 'White linen shirt', ['venture capital', 'africa tech', 'fintech'], ['deal flow'], ['fundraising', 'mentorship'], 'Former COO, now angel investing in fintech and climate founders. Love helping first-time founders.'],
  ['Mei Tanaka', 'Frontend Developer', 'Nimbus', '💻', 'Cat ears headband', ['frontend', 'typescript', 'design'], ['mentorship', 'jobs'], ['frontend', 'javascript'], 'React and TypeScript developer. Want to grow into a staff engineer role.'],
  ['Omar Haddad', 'Product Manager', 'Shipfast', '🧭', 'Green cap', ['product strategy', 'saas', 'llms'], ['design', 'user research'], ['product strategy', 'go-to-market'], 'PM for an AI writing tool. Obsessed with user interviews and fast iteration.'],
  ['Grace Liu', 'Data Scientist', 'Healthpath', '📊', 'Striped shirt', ['data', 'healthtech', 'machine learning'], ['research collaboration', 'jobs'], ['data', 'python'], 'Predicting hospital readmissions with messy real-world data. Curious about climate + health.'],
  ['Ben Carter', 'Founder', 'Tutorly', '🎓', 'Blue beanie', ['edtech', 'llms', 'startups'], ['fundraising', 'machine learning'], ['product strategy', 'startups'], 'Building AI tutors for high-school maths. Raising a pre-seed round this quarter.'],
  ['Nadia Petrova', 'DevRel Engineer', 'CloudPeak', '🎤', 'Leather jacket', ['open source', 'devops', 'community'], ['speaking', 'community'], ['devops', 'mentorship', 'public speaking'], 'I run meetups and give talks about infrastructure. Happy to help anyone who wants to start speaking.'],
  ['Rahul Verma', 'Hardware Engineer', 'Voltwise', '🔋', 'Tool belt keychain', ['hardware', 'climate tech', 'robotics'], ['co-founder', 'startups'], ['hardware', 'engineering'], 'Designing battery management systems. Want to build something in climate hardware.'],
  ['Chloe Martin', 'UX Researcher', 'Freelance', '🔎', 'Big curly hair, red lipstick', ['user research', 'accessibility', 'healthtech'], ['side projects', 'jobs'], ['user research', 'design'], 'Qualitative researcher. I love helping early teams figure out what users actually need.'],
  ['Samuel Nwosu', 'Solutions Architect', 'Datacore', '🏗️', 'Tall, green polo', ['backend', 'data', 'saas'], ['side projects'], ['backend', 'career advice'], 'Helping enterprises move data pipelines to the cloud.'],
  ['Isabel Moreno', 'Policy Analyst', 'Clean Air Now', '🌍', 'Floral blouse', ['policy', 'climate tech', 'community'], ['data', 'research collaboration'], ['policy'], 'Working on air-quality regulation. Looking for data people who want to do some good.'],
  ['Yuki Sato', 'Indie Game Developer', 'Tiny Lantern', '🎮', 'Pixel-art t-shirt', ['game dev', 'design', 'music'], ['marketing', 'fundraising'], ['frontend', 'design'], 'Making a cosy puzzle game. Need help marketing it before launch.'],
  ['Fatima Zahra', 'Security Engineer', 'Shieldline', '🛡️', 'Black cap, hoodie', ['security', 'backend', 'open source'], ['jobs', 'speaking'], ['security', 'mentorship'], 'Pentester turned security engineer. Always happy to review your auth flow.'],
  ['Leo Novak', 'Student founder', 'Campus Eats', '🍕', 'Orange windbreaker', ['startups', 'marketing', 'hackathons'], ['mentorship', 'fundraising', 'co-founder'], ['frontend'], 'Running a student food delivery startup across 3 campuses. First-time founder, lots to learn.'],
  ['Emma Walsh', 'VP Engineering', 'Gridwise', '🧑‍💼', 'Silver necklace', ['engineering', 'culture', 'climate tech'], ['engineering'], ['mentorship', 'career advice', 'engineering'], 'Leading a 40-person engineering org. I mentor engineers moving into management.'],
  ['Victor Adeyemi', 'Blockchain Developer', 'Chainlab', '⛓️', 'Gold watch', ['web3', 'fintech', 'rust'], ['co-founder', 'design'], ['backend', 'web3'], 'Building payment rails for cross-border remittances.'],
  ['Anya Singh', 'Content Creator', 'Tech with Anya', '📹', 'Ring light in hand', ['community', 'marketing', 'llms'], ['side projects', 'speaking'], ['marketing', 'public speaking'], '200k subscribers explaining AI tools. Looking for founders to feature.'],
  ['Hugo Laurent', 'CTO', 'Tutorly', '🧠', 'Round glasses, cardigan', ['llms', 'edtech', 'backend'], ['machine learning', 'jobs'], ['backend', 'engineering'], 'Building the tech behind Tutorly. We are hiring ML engineers.'],
];

// Reserve profiles that "arrive" during a simulated demo.
const LATECOMERS = [
  ['Zara Ahmed', 'Climate Investor', 'Terra Fund', '🌿', 'Emerald jacket', ['climate tech', 'venture capital'], ['deal flow', 'startups'], ['fundraising', 'mentorship'], 'Seed investor in climate hardware.'],
  ['Noah Brooks', 'iOS Engineer', 'Appcraft', '📱', 'White sneakers', ['frontend', 'design', 'game dev'], ['side projects', 'co-founder'], ['frontend'], 'Swift developer who wants to build a consumer app.'],
  ['Maya Patel', 'Recruiter', 'TalentBridge', '🤝', 'Pink blazer', ['jobs', 'culture'], ['machine learning', 'engineering'], ['jobs', 'career advice'], 'Placing ML engineers at AI startups.'],
  ['Ethan Wu', 'PhD student, robotics', 'Tech University', '🦾', 'Robot pin on bag', ['robotics', 'machine learning', 'hardware'], ['internships', 'co-founder'], ['research collaboration', 'machine learning'], 'Working on robotic grasping. Thinking about a startup.'],
  ['Olivia Grant', 'Community Manager', 'Makers Hub', '🎉', 'Sparkly headband', ['community', 'startups', 'hackathons'], ['speaking', 'marketing'], ['community', 'public speaking'], 'I run hackathons and founder dinners.'],
  ['Ravi Kumar', 'Data Engineer', 'Streamline', '🛠️', 'Plaid shirt', ['data', 'backend', 'open source'], ['jobs', 'mentorship'], ['data', 'backend'], 'Building streaming pipelines, want to move into ML.'],
];

function toProfile([name, headline, company, emoji, spotMe, interests, lookingFor, offering, bio]) {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
  return {
    name, headline, company, emoji, spotMe, interests, lookingFor, offering, bio,
    email: `${slug}@example.com`, linkedin: `https://www.linkedin.com/in/${slug.replace(/\./g, '-')}`, bot: true,
  };
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function seedDemo(store) {
  const event = store.createEvent({
    name: 'Founders & Builders Mixer',
    description: 'A monthly mixer for founders, engineers, designers and investors. Say hi to someone new!',
    venue: 'The Loft, 3rd floor',
    zones: ['Entrance', 'Bar', 'Main floor', 'Patio', 'Demo tables'],
  });
  store.codes.delete(event.code);
  event.code = DEMO_CODE;
  event.organizerKey = DEMO_KEY;
  event.demo = true;
  store.codes.set(DEMO_CODE, event.id);

  const now = Date.now();
  const bots = PEOPLE.map((p, i) => {
    const a = store.checkIn(event, toProfile(p));
    a.checkedInAt = now - (95 - i * 3) * 60_000;
    a.zone = pick(event.zones);
    return a;
  });

  // Realistic attendance curve for the dashboard chart.
  const series = [];
  for (let m = 100; m >= 0; m -= 2) {
    const t = now - m * 60_000;
    series.push({ t, here: bots.filter(b => b.checkedInAt <= t).length });
  }
  // One early leaver.
  const leaver = bots[bots.length - 3];
  leaver.status = 'left';
  leaver.checkedOutAt = now - 5 * 60_000;
  series.push({ t: now, here: bots.filter(b => b.status === 'here').length });
  store.timeline.set(event.id, series);

  // A handful of connections that already happened.
  const pairs = [[0, 1], [0, 8], [2, 12], [3, 16], [5, 22], [9, 21], [13, 25], [6, 7], [10, 22], [14, 20]];
  for (const [x, y] of pairs) store.createWave(bots[x], bots[y], '', { accepted: true });
  store.createWave(bots[4], bots[2], 'Would love to hear about on-device ML!');

  store.save();
  return event;
}

class Simulator {
  constructor(store, event, { onUpsert, onWave, onActivity }) {
    this.store = store;
    this.event = event;
    this.onUpsert = onUpsert;
    this.emitWave = onWave;
    this.onActivity = onActivity;
    this.timer = null;
    this.lastWaveAtHuman = new Map();
  }

  start() {
    const tick = () => {
      try { this.step(); } catch (err) { console.error('simulator:', err); }
      this.timer = setTimeout(tick, 2500 + Math.random() * 2500);
    };
    tick();
  }

  stop() { clearTimeout(this.timer); }

  bots(status) {
    return this.store.attendeesOf(this.event.id).filter(a => a.bot && (!status || a.status === status));
  }

  step() {
    const here = this.bots('here');
    const r = Math.random();
    const arrivals = LATECOMERS.filter(p => !this.store.attendeesOf(this.event.id).some(a => a.name === p[0]));

    if (r < 0.22 && arrivals.length) {
      const a = this.store.checkIn(this.event, toProfile(pick(arrivals)));
      a.zone = 'Entrance';
      this.onUpsert(a);
      this.onActivity('checkin', `${a.name} checked in`);
    } else if (r < 0.32 && here.length > 20) {
      const a = pick(here);
      this.store.setStatus(a, 'left');
      this.onUpsert(a);
      this.onActivity('checkout', `${a.name} left`);
    } else if (r < 0.55) {
      const a = pick(here);
      if (a) { a.zone = pick(this.event.zones); this.store.save(); this.onUpsert(a); }
    } else if (r < 0.8) {
      const a = pick(here), b = pick(here);
      if (a && b && a.id !== b.id && !this.store.waveBetween(a.id, b.id)) {
        this.emitWave(this.store.createWave(a, b, '', { accepted: true }));
      }
    } else {
      // A bot waves at a real attendee so the demo shows live notifications.
      const humans = this.store.presentOf(this.event.id).filter(h => !h.bot);
      const h = pick(humans);
      const a = pick(here);
      if (h && a && !this.store.waveBetween(a.id, h.id) && Date.now() - (this.lastWaveAtHuman.get(h.id) || 0) > 20_000) {
        this.lastWaveAtHuman.set(h.id, Date.now());
        this.emitWave(this.store.createWave(a, h, pick(['Would love to chat!', 'Saw we have a lot in common 👋', 'Grab a drink at the bar?', ''])));
      }
    }
  }

  // Bots accept waves from real attendees after a short, human-feeling pause.
  onWave(w) {
    if (w.status !== 'pending') return;
    const to = this.store.attendees.get(w.to);
    const from = this.store.attendees.get(w.from);
    if (!to?.bot || from?.bot) return;
    setTimeout(() => {
      if (w.status !== 'pending') return;
      this.store.respondWave(w, true);
      this.emitWave(w);
    }, 2500 + Math.random() * 2000);
  }
}

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const file = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const store = new Store();
  seedDemo(store);
  store.flush();
  console.log(`Seeded demo event ${DEMO_CODE} with ${PEOPLE.length} attendees -> ${file}`);
  console.log(`Organizer dashboard: http://localhost:3000/o/${DEMO_CODE}#key=${DEMO_KEY}`);
}

module.exports = { seedDemo, Simulator, DEMO_CODE, DEMO_KEY };
