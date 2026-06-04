// test_snapshot_pipeline.ts — Unit + e2e tests for the forgotten-episode snapshot
// pipeline (Phase 3.2). Uses the project's existing assert-style test
// pattern (run via `npx tsx test_snapshot_pipeline.ts`).
//
// Coverage:
//   1. episode-extract      — stripFrontmatter, readEpisodeBody, cap
//   2. snapshot-guardrail   — all 5 rules + stripListPrefix + matchesExpectedLang
//   3. snapshot-file-writer — counter pickup, format, path
//   4. snapshot-worker      — per-item delete semantics, kill switch
//   5. snapshot-scheduler   — lock (test seam)
//   6. e2e                  — full sweep through all phases

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { stripFrontmatter, readEpisodeBody, EPISODE_SNAPSHOT_TEXT_CAP } from "./src/episode-extract.ts";
import { checkGuardrailV2, matchesExpectedLang, stripListPrefix } from "./src/snapshot-guardrail.ts";
import { writeSnapshotFile, type SnapshotLine } from "./src/snapshot-file-writer.ts";
import { runSnapshotSweep, isSnapshotWorkerDisabled } from "./src/snapshot-worker.ts";
import { SnapshotScheduler } from "./src/snapshot-scheduler.ts";
import type { EpisodicCoreClient } from "./src/rpc-client.ts";

// ────────────────────────────────────────────────────────────────────────
// 1. episode-extract
// ────────────────────────────────────────────────────────────────────────

assert.equal(stripFrontmatter("---\nid: foo\n---\nHello body\nLine2"), "Hello body\nLine2", "stripFrontmatter: removes leading --- block");
assert.equal(stripFrontmatter("Just plain text\nNo dashes"), "Just plain text\nNo dashes", "stripFrontmatter: returns original when no frontmatter");
assert.equal(stripFrontmatter("---\nid: foo\nNo closing"), "---\nid: foo\nNo closing", "stripFrontmatter: handles unclosed frontmatter");

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-ext-"));
  const fp = path.join(dir, "ep.md");
  const longBody = "x".repeat(8000);
  fs.writeFileSync(fp, `---\nid: foo\n---\n${longBody}`, "utf8");
  const body = readEpisodeBody(fp);
  assert.ok(body.length <= EPISODE_SNAPSHOT_TEXT_CAP, `body length ${body.length} should be <= ${EPISODE_SNAPSHOT_TEXT_CAP}`);
  assert.equal(body, "x".repeat(EPISODE_SNAPSHOT_TEXT_CAP), "readEpisodeBody: caps length");
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(readEpisodeBody("/nonexistent/path/foo.md"), "", "readEpisodeBody: missing file returns empty");

// ────────────────────────────────────────────────────────────────────────
// 2. snapshot-guardrail
// ────────────────────────────────────────────────────────────────────────

{
  const r = checkGuardrailV2("", "ja");
  assert.equal(r.ok, false, "guardrail: non_empty");
  assert.equal(r.rule, "non_empty");
  assert.equal(r.reask, undefined);
}

{
  const r = checkGuardrailV2("Sure, the user asked about Episodic.", "en");
  assert.equal(r.ok, false, "guardrail: no_cot_prefix");
  assert.equal(r.rule, "no_cot_prefix");
  assert.ok(r.reask && r.reask.length > 0);
}

{
  const r = checkGuardrailV2("I cannot summarize this content.", "en");
  assert.equal(r.ok, false, "guardrail: no_refusal");
  assert.equal(r.rule, "no_refusal");
  assert.ok(r.reask && r.reask.length > 0);
}

{
  const r = checkGuardrailV2("Line one\nLine two", "en");
  assert.equal(r.ok, false, "guardrail: one_line");
  assert.equal(r.rule, "one_line");
  assert.ok(r.reask && r.reask.length > 0);
}

{
  const r = checkGuardrailV2("This is a summary in English.", "ja");
  assert.equal(r.ok, false, "guardrail: language_match (ja expected, en given)");
  assert.equal(r.rule, "language_match");
  assert.ok(r.reask && r.reask.includes("ja"));
}

{
  const r = checkGuardrailV2("エピソードの要約です。", "ja");
  assert.equal(r.ok, true, "guardrail: language_match (ja given, ja passes)");
}

// matchesExpectedLang
assert.equal(matchesExpectedLang("こんにちは", "ja"), true, "ja: hiragana");
assert.equal(matchesExpectedLang("カタカナ", "ja"), true, "ja: katakana");
assert.equal(matchesExpectedLang("漢字", "ja"), true, "ja: kanji");
assert.equal(matchesExpectedLang("Hello world", "ja"), false, "ja: ascii fails");
assert.equal(matchesExpectedLang("Hello world", "en"), true, "en: ascii passes");
assert.equal(matchesExpectedLang("こんにちは", "en"), false, "en: ja fails");
assert.equal(matchesExpectedLang("anything goes", "fr"), true, "unknown lang: no false positive");

// stripListPrefix
assert.equal(stripListPrefix("- foo"), "foo", "strip: -");
assert.equal(stripListPrefix("* bar"), "bar", "strip: *");
assert.equal(stripListPrefix("1. baz"), "baz", "strip: 1.");
assert.equal(stripListPrefix("qux"), "qux", "strip: no prefix");

// ────────────────────────────────────────────────────────────────────────
// 3. snapshot-file-writer
// ────────────────────────────────────────────────────────────────────────

function makeMockRpcClient(opts: { counterByYear: Map<string, number> }): EpisodicCoreClient {
  const c: any = {
    snapshotCounterIncrement: async (year: string) => {
      const next = (opts.counterByYear.get(year) ?? 0) + 1;
      opts.counterByYear.set(year, next);
      return { number: next };
    },
  };
  return c as EpisodicCoreClient;
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-fw-"));
  const counter = new Map<string, number>();
  const client = makeMockRpcClient({ counterByYear: counter });
  const result = await writeSnapshotFile(client, dir, "2026", "06", []);
  assert.equal(result.written, false, "writeSnapshotFile: empty buffer");
  assert.equal(counter.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-fw-"));
  const counter = new Map<string, number>();
  const client = makeMockRpcClient({ counterByYear: counter });
  const lines: SnapshotLine[] = [
    { stem: "episode-2026-05-01T12-00-00-000000", summary: "エピソードの要約です。" },
    { stem: "episode-2026-04-15T08-30-00-000000", summary: "Another summary." },
  ];
  const result = await writeSnapshotFile(client, dir, "2026", "06", lines);
  assert.equal(result.written, true, "writeSnapshotFile: writes file");
  assert.equal(result.number, 1);
  assert.ok(result.path);
  // agentWs IS the episodes directory; output is {agentWs}/{year}/{month}/.
  // dir is the temp directory which simulates agentWs (already the "episodes" root).
  assert.ok(result.path!.includes(`${dir}${path.sep}2026${path.sep}06`), "path under agentWs/2026/06/");
  assert.ok(result.path!.endsWith("memory-that-ive-forgotten-0001.md"), "filename with 4-digit counter");

  const body = fs.readFileSync(result.path!, "utf8");
  assert.ok(body.includes("episode-2026-05-01T12-00-00-000000 — エピソードの要約です。"), "line 1 format");
  assert.ok(body.includes("episode-2026-04-15T08-30-00-000000 — Another summary."), "line 2 format");
  assert.ok(body.endsWith("\n"), "trailing newline");

  // Second call increments to 2
  const result2 = await writeSnapshotFile(client, dir, "2026", "06", [{ stem: "x", summary: "y" }]);
  assert.equal(result2.number, 2, "counter increments");
  assert.ok(result2.path!.endsWith("memory-that-ive-forgotten-0002.md"));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────────
// 4. snapshot-worker
// ────────────────────────────────────────────────────────────────────────

function makeMockFullClient(opts: {
  counterByYear: Map<string, number>;
  candidates: Array<{ id: string; path: string }>;
  llmText?: string;
  llmShouldFail?: boolean;
  stateStore?: Map<string, string>;
}): EpisodicCoreClient {
  const stateStore = opts.stateStore ?? new Map<string, string>();
  const c: any = {
    snapshotCounterIncrement: async (year: string) => {
      const next = (opts.counterByYear.get(year) ?? 0) + 1;
      opts.counterByYear.set(year, next);
      return { number: next };
    },
    llmGenerate: async () => {
      if (opts.llmShouldFail) {
        throw new Error("simulated LLM failure");
      }
      return { text: opts.llmText ?? "エピソードの要約です。", model: "gemini-main" };
    },
    stateGet: async (key: string) => stateStore.get(key) ?? "",
    stateSet: async (key: string, value: string) => {
      stateStore.set(key, value);
      return true;
    },
    listForgottenEpisodes: async () => ({ records: opts.candidates, count: opts.candidates.length }),
  };
  return c as EpisodicCoreClient;
}

{
  // per-item delete regardless of LLM success
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  const c1 = path.join(dir, "episode-c1.md");
  const c2 = path.join(dir, "episode-c2.md");
  fs.writeFileSync(c1, "---\nid: c1\n---\nBody c1", "utf8");
  fs.writeFileSync(c2, "---\nid: c2\n---\nBody c2", "utf8");

  const candidates = [
    { id: "c1", path: c1 },
    { id: "c2", path: c2 },
  ];
  const client = makeMockFullClient({ counterByYear: new Map(), candidates, llmShouldFail: true });

  const unlinks: string[] = [];
  const result = await runSnapshotSweep({
    client,
    agentWs: dir,
    llmTimeoutMs: 100,
    list: async () => candidates,
    unlink: (p: string) => {
      unlinks.push(p);
      try { fs.unlinkSync(p); } catch {}
      return true;
    },
  });

  assert.equal(result.candidates, 2);
  assert.equal(result.summarised, 0, "LLM failed → 0 summarised");
  assert.equal(result.deleted, 2, "both sources deleted");
  assert.equal(result.fileWritten, false, "no file written when 0 lines");
  assert.equal(unlinks.length, 2, "both sources unlinked");
  assert.equal(unlinks[0], c1);
  assert.equal(unlinks[1], c2);
  assert.equal(fs.existsSync(c1), false);
  assert.equal(fs.existsSync(c2), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // Success path: writes 1 file, deletes all
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  const c1 = path.join(dir, "episode-c1.md");
  fs.writeFileSync(c1, "---\nid: c1\n---\nThis is the body of episode 1.", "utf8");

  const candidates = [{ id: "c1", path: c1 }];
  const client = makeMockFullClient({ counterByYear: new Map(), candidates, llmText: "エピソード1の要約。" });
  const unlinks: string[] = [];
  const result = await runSnapshotSweep({
    client,
    agentWs: dir,
    llmTimeoutMs: 100,
    list: async () => candidates,
    unlink: (p: string) => { unlinks.push(p); try { fs.unlinkSync(p); } catch {} return true; },
  });

  assert.equal(result.candidates, 1);
  assert.equal(result.summarised, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.fileWritten, true);
  assert.ok(result.filePath);
  assert.ok(result.filePath!.endsWith("memory-that-ive-forgotten-0001.md"));
  assert.equal(unlinks.length, 1);
  assert.equal(fs.existsSync(c1), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // [v0.4.34] ENOENT unlink contract: already-absent file counts as "cleaned up" (deleted++).
  // The mock unlink simulates the production fs.unlinkSync + ENOENT path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  // c1 does not exist on disk — unlink will throw ENOENT.
  const c1 = path.join(dir, "episode-missing.md");
  const candidates = [{ id: "c1", path: c1 }];
  const client = makeMockFullClient({ counterByYear: new Map(), candidates, llmText: "要約。" });
  const unlinks: string[] = [];
  const result = await runSnapshotSweep({
    client,
    agentWs: dir,
    llmTimeoutMs: 100,
    list: async () => candidates,
    unlink: (p: string) => {
      unlinks.push(p);
      try { fs.unlinkSync(p); return true; }
      catch (err: any) {
        if (err && err.code === "ENOENT") return true;  // already absent
        return false;
      }
    },
  });
  assert.equal(result.candidates, 1);
  assert.equal(result.deleted, 1, "ENOENT must count as deleted per contract");
  assert.equal(unlinks.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // Zero candidates = no-op
  const client = makeMockFullClient({ counterByYear: new Map(), candidates: [] });
  const result = await runSnapshotSweep({
    client,
    agentWs: "/tmp/whatever",
    list: async () => [],
  });
  assert.equal(result.candidates, 0);
  assert.equal(result.fileWritten, false);
}

{
  const v = isSnapshotWorkerDisabled();
  assert.equal(typeof v, "boolean", "isSnapshotWorkerDisabled returns boolean");
}

// ────────────────────────────────────────────────────────────────────────
// 5. snapshot-scheduler
// ────────────────────────────────────────────────────────────────────────

{
  const client = makeMockFullClient({ counterByYear: new Map(), candidates: [] });
  const sched = new SnapshotScheduler("/tmp/sched-test");
  sched.setClient(client);

  assert.equal(sched.isSweepInProgress, false, "lock initially free");
  const p = sched.runNow("manual");
  assert.equal(sched.isSweepInProgress, true, "lock held while sweep running");
  const result = await p;
  assert.equal(result?.candidates, 0);
  assert.equal(sched.isSweepInProgress, false, "lock released after sweep");
}

{
  // Second runNow is dropped while first is in flight
  const client = makeMockFullClient({ counterByYear: new Map(), candidates: [] });
  const sched = new SnapshotScheduler("/tmp/sched-test-2");
  sched.setClient(client);

  const first = sched.runNow("manual");
  const second = await sched.runNow("manual");
  assert.equal(second, null, "second runNow dropped while first in flight");
  await first;
}

// ────────────────────────────────────────────────────────────────────────
// 6. e2e
// ────────────────────────────────────────────────────────────────────────

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-e2e-"));
  const c1 = path.join(dir, "ep-2025-05-01T12-00-00-000000.md");
  const c2 = path.join(dir, "ep-2025-05-02T09-30-00-000000.md");
  fs.writeFileSync(c1, "---\nid: ep1\n---\nFirst body content.", "utf8");
  fs.writeFileSync(c2, "---\nid: ep2\n---\nSecond body content.", "utf8");

  const candidates = [
    { id: "ep1", path: c1 },
    { id: "ep2", path: c2 },
  ];
  const client = makeMockFullClient({ counterByYear: new Map(), candidates, llmText: "テスト要約センテンス。" });
  const unlinks: string[] = [];

  const result = await runSnapshotSweep({
    client,
    agentWs: dir,
    llmTimeoutMs: 100,
    list: async () => candidates,
    unlink: (p: string) => { unlinks.push(p); try { fs.unlinkSync(p); } catch {} return true; },
  });

  assert.equal(result.candidates, 2);
  assert.equal(result.summarised, 2);
  assert.equal(result.deleted, 2);
  assert.equal(result.fileWritten, true);
  assert.equal(unlinks.length, 2);
  assert.equal(fs.existsSync(c1), false);
  assert.equal(fs.existsSync(c2), false);
  assert.ok(result.filePath);
  const body = fs.readFileSync(result.filePath!, "utf8");
  assert.ok(body.includes("ep-2025-05-01T12-00-00-000000 — テスト要約センテンス。"), "e2e line 1");
  assert.ok(body.includes("ep-2025-05-02T09-30-00-000000 — テスト要約センテンス。"), "e2e line 2");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("[ok] test_snapshot_pipeline: all assertions passed");
