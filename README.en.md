<div align="center">

# dsh-mnemos

[中文](README.md)

> Cross-session memory and persona plugin for DSH · `v1.7.0` · 2026-11-15

`dsh-mnemos` is a long-term memory and persona-growth engine built for the DSH host process. It gives a model a memory that self-evolves, settles in layers, and can be interrogated — plus a persona card that grows out of the conversation itself.

---

![DSH plugin](https://img.shields.io/badge/DSH-plugin-blue) ![version](https://img.shields.io/badge/v1.7.0-green)

</div>

---

A model forgets the previous turn every turn. This plugin gives it a cross-session memory store and a persona card that keeps growing.

It is not just about remembering names. It solves four things:

- **Fading** — something from three years ago should not burn as bright as today
- **Settling** — an experience slowly condenses into a one-line gist
- **Expiring** — "I'm getting married next month" should trigger a follow-up question once it passes
- **Being wrong** — when the user says "I got that wrong", the old memory must be voidable, with a trace left behind

The whole design comes down to four sentences:

1. **The ledger is the only truth**  
   Every piece of state (memories, persona, six dimensions, settings) is replayed from `ledger.jsonl`. There is no second state file that can be quietly rewritten.

2. **The model can add, never modify**  
   Delete, rollback and import are the user's powers. The model can write a new memory, or flag one as "no longer true" with `mnemos_void`.

3. **The plugin decides *how* it is stored; the model decides *what* is stored**  
   Character limits, decay formulas and compression cadence are all hard-coded. The model's freedom is content, tier, dimensions and salience.

4. **Compression is fast first, then slow**  
   An experience that gets retold repeatedly sheds more and more gently, until it settles into a one-line "roughly".

---

## Five tiers

| | What it is | Limit | Half-life | In prompt |
|:--:|---|:--:|:--:|:--:|
| **T1** | Facts that stay true forever (name, birthday, stance) | 100 | 100 yr | ✅ |
| **T2** | Gists settled out of experience | 200 | 400 d | ✅ |
| **T3** | Experiences worth keeping | 1000 | 112 d | ✅ |
| **T4** | Scratch: unsure whether it is worth keeping | 300 | 3 d | ❌ |
| **T5** | Forecasts: not yet happened, has a deadline | 400 | — | ✅ even after expiry |

**T4 is a buffer, not a bin** — never injected; promoted to T3 after being recalled 3 times; drifts away on its own if nobody brings it up.

**T5 expiry is not the end** — after the deadline it stays in the prompt, tagged `⏰expired`, forcing the model to go ask how it turned out. Only being voided removes it.

```
- T5 user getting married on 20 Dec (2026-11-15) — due 2026-12-20 ⏰expired
```

---

## Compression: fast first, then slow

T3 is condensed every 7 days, but **the amount erased each round is itself decaying** (`25% × 0.84^n`):

```
975 → 731 → 578 → 476 → 405 → 355 → 318 → 290
    → 268 → 252 → 239 → 228 → 220 → 213 → 208 → 199 (T2)
```

Retention climbs from 75% all the way to 98%. The full walk takes 16 rounds, 112 days.

Human forgetting drops hardest in the first few days and then flattens out — a linear curve is simply wrong.

Memories that get recalled compress more slowly: each recall winds the clock back 3.5 days.

<details>
<summary>Compared with Ebbinghaus</summary>

| Day | 1 | 7 | 21 | 56 | 90 |
|---|---|---|---|---|---|
| Ebbinghaus | 44% | 24% | 17% | 12% | 11% |
| This plugin | 100% | 75% | 61% | 27% | 20% |

Shape correlation 0.97, overall about 2× slower — this stores meaningful content, not nonsense syllables.
</details>

---

## The model cannot reach T2

```
model → condense(id, title, body)
           │
        result ≤ 200 chars?
        ├─ yes → T2 (system-generated, terminal)
        └─ no  → still T3, wait for the next round
```

`mnemos_remember` only accepts `tier` 1 / 3 / 4 / 5 — **`tier: 2` is rejected outright**.

Why: if the model could write T2 directly, it would bypass the whole compression path and pin whatever it likes onto a terminal state.

**The plugin decides how short it gets compressed; the model decides what survives.**

---

## Void: never rewrite history, only add a record

```
old  T1 user marrying 2027-03            ← not a single character changed
       voided: true
       voidedReason: user said that was wrong, it's 2027-06
       replacedBy: <id of the new one>
new  T1 user marrying 2027-06
```

Rewriting means "history was erased". Voiding means "this is what I knew at the time; later I found out otherwise".

Voided memories are not injected, but the ledger and the store keep them. `recall` still finds them, tagged `voided: true`.

### Three ways of "no longer using it"

| Action | Trigger | Meaning | In prompt |
|---|---|---|:--:|
| Archived | plugin | Compressed away | ❌ |
| Expired | time | T5 reached its deadline | ✅ tagged ⏰ |
| Voided | one word from the user | Turned out to be wrong | ❌ |

---

## How memory is stored

There is exactly one source of truth: `<DSH_HOME>/mnemos/ledger.jsonl` — append-only, hash-chained per record.

```
hash = sha256({v, seq, ts, kind, actor, payload, prev})
```

Memories, persona, foundation, six dimensions and snapshots are all projections replayed from this ledger. Remove or alter any single record and the chain breaks at that point — the UI turns red, rollback is disabled.

Every mutation carries before/after snapshots and can be rolled back by id.

---

## Tools

| Tool | What it does |
|---|---|
| `mnemos_recall` | Search memories. The only entry point that can see T4 |
| `mnemos_remember` | Write one (T1 / T3 / T4 / T5 — **T2 cannot be written**) |
| `mnemos_void` | Mark as void (content unchanged) |
| `mnemos_condense` | Retell a T3 in fewer words |
| `mnemos_persona` | Persona card and self-view |
| `mnemos_understanding` | Six-dimension scoring |
| `mnemos_duty` | Read/adjust own rhythm |
| `mnemos_inject` | Read/adjust injection size |
| `mnemos_bili` | Bilibili browsing parameters |
| `mnemos_archive` | Verify the hash chain |

What the model does not have: **delete, rewrite, rollback, import, master switch**. Only the user can touch these.

### The plugin itself

| File | Responsibility |
|---|---|
| `index.js` | Register tools, inject system prompt, start heartbeat |
| `lib/model.js` | Tier constants, decay formula, injection rendering |
| `lib/store.js` | Ledger I/O, projection replay, write paths |
| `lib/tools.js` | Tool schemas and adapters |
| `lib/duty.js` | Off-peak detection, duty scheduling, compression plan |
| `lib/routes.js` | HTTP routes |
| `client.js` | Front-end constellation page |

---

## Tunable parameters

The model may adjust these itself, but each has a hard range. Out-of-range values are **clamped to the boundary**, not rejected.

| Param | Default | Range | Meaning |
|---|:--:|:--:|---|
| `injectCount` | 12 | 1–24 | How many memories injected per turn |
| `injectBudget` | 1800 | 600–3200 | Character budget for injection |
| `reflectionEveryHours` | 24 | 6–72 | How often to reflect |
| `biliEveryHours` | 20 | 6–72 | How often to browse Bilibili |
| `dutyMaxPerDay` | 2 | 1–4 | Max duty rounds per day |
| `tier4TtlDays` | 3 | 0–90 | Scratch retention in days (0 = never expires) |

Bilibili browsing has its own whitelist (`perDay`, `fetchPerRound`, `keywords`, …). Account, DMs, auto-comment and other sensitive items stay with the user and are not open to model adjustment.

---

## Record types

`ledger.jsonl` holds only these kinds, and who writes each one is fixed.

| kind | Written by | Meaning |
|---|---|---|
| `genesis` | plugin | Ledger born / reset |
| `memory.write` | model | New memory (T1 / T3 / T4 / T5) |
| `memory.condense` | model | Condense one T3 |
| `memory.compress` | plugin | The only channel that produces T2 |
| `memory.upgrade` | plugin | T4 promoted to T3 |
| `memory.void` | model | Mark as void |
| `persona.revise` | model | Revise the persona card |
| `persona.foundation` | user | Change the persona foundation |
| `understanding.revise` | model | Six-dimension scoring |
| `inject.profile` | model | Adjust injection size |
| `rhythm.profile` | model | Adjust rhythm |
| `rollback` | user | Roll back to a snapshot |
| `chain.repair` | user | Seal a broken chain |

The ledger also contains older `memory.revise`, `memory.forget` and `origin.set` records — leftovers from removed capabilities. Replay still reads through them, but nothing new produces them.

---

## Off-peak duty

When a round lands in DeepSeek's discount window (noon 12–14, evening 18–09:00 the next day, all weekend) and something is due, it schedules an autonomous round — a fresh session that decides for itself whether to tidy memory, browse Bilibili, or change its own persona.

**"Nothing needs changing" is a valid decision.**

The reflection brief is numbered:

```
1 state & rhythm  2 old-memory compression  3 scratch
4 memory quota    5 self & persona          6 future commitments
7 knowing you     8 red lines               9 wrap-up
```

---

## Hard limits

> Written in code. The model cannot change them.

1. **Technical isolation** — code, paths and config never enter memory. Caught by structural signature, not topic keywords (so "she writes Python" is still remembered).
2. **No silent erasure** — hash chain, see above.
3. **No fabrication** — the evidence on each memory comes from the plugin, from the call that wrote it. The model cannot supply it.
4. **No credentials** — ID numbers and card numbers are caught by shape.
5. **Add, never modify** — write a correct one, or void the old one.

---

## Compared with other approaches

Most agent memory systems on the market solve "how to store more" and "how to retrieve better". This plugin solves a third problem:
**how to let what was stored evolve on its own — getting shorter, fainter, wrong, expired — with a trace at every step.**

Tiering, forgetting curves and memory consolidation are nothing new. What is different:

| | Difference |
|---|---|
| **What fades is the content** | Other decays only affect ranking and eviction; a T3 here actually gets shorter |
| **Forecasts have deadlines** | Past due, it stays in view and forces handling instead of rotting quietly |
| **Voiding is a full mechanism** | Many systems have no contradiction resolution at all — wrong facts just sit there |
| **One-to-one** | No merging several memories into a gist, which is what keeps the compression history fully traceable |
| **Tiers by lifecycle** | Not hot/warm/cold, but "forever true / gist / will fade" |

**Not included**: vector search (paraphrases with different wording won't match), automatic contradiction detection, metamemory, multi-tenant isolation.

---

## UI

The constellation icon in the left sidebar.

- **Memory constellation** — 3D: six dimensions are six directions, tier sets the radius, brightness = salience
- **Still remembered** — T5 shows its deadline and overdue state
- **Self-view / persona card / what it knows about you / autonomous rhythm**
- **Evidence chain and rollback** — snapshot list, one-click import

---

## Scope

This plugin assumes the model honestly judges "is this worth remembering". It defends against format problems, credential leaks and silent tampering — it cannot stop a model from writing a great deal about unimportant things.

What actually governs quality is **limits, decay, compression, voiding** — not the number of rules.

---

## Docs

- [Technical documentation (v2, Chinese, `.docx`)](docs/dsh-mnemos-tech-v2.docx)
