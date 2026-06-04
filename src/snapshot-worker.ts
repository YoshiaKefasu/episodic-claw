// src/snapshot-worker.ts — Phase 1-3 of the weekly forgotten-episode snapshot sweep.
//
// Phase 1: Go already marked candidates as PruneState="forgotten".
//          We just list them via episode.listForgottenEpisodes.
// Phase 2: For each candidate, 1-by-1:
//          - read body (frontmatter excluded, capped)
//          - run LLM chain (gemini-main 1-2 attempts → gemma-main 1-2 attempts)
//          - guardrail check; ReAsk on failure (single line / language mismatch)
//          - per-item physical delete via fs.unlinkSync (IsNotExist OK)
//          - append to line buffer on success
// Phase 3: write one file via snapshot-file-writer (skip if buffer empty)
//
// The worker is sequential (v1). Each item is summary-attempted, deleted
// regardless of snapshot success, and never re-leased.
//
// Logging: gated by DEBUG_EPISODIC_SNAPSHOT (consistent with
// DEBUG_EPISODIC_WAL / DEBUG_EPISODIC_RECALL_FINGERPRINT pattern).

import * as fs from "fs";

import { getEnvVal } from "./env-var";
import type { EpisodicCoreClient } from "./rpc-client";
import { readEpisodeBody, EPISODE_SNAPSHOT_TEXT_CAP } from "./episode-extract";
import { checkGuardrailV2, stripListPrefix, type GuardrailResult } from "./snapshot-guardrail";
import { writeSnapshotFile, type SnapshotLine } from "./snapshot-file-writer";

const PROMPT_HEADER =
  "次のエピソードを1センテンスの要約(40〜80字程度)に変換してください。出力は要約そのもの1行だけ。前置き・解説・箇条書きは不要。";

function logDebug(payload: string | Record<string, unknown>): void {
  if (getEnvVal("DEBUG_EPISODIC_SNAPSHOT")) {
    if (typeof payload === "string") {
      console.log(`[snapshot-worker] ${payload}`);
    } else {
      console.log(`[snapshot-worker] ${JSON.stringify(payload)}`);
    }
  }
}

/**
 * Run one LLM call through Go and apply the guardrail. Returns a guardrail
 * result; the worker decides whether to ReAsk, advance to the next model,
 * or accept the line.
 */
async function callOnce(
  client: EpisodicCoreClient,
  model: "gemini-main" | "gemma-main",
  prompt: string,
  timeoutMs: number
): Promise<{ result: GuardrailResult; raw: string }> {
  try {
    const { text } = await client.llmGenerate(model, prompt, timeoutMs);
    return { result: checkGuardrailV2(text, "ja"), raw: text };
  } catch (err) {
    // Treat any RPC error as a non_empty failure so the worker advances
    // to the next model. The error is logged by the RPC client.
    logDebug({ event: "llm_rpc_error", model, err: err instanceof Error ? err.message : String(err) });
    return { result: { ok: false, rule: "non_empty" }, raw: "" };
  }
}

/**
 * Build the prompt for an LLM call. The first attempt uses the bare
 * PROMPT_HEADER; subsequent ReAsk attempts append the reask suffix.
 */
function buildPrompt(body: string, reask?: string): string {
  const base = `${PROMPT_HEADER}\n\n${body}`;
  return reask ? `${base}\n\n${reask}` : base;
}

/**
 * Run the LLM chain for a single candidate. Tries up to 2 ReAsk attempts
 * per model before moving on. Returns the final accepted summary line
 * (or null if all 4 attempts failed).
 */
async function summarise(
  client: EpisodicCoreClient,
  body: string,
  timeoutMs: number
): Promise<string | null> {
  for (const model of ["gemini-main", "gemma-main"] as const) {
    let lastReask: string | undefined = undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = buildPrompt(body, lastReask);
      const { result, raw } = await callOnce(client, model, prompt, timeoutMs);
      if (result.ok) {
        return stripListPrefix(raw);
      }
      if (result.rule === "non_empty") {
        // Empty / RPC error: try the next attempt or next model. No ReAsk helps.
        continue;
      }
      // ReAsk-eligible failure: append the suffix on the next attempt.
      lastReask = result.reask;
    }
  }
  return null;
}

export interface SnapshotSweepInput {
  client: EpisodicCoreClient;
  agentWs: string;
  /** ISO-ish language tag for the guardrail (default "ja"). */
  expectedLang?: string;
  /** Per-call LLM timeout in ms (default 30000). */
  llmTimeoutMs?: number;
  /** Override year/month for output path (default = local now). */
  now?: Date;
  /** Optional override for the source-list RPC (used by tests). */
  list?: () => Promise<Array<{ id: string; path: string }>>;
  /** Optional override for the unlink step (used by tests).
   *  Return true if the file was actually unlinked (or already absent —
   *  both count as "cleaned up"); false only on a real error. */
  unlink?: (path: string) => boolean;
}

export interface SnapshotSweepResult {
  candidates: number;
  summarised: number;
  deleted: number;
  fileWritten: boolean;
  filePath?: string;
  durationMs: number;
}

/**
 * Run one full sweep. Always sequential: each item is fully attempted
 * (summary + delete) before the next item is processed.
 */
export async function runSnapshotSweep(input: SnapshotSweepInput): Promise<SnapshotSweepResult> {
  const start = Date.now();
  const client = input.client;
  const expectedLang = input.expectedLang ?? "ja";
  const llmTimeoutMs = input.llmTimeoutMs ?? 30000;
  const now = input.now ?? new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");

  const list = input.list ?? (async () => {
    const { records } = await client.listForgottenEpisodes(input.agentWs, 1000);
    return records.map((r) => ({ id: r.id, path: r.path }));
  });

  const unlink = input.unlink ?? ((p: string) => {
    try {
      fs.unlinkSync(p);
      return true;
    } catch (err: any) {
      if (err && err.code === "ENOENT") {
        // Already absent — counts as "cleaned up" per contract.
        return true;
      }
      // Real error: surface to log, count as not-deleted, but continue loop.
      logDebug({ event: "unlink_failed", path: p, err: err?.message ?? String(err) });
      return false;
    }
  });

  const candidates = await list();
  if (candidates.length === 0) {
    return { candidates: 0, summarised: 0, deleted: 0, fileWritten: false, durationMs: Date.now() - start };
  }

  const lines: SnapshotLine[] = [];
  let deleted = 0;
  let summarised = 0;

  for (const c of candidates) {
    // 1. read body (frontmatter excluded, capped)
    const body = readEpisodeBody(c.path, EPISODE_SNAPSHOT_TEXT_CAP);
    if (body) {
      // 2. summarise (with 4-attempt chain)
      const summary = await summarise(client, body, llmTimeoutMs);
      if (summary) {
        // derive stem from SourcePath basename, drop ".md"
        const stem = c.path.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? c.id;
        lines.push({ stem, summary });
        summarised++;
      }
    }
    // 3. per-item physical delete regardless of snapshot success
    if (unlink(c.path)) {
      deleted++;
    }
  }

  // Phase 3: write one file (no-op if buffer empty)
  const result = await writeSnapshotFile(client, input.agentWs, year, month, lines);

  logDebug({
    event: "sweep_completed",
    candidates: candidates.length,
    summarised,
    deleted,
    fileWritten: result.written,
    filePath: result.path ?? null,
    durationMs: Date.now() - start,
  });

  return {
    candidates: candidates.length,
    summarised,
    deleted,
    fileWritten: result.written,
    filePath: result.path,
    durationMs: Date.now() - start,
  };
}

/** True if the worker has been disabled via the kill switch env var. */
export function isSnapshotWorkerDisabled(): boolean {
  return getEnvVal("EPISODIC_DISABLE_SNAPSHOT_WORKER") === "1";
}
