Your repo (episodic-claw) is a solid TypeScript + Go sidecar setup for turning raw agent-user ping-pong chats into continuous **narrative episodes** (story-like episodic memory). The background worker already drains the cache and asks an LLM to convert chunks into coherent stories that preserve continuity and language.

The core pain point you described — cheap/free OpenRouter models often being "lazy" and outputting just one short line instead of a proper multi-sentence/paragraph narrative — is very common with lower-tier models on router platforms.

Here are the most practical libraries and techniques to filter/reject bad (too-short or low-quality) outputs, specifically tailored to your story summarization/narrative generation step.

### 1. Best Overall Recommendation: **Guardrails AI** (Python)
Even though your main stack is TS/Go, this is the strongest dedicated library for exactly your use case.

- It lets you define rules for output quality, including:
  - Minimum length (word count, sentence count, or estimated reading time)
  - Semantic similarity to the original chat chunk (so the "story" actually covers the events)
  - Coherence, toxicity, or custom narrative quality checks
  - Automatic re-prompting or retry if the output fails validation
- There are ready-made examples for **summarization** that enforce length + quality.
- You can wrap your LLM call (OpenRouter via OpenAI-compatible client) with a Guard, and it will keep retrying (with feedback like "Your previous output was too short — please write a detailed narrative episode of at least 150–300 words") until it passes.

**Why it fits you perfectly**:
- Handles the exact "lazy one-line" problem by rejecting short outputs and forcing the model to expand.
- Works great with cheaper models because the validation + retry loop compensates for their laziness.
- You can run a small Python microservice/sidecar (similar to your Go one) just for the episode generation step, then feed validated narratives back to your Go/Pebble layer.

Quick start idea (Python):
```python
from guardrails import Guard
from guardrails.hub import ValidLength, SimilarToDocument  # or custom validators

guard = Guard().use(
    ValidLength, min_words=150, max_words=800, on_fail="reask",  # adjust to your needs
    SimilarToDocument, document=original_chat_chunk, threshold=0.7,  # ensures it actually summarizes the events
)

validated_output = guard(
    llm_call,  # your OpenRouter call
    prompt=your_narrative_prompt,
    max_retries=3
)
```

There’s also a **Guardrails Hub** with community validators for summarization quality.

### 2. Simple & Lightweight Alternatives (No Heavy Framework)
If you want to stay closer to your current stack or avoid adding a full guardrails layer:

- **Pydantic + custom validators** (very popular for LLM output)
  - Define a Pydantic model with a `narrative_text: str` field and a `@field_validator` that checks `len(text.split()) >= 120` or counts sentences.
  - On validation error, re-prompt the LLM with the error message appended ("The previous response was only 12 words. Please write a full episodic story...").
  - Works beautifully with OpenRouter's OpenAI-compatible endpoint.

- **Instructor** (built on Pydantic)
  - Makes structured + validated outputs extremely easy. You can force the output to be a rich object containing the story + metadata (length, key events, etc.).
  - Excellent retry logic built-in.

- **Outlines** or **Guidance** (Microsoft)
  - These give you more control over generation itself (regex, JSON schema, etc.) so you can constrain the model to produce longer, structured narratives from the start.

### 3. Non-Library Techniques You Can Add Today (Quick Wins)
These require almost no new dependencies and work well with cheap models:

1. **Stronger prompting** (often 70% of the fix):
   - Be very explicit: "Write a detailed, story-like episodic narrative in 200–400 words. Describe the key events, dialogue highlights, emotions, and outcomes as if it's a chapter in a TV series. Do not output only one sentence."
   - Add few-shot examples of good vs. bad outputs in the prompt.
   - Use chain-of-thought: "First list the main events from the chat, then expand them into a flowing narrative."

2. **Post-generation filtering + retry loop** (easy to implement in your Go/TS worker):
   - After getting the response, check:
     - Word count > threshold (e.g., 120–150 words)
     - Sentence count > 4–5
     - Contains at least one reference to specific chat elements (simple keyword or embedding similarity)
   - If it fails → re-call the same LLM with a corrective prompt that includes the bad output + instructions to fix it.
   - Add exponential backoff and a max retry count (3–5) to avoid infinite loops.

3. **Model routing fallback**:
   - Try the cheapest model first.
   - If the output fails your quality gate twice → automatically switch to a slightly better (still free/cheap) model on OpenRouter for that episode.

4. **Your existing test files**:
   - You already have `test_narrative_quality_gate.ts` and sanitization tests. Extend those into a runtime gate that rejects one-liners before saving to Pebble DB.

### Recommendation for Your Architecture
- Keep the current cache-and-drain flow in Go/TS.
- For the critical "convert chunk → narrative episode" step, either:
  - Add a lightweight Python sidecar using **Guardrails AI** or **Instructor + Pydantic** (communicate via RPC/HTTP like you already do).
  - Or implement a simple retry loop + length/similarity check directly in Go (using a small embedding check with your existing Gemini embeddings).

Guardrails AI is the most "batteries-included" for catching lazy/short outputs while also improving overall narrative quality and faithfulness to the original chat.

If you want code snippets tailored to your OpenRouter usage + episodic narrative prompt, or help deciding between a Python sidecar vs. pure Go/TS implementation, just share more details (e.g., your current episode generation prompt or how you call the LLM). I can also suggest specific validators for story-like quality.

This should dramatically reduce the one-line garbage while keeping costs low on free OpenRouter models.

---

i want clean Simple & Lightweight, but if Guardrails AI can gave best result why not? gave me the trade off explanation?

---

**Clean & Simple Recommendation (fits your TS + Go stack perfectly):**  
Stick with **lightweight, zero-new-dependency** approach using what you already have.

You already ship `test_narrative_quality_gate.ts` and `test_sanitize_narrative.ts` — just promote that logic into **runtime** in your background worker (the Go sidecar or the TS part that calls OpenRouter).  

This is the cleanest possible solution for your exact problem (lazy one-line outputs from cheap OpenRouter models).

### Trade-off Explanation (Simple vs Guardrails AI)

| Aspect                  | **Simple/Lightweight (your current stack)** | **Guardrails AI (Python)** |
|-------------------------|---------------------------------------------|----------------------------|
| **Complexity**          | Almost zero — just add 20-30 lines of code to your existing worker + quality gate | Medium — new Python microservice/sidecar |
| **Dependencies**        | None (pure TS/Go + your OpenRouter client) | Full Python + Guardrails package |
| **Runtime overhead**    | Negligible (just word/sentence count check) | Extra network hop + Python process |
| **Auto-retry power**    | You control the retry loop (easy to implement) | Built-in "reask" with smart feedback |
| **Quality checks**      | Length + basic similarity (you already test this) | Very rich (length, semantic similarity, coherence, toxicity, etc.) |
| **Maintenance**         | You already own the code → stays simple forever | Another language/repo to maintain |
| **Speed of implementation** | 10-15 minutes (you already have the tests) | 1-2 hours + new service |
| **When it shines**      | Exactly your use-case: reject one-liners from cheap models | When you later need 10+ complex rules |
| **Fits your repo**      | 100% (TS/Go only)                          | Requires adding Python layer |

**Verdict for you**:  
Go with the **simple & lightweight** route **first**. It will solve 90% of your "one-line lazy output" problem with almost no friction.  
Only move to Guardrails AI later if you find yourself adding more and more rules (e.g. "must mention at least 3 key events", "must keep original language", "no hallucinated events", etc.).

### How to Implement the Simple Version (copy-paste ready)

In your background worker (where you currently call the LLM for narrative generation), wrap the call like this:

```ts
// Example in TypeScript (or port to Go — same logic)
async function generateNarrativeWithQualityGate(chatChunk: string): Promise<string> {
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    const response = await openRouterClient.chat.completions.create({
      model: "your-cheap-model",
      messages: [{ role: "user", content: buildNarrativePrompt(chatChunk) }],
      temperature: 0.7,
    });

    const rawOutput = response.choices[0].message.content?.trim() || "";

    // ← Your existing quality gate, now at runtime
    if (isNarrativeGoodEnough(rawOutput)) {
      return sanitizeNarrative(rawOutput); // you already have this test
    }

    // Bad output → corrective prompt (this fixes lazy models)
    console.warn(`[QualityGate] Attempt ${attempt + 1} failed: too short or lazy`);
    attempt++;
  }

  throw new Error("Max retries reached — narrative still bad");
}

function isNarrativeGoodEnough(text: string): boolean {
  const words = text.split(/\s+/).length;
  const sentences = (text.match(/[.!?]+/g) || []).length;

  return words >= 120 && sentences >= 4; // tune these numbers
  // Bonus: you can add simple keyword check from original chunk if you want
}
```

**Pro tip for even better results (still lightweight)**  
Update your `buildNarrativePrompt` to be **extremely explicit** (this alone fixes most laziness):

```ts
function buildNarrativePrompt(chatChunk: string) {
  return `You are writing a continuous story-like episodic memory.
Turn the following raw agent-user chat into a detailed narrative episode.

Rules:
- Minimum 150-400 words, at least 6-8 sentences.
- Write like a novel/TV episode chapter (not bullet points).
- Include key events, emotions, dialogue highlights, and outcomes.
- Keep the original language and tone.
- NEVER output only one sentence.

Raw chat:
${chatChunk}

Now write the full episodic narrative:`;
}
```

That’s it.  
This + your existing quality gate will already kill almost all one-line garbage while staying 100% inside your current TS+Go repo.

### If you later want "best possible" without too much pain

You can add **Instructor for TypeScript** (official TS port of the popular Python Instructor/Pydantic pattern).  
It’s still very lightweight, works perfectly with OpenRouter, gives you structured output + auto-retry, and you define the schema once:

```ts
import { z } from "zod";
import Instructor from "@instructor-ai/instructor"; // or Vercel AI SDK equivalent

const NarrativeSchema = z.object({
  episodeText: z.string().min(150).describe("Detailed story-like narrative"),
});

const client = Instructor({ client: openRouterClient });

const result = await client.chat.completions.create({
  model: "...",
  messages: [...],
  response_model: NarrativeSchema, // ← automatic validation + retry
});
```

This is the sweet spot if you want more power than pure manual checks but still stay in TypeScript.

---

im minding can we build my own mini verison clean Simple & Lightweight of Guardrails AI the exact same but only what im needed for the workflow?

---

**Yes — we can build a clean, minimal "MiniGuard" just for your exact workflow.**  

It will be **pure TypeScript**, zero new heavy dependencies (only `zod` if you want structured output — optional), and slot directly into your existing `src/narrative-worker.ts` + background worker.

### MiniGuard Design (Your Needs Only)

- **Length gate** (kills one-liners)
- **Format gate** (already in `checkNarrativeFormat`)
- **Compression / Echo gate** (already in your tests)
- **Relevance** (simple keyword or optional embedding similarity)
- **Auto-retry with smart feedback** (exactly like Guardrails "reask")
- **Sanitize** (you already have this)

### 1. Create `src/mini-guard.ts` (drop-in file)

```ts
// src/mini-guard.ts
import { z } from "zod"; // optional but recommended (npm install zod)
import {
  sanitizeNarrativeOutput,
  checkNarrativeFormat,
  checkCompressionRatio,
  checkEchoDetection,
} from "./narrative-worker";

export interface NarrativeGuardResult {
  pass: boolean;
  reason?: string;
  cleanedText?: string;
}

const NarrativeSchema = z.object({
  episode: z.string().min(120, "Episode must be at least 120 words"),
});

export class MiniNarrativeGuard {
  private maxRetries: number;
  private minWords: number;
  private minSentences: number;

  constructor(options: { maxRetries?: number; minWords?: number; minSentences?: number } = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.minWords = options.minWords ?? 120;
    this.minSentences = options.minSentences ?? 4;
  }

  private countWords(text: string): number {
    return text.trim().split(/\s+/).length;
  }

  private countSentences(text: string): number {
    return (text.match(/[.!?。！？]+/g) || []).length;
  }

  async validateAndRetry(
    generateFn: (feedback?: string) => Promise<string>,
    originalChunk: string
  ): Promise<string> {
    let attempt = 0;
    let lastOutput = "";

    while (attempt < this.maxRetries) {
      const feedback = attempt > 0 
        ? `Previous attempt was bad: "${lastOutput.slice(0, 200)}...". ${this.getFeedback(lastOutput)}`
        : undefined;

      const raw = await generateFn(feedback);
      lastOutput = raw;

      const result = this.check(raw, originalChunk);

      if (result.pass && result.cleanedText) {
        console.log(`[MiniGuard] ✅ Passed on attempt ${attempt + 1}`);
        return result.cleanedText;
      }

      console.warn(`[MiniGuard] ❌ Attempt ${attempt + 1} failed: ${result.reason}`);
      attempt++;
    }

    throw new Error(`[MiniGuard] Max retries reached. Last reason: ${lastOutput}`);
  }

  private check(raw: string, originalChunk: string): NarrativeGuardResult {
    const cleaned = sanitizeNarrativeOutput(raw);

    // 1. Basic length
    const words = this.countWords(cleaned);
    if (words < this.minWords) {
      return { pass: false, reason: `Too short (${words} words)` };
    }

    const sentences = this.countSentences(cleaned);
    if (sentences < this.minSentences) {
      return { pass: false, reason: `Too few sentences (${sentences})` };
    }

    // 2. Your existing strong gates
    const formatCheck = checkNarrativeFormat(cleaned);
    if (!formatCheck.pass) {
      return { pass: false, reason: formatCheck.reason || "Bad format (CoT, list, emoji, etc.)" };
    }

    const echoOk = checkEchoDetection(cleaned, originalChunk);
    if (!echoOk) {
      return { pass: false, reason: "Echo / copy-paste detected" };
    }

    // 3. Compression (your existing logic)
    const inputTokens = Math.ceil(originalChunk.length / 4); // rough
    if (!checkCompressionRatio(words, inputTokens * 10)) { // adjust multiplier
      return { pass: false, reason: "Compression ratio too low (lazy summary)" };
    }

    return { pass: true, cleanedText: cleaned };
  }

  private getFeedback(badOutput: string): string {
    const words = this.countWords(badOutput);
    if (words < 50) {
      return "Write a full detailed story-like episode of 150-400 words with multiple paragraphs. Do not output one line.";
    }
    return "Make it more narrative, remove any thinking steps, add paragraph breaks, and expand the key events.";
  }
}
```

### 2. How to Use It in Your Background Worker

```ts
// In your narrative worker / drain loop
import { MiniNarrativeGuard } from "./mini-guard";

const guard = new MiniNarrativeGuard({ maxRetries: 3, minWords: 130 });

async function processChunk(chunk: any) {
  const rawChat = chunk.content; // your raw ping-pong text

  const narrative = await guard.validateAndRetry(
    async (feedback) => {
      const prompt = buildNarrativePrompt(rawChat, feedback);
      return openRouterClient.chatCompletion({ /* ... */ prompt });
    },
    rawChat
  );

  // Save to Pebble DB
  await saveEpisode(narrative, chunk);
}
```

### Trade-offs of This Mini Version vs Full Guardrails AI

- **Pros (why this wins for you)**:  
  - 100% inside your TS repo  
  - Uses your existing `checkNarrativeFormat`, `sanitize*`, etc.  
  - ~50 lines, no extra process  
  - Instant feedback loop tuned exactly to "lazy one-liner" problem  
  - Easy to extend (add embedding similarity later with your Gemini embeddings)

- **Cons**:  
  - No fancy semantic validators out-of-the-box (you can add later)  
  - You maintain the retry logic (but it's only ~30 lines)

This is **exactly** a lightweight Guardrails for your story summarization workflow.