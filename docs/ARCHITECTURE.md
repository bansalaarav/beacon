# Beacon architecture

## Components

| Module | Responsibility |
|---|---|
| `server/index.js` | HTTP routes, auth middleware, Socket.IO rooms, presence counting, auto check-out sweep, organizer stats |
| `server/store.js` | The only stateful module. In-memory `Map`s with debounced atomic JSON snapshots (`data/db.json`) |
| `server/matching.js` | Scoring, ranking, organizer pair-finding, mixer-round grouping |
| `server/icebreakers.js` | Claude call with template fallback and a per-pair cache |
| `server/seed.js` | Demo event and live-activity simulator |
| `public/` | Framework-free ES-module frontend: attendee app, organizer dashboard, kiosk |

## Data model

```
Event     { id, code, name, description, venue, zones[], organizerKey, announcements[], rounds[] }
Attendee  { id, eventId, token, badge, color, status: here|left, zone, openToChat,
            name, headline, company, bio, photo, emoji, spotMe,
            interests[], lookingFor[], offering[], linkedin, email,
            checkedInAt, checkedOutAt, lastSeen, notes{otherId: text} }
Wave      { id, eventId, from, to, note, via: wave|badge, status: pending|accepted|declined }
```

A **connection** is an accepted wave. A wave in the opposite direction of a pending wave counts as acceptance.

### Identity & auth
- No accounts. Checking in returns a random 192-bit **attendee token** stored in `localStorage` and sent as `Authorization: Bearer`.
- Creating an event returns an **organizer key** sent as `x-organizer-key`.
- The 4-digit **badge code** is unique per event and only shown on the owner's own badge screen, so knowing it means you met in person.

### Presence
- Each open app holds a socket, and the server counts sockets per attendee (`online` = at least one socket).
- `status` (`here` / `left`) is explicit: set by check-in, check-out, the organizer, or the **auto check-out sweep**, which runs every minute and checks out attendees with no open socket whose `lastSeen` is older than `AUTO_CHECKOUT_MINUTES`.
- The dashboard distinguishes "here · online" from "here · app closed".

## Matching algorithm

For viewer **A** and candidate **B**, tags are first canonicalised (lower-case, synonym map, plural folding). Then:

| Signal | Weight per tag | Reason shown to the user |
|---|---|---|
| A.lookingFor ∩ B.offering | 3 × idf | "Can help with what you're looking for: …" |
| B.lookingFor ∩ A.offering | 2 × idf | "Looking for …, which you offer" |
| A.interests ∩ B.interests | 1.2 × idf | "You both love X, which only N people here listed" (rare) / "Shared interests: …" |
| A.lookingFor ∩ B.interests | 0.8 × idf | "Into X, which is on your wishlist" |
| TF-IDF cosine(headline + bio) | 4 × sim (if > 0.08) | "Your backgrounds sound similar" |
| Same company | total × 0.4 | "You both work at …" |

- `idf(tag) = 0.5 + ln(1 + N/df) / ln(1 + N)`, normalised to roughly 0.5–1.5. A tag half the room shares counts less than a niche one.
- The score is **asymmetric** on purpose: being helped ranks higher than helping, because the list answers "who should *I* go talk to?".
- `score% = 100 × (1 − e^(−raw/6))` gives a stable, bounded number.
- Reasons are sorted by their contribution, so the first reason is always the main one.

**Candidate generation** uses an inverted index `tag → attendees`. Each viewer is scored only against people sharing at least one canonical tag, plus up to 8 random others for serendipity. Cost is O(tag-neighbourhood), not O(N).

**Organizer matchmaker** (`topUnmetPairs`) averages both directions' scores over candidate pairs and skips pairs that are already connected.

**Mixer rounds** (`buildGroups`) seeds ⌈N/size⌉ groups, then runs a round-robin draft where each group takes the remaining person with the highest average fit to its current members. Already-connected pairs get a −50 penalty so rounds create *new* connections. Each group's topic is its most common canonical tag.

## API reference

Attendee endpoints take `Authorization: Bearer <token>`. Organizer endpoints take `x-organizer-key`.

| Method | Path | Description |
|---|---|---|
| POST | `/api/events` | Create event → `{code, organizerKey}` |
| GET | `/api/events/:code` | Public event info + live headcount |
| GET | `/api/events/:code/qr.svg[?connect=BADGE]` | Join QR / badge QR |
| POST | `/api/events/:code/checkin` | Check in with profile → `{token, me}` |
| GET / PATCH | `/api/me` | Own profile + event / update profile, zone, openToChat |
| POST | `/api/me/checkout`, `/api/me/checkin` | Leave / come back |
| GET | `/api/me/attendees` | Everyone at the event (contacts only for connections) |
| GET | `/api/me/matches` | Ranked matches with reasons |
| GET | `/api/me/icebreaker/:id` | `{text, source: ai|template}` |
| GET / POST | `/api/me/waves` | List / send a wave |
| POST | `/api/waves/:id/respond` | `{accept: bool}` |
| POST | `/api/me/connect` | `{badge}` → instant connection |
| PUT | `/api/me/notes/:id` | Private note on a person |
| GET | `/api/me/contacts.vcf` | vCard export of connections |
| GET | `/api/org/:code/dashboard` | Stats, activity, attendees |
| GET | `/api/org/:code/suggestions[?for=id]` | Unmet high-value pairs |
| POST | `/api/org/:code/introduce` | `{a, b, note?}` notify both |
| POST | `/api/org/:code/announce` | `{text}` broadcast |
| POST | `/api/org/:code/rounds` | `{size}` create mixer round |
| POST | `/api/org/:code/attendees/:id/status` | Manual check-in/out |
| GET | `/api/org/:code/export.csv` | Attendance export |
| POST | `/api/org/:code/simulate` | Toggle demo simulator (demo event only) |
| GET | `/api/kiosk/:code` | Public kiosk snapshot |

### Socket events (server → client)
| Event | Audience | Payload |
|---|---|---|
| `attendee:upsert` | event room (contact-bearing copy to connections) | public attendee view |
| `me` | the attendee | own profile |
| `wave` | both parties | wave view |
| `announcement` | event + kiosk | `{text, at}` |
| `intro` | both parties | `{person, reasons, note}` |
| `round` | each member | `{n, table, topic, members}` |
| `beacon` | target | `{from, color}` |
| `stats` / `activity` | organizer, kiosk | dashboard data |

Client → server: `heartbeat`, `beacon {to}`.

## Scaling plan

The current build runs as a single Node process, which comfortably handles a few thousand concurrent attendees. To go beyond that:

1. **Storage:** re-implement `store.js` on Postgres (events, attendees, waves) keeping the same method names. Presence (`sockets` map, `lastSeen`) moves to Redis with TTL keys.
2. **Fan-out:** add `@socket.io/redis-adapter` so room broadcasts reach sockets on every instance. Use sticky sessions at the load balancer.
3. **Matching:** already sub-linear per viewer through the inverted index. For very large events (10k+), cache `buildContext` per event and invalidate it on profile change instead of rebuilding it per request.
4. **Photos:** move to object storage/CDN; profiles already reference photos by URL.
5. **AI:** icebreakers are cached per pair and only generated on demand; add a queue and rate limiter if many attendees request them at once.
