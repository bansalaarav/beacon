# 🔆 Beacon

**Walk into any room knowing who to talk to.**

Beacon is a real-time networking companion for mixers, meetups and club events. Attendees check in by scanning a QR code. They immediately see **who is in the room right now**, **who they should meet and why**, and **how to find that person in the crowd**. Organizers get a live dashboard for attendance, matchmaking and room dynamics.

> The problem: you walk up to a stranger at a mixer with no idea who they are, organizers don't know who is still there, and the best potential connections never happen.
> Beacon handles each step: *discover* (live list and explainable matches), *identify* (photo, colour and "spot me" line), *approach* (AI icebreaker and waves), *find* (beacon flash), and *follow up* (contacts and notes).

---

## ✨ Features

### For attendees (mobile-first web app, no install)
| | Feature | What it solves |
|---|---|---|
| 🟢 | **Live "Here now" list** | Real-time presence over WebSockets: arrivals appear instantly and people who leave drop off. Search, filter by area of the room, "just arrived" and "open to chat" filters. |
| ✦ | **Explainable matches** | Ranked "People to meet" list with a % score and the reason for each match, e.g. *"Can help with what you're looking for: fundraising"* or *"You both love robotics, which only 3 people here listed"*. |
| 👀 | **Spot me** | Every profile has a photo or icon, a unique colour ring, a "how to spot me" line (*"navy blazer, glasses"*) and their current area (*📍 Bar*). This is what actually solves the "who is that?" problem. |
| 💬 | **AI icebreakers** | "What should I say?" asks Claude to write one natural opening line from both profiles and the match reasons. Falls back to smart templates when offline or without an API key. |
| 👋 | **Waves** | A low-pressure "I'd like to meet you" with an optional note. Mutual waves auto-connect. Contact details (email, LinkedIn) are **only revealed after both people agree**. |
| 🔆 | **Beacon flash** | Can't find your connection in a packed room? Tap *Find each other*. Your phone turns into a full-screen pulsing colour, and they get told what colour to look for and where you are. |
| 🪪 | **Scan-to-connect badge** | Each attendee has a QR badge and a 4-digit code. Scanning it (with any phone camera) or typing the code swaps contacts instantly when you meet in person. |
| 🔔 | **Smart notifications** | "Your top match just arrived", incoming waves, organizer intros, announcements, mixer-round assignments. |
| 📇 | **Follow-up** | Private notes on each connection, and a one-tap **vCard export** of everyone you met. |
| 🔕 | **Open to chat / busy** | Signal when you're deep in a conversation. |

### For organizers (live dashboard)
| | Feature |
|---|---|
| 📊 | Live stats: here now, checked-in total, left, connections, % who've connected, pending waves |
| 📈 | Attendance-over-time chart (step chart that updates live) |
| ✦ | **Matchmaker**: the highest-value pairs in the room who *haven't* met yet, with one-tap **Introduce** (both get a push) |
| 🌱 | **Wallflower radar**: people here 15+ min with zero connections, with "Find a match" for a warm intro |
| 🔀 | **Mixer rounds**: one tap splits the room into well-matched groups of N. Everyone gets their table and a conversation topic on their phone |
| 📍 | Zone heat map (where people are), 🔥 hot topics cloud, ⚖️ supply vs demand gaps (what people want that nobody offers) |
| 📣 | Broadcast announcements to every phone and the kiosk screen |
| 🧾 | Attendee table with manual check-in/out, online/app-closed status, **CSV export** |
| 🖥 | **Kiosk mode** (`/k/CODE`): big-screen QR, live headcount, "just arrived" wall, trending topics |
| ⏱ | Auto check-out of attendees whose app has been closed for 45 min (configurable), so "here now" stays accurate even when people forget to check out |

---

## 🚀 Quick start

**Requirements:** Node.js 18+ (20.12+ recommended for automatic `.env` loading).

```bash
git clone <your-repo-url> beacon
cd beacon
npm install
npm start
```

Then open:

| URL | What |
|---|---|
| http://localhost:3000 | Landing page: create an event or join one |
| http://localhost:3000/e/DEMO24 | **Demo event** as an attendee (26 pre-seeded people) |
| http://localhost:3000/o/DEMO24#key=demo-organizer-key | **Demo organizer dashboard** |
| http://localhost:3000/k/DEMO24 | Demo kiosk / projector screen |

In the demo dashboard, press **▶ Simulate live activity**. Demo attendees will arrive, move between areas, connect with each other and **wave at you** in real time, so one person can demo the whole product.

### Using it with real phones
On startup the server prints a `Network:` URL (your LAN IP). Phones on the same Wi-Fi can open it, and **QR codes automatically use the LAN address** instead of `localhost` so they're scannable. For a deployed instance, set `PUBLIC_URL`.

### Enabling Claude icebreakers (optional)
```bash
cp .env.example .env
# then set ANTHROPIC_API_KEY=sk-ant-...
npm start
```
The startup log shows `AI icebreakers: Claude (claude-opus-5-5)`. Without a key, Beacon uses template icebreakers built from the match reasons, and everything else works the same.

### Scripts
| Command | Description |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with auto-restart on file changes |
| `npm run seed` | Reset `data/db.json` to just the demo event (stop the server first) |
| `npm test` | Unit tests (matching engine) + end-to-end API test |

### Environment variables
See [`.env.example`](.env.example). All are optional: `PORT`, `PUBLIC_URL`, `ANTHROPIC_API_KEY`, `BEACON_MODEL`, `AUTO_CHECKOUT_MINUTES`, `DATA_FILE`, `DISABLE_DEMO`.

---

## 🧭 User flow

**Attendee**
1. Scan the QR at the door (or type the 6-letter code) and fill in a 45-second profile: name, photo, what you're **looking for**, what you **can help with**, interests, and how to spot you.
2. **For you** shows ranked matches with reasons. Tap one to see what they look like, where they are, and an icebreaker.
3. **Wave**. When they wave back you're connected and contact details unlock.
4. Can't find them? **🔆 Find each other** flashes both phones.
5. Met someone by chance? Scan their badge QR or type their 4-digit code.
6. Leave with **Save all contacts** (.vcf) and your private notes.

**Organizer**
1. Create an event on the landing page. You get a dashboard link with a private organizer key.
2. Print or project the check-in QR (or open **Kiosk screen** on a TV).
3. Watch the room fill up, introduce high-value pairs, rescue wallflowers, run mixer rounds, and send announcements.
4. Export attendance as CSV afterwards.

---

## 🏗 Architecture

```
┌──────────────┐  REST (JSON)   ┌───────────────────────────────┐
│ Attendee PWA │ ─────────────▶ │ Express API                   │
│ Organizer UI │ ◀──── WS ───── │ Socket.IO (rooms per event,   │
│ Kiosk screen │  push events   │   per attendee, organizer)    │
└──────────────┘                ├───────────────────────────────┤
                                │ matching.js  explainable score │
                                │ icebreakers.js Claude + fallback│
                                │ store.js  in-memory + JSON disk │
                                └───────────────────────────────┘
```

- **No build step.** Vanilla ES modules on the frontend, so it's fast to load on venue Wi-Fi and easy to hack on.
- **Real-time** via Socket.IO rooms: `event:<id>` (all attendees), `a:<id>` (one attendee: waves, intros, beacons), `org:<id>` (dashboard), `kiosk:<id>`. Organizer stats are debounced so 500 people checking in at once doesn't flood the dashboard.
- **Privacy by design:** tokens are per attendee (no accounts or passwords), contact details are stripped from every payload unless the viewer is a connection, and photos are resized client-side to about 15 KB and served by URL rather than embedded in lists.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the matching algorithm, data model, API reference and the scaling plan.

### Project structure
```
server/
  index.js        Express routes, Socket.IO, presence tracking, auto check-out
  store.js        Data model + persistence (swap for Postgres/Redis to scale out)
  matching.js     Explainable matching engine, organizer pair finder, group builder
  icebreakers.js  Claude-powered icebreakers with template fallback
  seed.js         Demo event + live activity simulator
public/
  index.html      Landing (create / join)
  event.html      Attendee app  → js/attendee.js
  organizer.html  Dashboard     → js/organizer.js
  kiosk.html      Big-screen check-in display
  js/common.js    Shared helpers (API, avatars, toasts, chip input, image resize)
  styles.css      Design tokens, light + dark mode
tests/
  matching.test.js  Matching engine unit tests (incl. a 2,000-attendee perf test)
  api.test.js       End-to-end flow against a live server
```

---

## 🤖 Use of AI

- **In the product:** Claude (`claude-opus-5-5`, low effort for speed) writes the personalised icebreakers from both profiles plus the matcher's reasons. The server-side refusal fallback is enabled, results are cached per pair, and a deterministic template fallback keeps the feature working at events with bad Wi-Fi.
- **In development:** the project was built with Claude Code as a pair programmer. It scaffolded the architecture, wrote the matching engine and tests, and drove a real browser to click through the attendee and organizer flows. It caught and fixed bugs along the way, e.g. company names leaking into the text-similarity signal and outscoring the colleague penalty, and multi-codepoint emoji like 🧑‍💼 being split by a length-based clip.

## 📈 Scalability

- **Matching** uses an inverted tag index, so each person is only scored against people who share a tag with them (plus a few random picks for serendipity), not the whole room. The test suite ranks a 2,000-person event well under the time budget.
- **Events of any type**: tags are free-form with synonym folding (`ML` → `machine learning`, `investors` → `venture capital`), so the same app works for a tech mixer, a college club fair or an industry conference. Areas of the room are configurable per event.
- **Scaling out**: `store.js` is the only stateful module. Swap it for Postgres (profiles, waves) + Redis (presence), and add `@socket.io/redis-adapter` to run many instances behind a load balancer. Details are in [ARCHITECTURE.md](docs/ARCHITECTURE.md#scaling-plan).

## 🎬 Demo video

A shot-by-shot script for the 1–2 minute demo is in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## License
MIT
