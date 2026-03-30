# episodic-claw

**Long-term episodic memory for OpenClaw agents.**

> 🇺🇸 English · [🇯🇵 日本語](./README.ja.md) · [🇨🇳 中文](./README.zh.md)

[![version](https://img.shields.io/badge/version-0.2.0-blue)](CHANGELOG.md)
[![license](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-OpenClaw-orange)](https://openclaw.ai)

This plugin saves conversations locally, finds related memories by meaning, and adds the right ones back into the prompt before the model answers. That helps OpenClaw remember useful context without extra commands or manual cleanup.

Release docs: [v0.2.0 bundle](./docs/v0.2.0/README.md)

---

## Why TypeScript + Go?

Most plugins are written in one language. This one uses two on purpose.

Think of it like a store with a front desk and a back room.

**TypeScript is the front desk.** It talks to OpenClaw, registers tools, connects hooks, and keeps the plugin wiring simple.

**Go is the back room.** It handles the heavy work: embeddings, vector search, and Pebble DB storage. That keeps the slow part away from Node.js, so the agent stays responsive.

So the rule is simple: **TypeScript coordinates, Go does the heavy lifting, and the agent does not have to wait around.**

---

## How It Works

> **TL;DR:** Every message triggers a memory check. Relevant past episodes are added to the prompt before the model replies.

**Step 1 — You send a message.**

**Step 2 — `assemble()` fires.** The plugin takes the last 5 messages and builds a search query from them.

**Step 3 — The Go sidecar embeds that query.** It calls the Gemini Embedding API to turn text into a 768-dimensional vector (a list of numbers that captures meaning).

**Step 4 — HNSW finds the top-K most similar past episodes.** HNSW is a fast approximate nearest-neighbor algorithm — think of it as a "find me the most similar thing" engine that works in milliseconds, even over thousands of memories.

**Step 5 — Matching episodes are injected into the system prompt.** The AI sees them before reading your message, so the reply naturally includes historical context.

```mermaid
sequenceDiagram
    participant You
    participant OpenClaw
    participant TS as Plugin (TypeScript)
    participant Go as Go Sidecar
    participant DB as Pebble DB + HNSW

    You->>OpenClaw: Send a message
    OpenClaw->>TS: assemble() fires
    TS->>TS: Build query from last 5 messages
    TS->>Go: RPC: recall(query, k=5)
    Go->>Go: Gemini Embedding API
    Go->>DB: Vector search, top-K episodes
    DB-->>Go: Matching episode bodies
    Go-->>TS: Results
    TS->>OpenClaw: Prepend episodes to system prompt
    OpenClaw->>You: AI replies with full historical context
```

![Sequence diagram: episodic recall flow](docs/sequenceDiagram.png)

And in the background, new episodes are being saved:

**Step A — Surprise Score detects a topic change.** After each turn, the plugin checks: did the conversation just shift to a new topic? If yes, the current buffer is sealed and saved as an episode.

**Step B — Text chunks → Go sidecar → Gemini Embedding → Pebble DB.** The episode text is embedded and stored with its vector, ready to be retrieved in future conversations.

```mermaid
flowchart LR
    A[New messages arrive] --> B[EventSegmenter checks Surprise Score]
    B -->|Score above 0.2 OR buffer above 7200 chars| C[Episode boundary detected]
    C --> D[Buffer split into chunks]
    D --> E[Go sidecar: Gemini Embedding]
    E --> F[Pebble DB stores episode\nHNSW indexes the vector]
    B -->|Score low| G[Keep buffering messages]
```

![Flowchart: episode save pipeline](docs/flowchart.png)

---

## Memory Hierarchy (D0 / D1)

> **TL;DR:** D0 is a raw diary entry. D1 is the book summary you'd read instead of the whole diary.

### D0 — Raw Episodes

Every time the Surprise Score crosses a threshold, the current conversation buffer is saved as a D0 episode. These are verbatim conversation logs — detailed and timestamped.

- Stored in Pebble DB with a full vector embedding
- Auto-tagged: `auto-segmented`, `surprise-boundary`, or `size-limit`
- Instantly retrievable via HNSW vector search

### D1 — Summarized Long-Term Memory (Sleep Consolidation)

Over time, groups of D0 episodes get compressed into D1 summaries by the LLM. Inspired by how human brains consolidate memories during sleep — the gist survives, the noise fades.

- D1 nodes link back to their source D0 episodes
- Use `ep-expand` to drill from a D1 summary back to raw D0 episodes
- Reduces token usage while preserving semantic meaning across long time horizons

### What is Surprise Score?

The plugin computes a **Bayesian Surprise** metric by comparing the embedding of incoming messages against the current buffer. A score above `0.2` means: "this conversation has meaningfully shifted — seal this episode and start a new one."

```
Buffer:   "let's build a todo app in React"
Incoming: "what's the best approach to database indexing?"
→ Surprise: HIGH → episode boundary → save previous episode
```

---

## Install

```bash
openclaw plugins install clawhub:episodic-claw
```

That's it. The plugin auto-wires on startup — no config file to edit, no API keys to set (the Go sidecar uses the Gemini API key already configured in your OpenClaw environment).

---

## Agent Install Prompt

Two prompts below. **First**: give this to an agent (Claude Code, Codex, etc.) to have it install and configure episodic-claw automatically. **Second**: paste into the agent's system prompt so it knows how to use its memory.

### Part 1 — Installation (give this to an agent to run)

```
Please install and configure the episodic-claw memory plugin for my OpenClaw agent.
Follow these steps exactly:

Step 1 — Install the plugin via OpenClaw plugin manager:
  openclaw plugins install clawhub:episodic-claw

Step 2 — Verify the plugin appears in the plugin list:
  openclaw plugins list

Step 3 — If OpenClaw uses a config file (openclaw.config.json or similar),
  make sure episodic-claw is registered. The minimal config entry is:
  {
    "plugins": [
      { "id": "episodic-claw" }
    ]
  }
  If a "plugins" array already exists, just add { "id": "episodic-claw" } to it.

Step 4 — The plugin uses the Gemini API key already set in the OpenClaw environment.
  If GEMINI_API_KEY is not set, set it now:
  export GEMINI_API_KEY="your-key-here"
  (Get a free key at https://aistudio.google.com/app/apikey)

Step 5 — Restart the OpenClaw gateway to apply changes:
  openclaw gateway restart
  (or restart the OpenClaw desktop app if you're using the GUI)

Step 6 — Confirm the plugin is active by checking gateway logs for:
  [Episodic Memory] Plugin registered.
  [Episodic Memory] Gateway started.

The plugin is now running. No further configuration is needed.
```

### Part 2 — System Prompt (paste into the agent's system prompt)

```
You have long-term episodic memory powered by the episodic-claw plugin.

Your memory tools:
- ep-recall <query>   — Search your memory for anything relevant to a topic
- ep-save <content>   — Save something important that you want to remember later
- ep-expand <slug>    — Expand a memory summary to read its full contents

How to use them well:
- Before answering questions that might benefit from past context, run ep-recall first.
- After completing something meaningful (a key decision, a fix, a preference learned),
  run ep-save to make sure it sticks.
- When a recalled memory summary is too brief and you need more detail, run ep-expand.
- You also have automatic memory: relevant past episodes are already injected at the top
  of every system prompt under "--- My Memory ---". Read those first before calling
  ep-recall manually.
- Your memory is stored locally and privately — it never leaves the machine.

The episodic-claw plugin runs silently in the background. You don't need to manage it.
Just use the tools when they make sense.
```

---

## The 3 Memory Tools

### `ep-recall` — Manual memory search

> Ask the AI to dig up a specific memory by topic or keyword.

The AI uses this when auto-retrieval isn't surfacing the right context, or when you explicitly ask it to remember something.

```
You:  "Do you remember the database schema we agreed on last week?"
AI:   [calls ep-recall → query: "database schema decision"]
AI:   "Yes — on [date] we settled on a normalized schema with a users table..."
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | What to search for |
| `k` | number | No | How many episodes to return (default: 3) |

---

### `ep-save` — Manual memory save

> Tell the AI "remember this" and it saves it immediately.

```
You:  "Remember that we're using PostgreSQL for this project, not SQLite."
AI:   [calls ep-save]
AI:   "Got it — filed that away."
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | What to save (natural language, up to ~3600 chars) |
| `tags` | string[] | No | Optional tags like `["decision", "database"]` |

---

### `ep-expand` — Expand a summary to raw episodes

> When the AI has a compressed summary but needs full details, this fetches them.

```
You:  "What exactly happened during the auth debugging session?"
AI:   [finds a summary, calls ep-expand to retrieve the full episode]
AI:   "Here's the full breakdown: ..."
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `slug` | string | Yes | The ID/slug of the summary episode to expand |

---

## Configuration

All keys are optional. Defaults work well for most agents.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable or disable the plugin entirely |
| `reserveTokens` | integer | `6144` | Max tokens reserved for injected memories in the system prompt |
| `recentKeep` | integer | `30` | Recent turns to keep during context compaction |
| `dedupWindow` | integer | `5` | Dedup window for fallback-repeated messages. Increase to 10+ in high-fallback environments |
| `maxBufferChars` | integer | `7200` | Character threshold that forces an episode save regardless of Surprise Score |
| `maxCharsPerChunk` | integer | `9000` | Max chars per episode chunk. Setting this below `maxBufferChars` splits one flush into multiple episodes |
| `sharedEpisodesDir` | string | — | *(Planned — Phase 6)* Shared episodes dir across multiple agents. No effect yet |
| `allowCrossAgentRecall` | boolean | — | *(Planned — Phase 6)* Include other agents' episodes in recall. No effect yet |

**Example config:**

```json
{
  "plugins": [
    {
      "id": "episodic-claw",
      "config": {
        "reserveTokens": 4096,
        "recentKeep": 20,
        "maxBufferChars": 5000
      }
    }
  ]
}
```

---

## Research Foundation

This plugin is built on top of real AI memory research. If you want to go deeper:

- **EM-LLM** — Human-Like Episodic Memory for Infinite Context LLMs
  Watson et al., 2024 · [arXiv:2407.09450](https://arxiv.org/abs/2407.09450)
  The inspiration for surprise-based episode segmentation. EM-LLM uses Bayesian surprise and contiguity to form human-like memory boundaries.

- **MemGPT** — Towards LLMs as Operating Systems
  Packer et al., 2023 · [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)
  The idea that an agent should have tiered memory and be able to manage it via explicit function calls. ep-recall, ep-save, ep-expand are this concept implemented as an OpenClaw plugin.

- **Position Paper** — Agent Memory Systems
  2025 · [arXiv:2502.06975](https://arxiv.org/abs/2502.06975)
  A survey of agent memory architectures covering episodic, semantic, and procedural memory. Informed the D0/D1 hierarchy design.

---

## About

I'm a self-taught AI nerd, currently living my best NEET life — no corporate team, no funding, just me, an AI co-pilot, and too many browser tabs open at 2am.

episodic-claw is **100% vibe coded**. I described what I wanted to an AI, argued when it was wrong, and kept iterating until it worked. The architecture is real, the research is real, the bugs were painfully real.

I built this because I think AI agents deserve better memory than a rolling context window. If episodic-claw makes your agent noticeably smarter, that's the whole point.

### Sponsor

Keeping this going requires a Claude or OpenAI Codex subscription — that's what writes the code. If you're finding this useful, even $5/month genuinely helps.

**Planned future updates:**
- **Cross-agent recall** — share memory across multiple agents
- **Memory decay** — low-relevance old episodes fade automatically
- **Web UI** — browse and edit your agent's memory visually

👉 **[GitHub Sponsors](https://github.com/sponsors/YoshiaKefasu)**

No pressure. The plugin will always be MPL-2.0 licensed and free.

---

## License

[Mozilla Public License 2.0 (MPL-2.0)](LICENSE) © 2026 YoshiaKefasu

**Why MPL 2.0 and not MIT?**

MIT lets anyone take this code, improve it, and never give those improvements back. That's fine for libraries, but for a memory plugin that people will build real workflows on top of, I'd rather forks stay open.

MPL 2.0 is a file-level copyleft: if you modify any `.ts` or `.go` source file in this repo, those modified files must stay open source under MPL. But you can freely combine episodic-claw with your own proprietary code — the copyleft doesn't spread to your codebase. You can build a commercial product using episodic-claw; you just can't silently improve the plugin itself and close the source.

The goal is simple: **improvements to episodic-claw come back to the community.**

---

*Built with OpenClaw · Powered by Gemini Embeddings · Stored with HNSW + Pebble DB*
