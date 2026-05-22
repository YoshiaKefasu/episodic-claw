import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

// [v0.4.28b] Shared mock narratives — must satisfy ALL quality gates:
//   G4 (Fmt-G4): multi-paragraph (>=2 paragraphs for >500 chars)
//   G5: CJK >=3 sentences / Latin >=4 sentences (5 for safety margin)
//   G6: CJK >=120 chars (whitespace-stripped) / Latin >=80 words
export const MOCK_CJK_NARRATIVE =
  "彼は深い沈黙の後、画面上のログを注意深く確認した。システムの挙動に違和感を覚え、原因の解析を始めた。" +
  "数分の集中作業の末、バグの根本原因が特定され、修正コードが即座に適用された。" +
  "\n\n" +
  "動作確認テストを実行し、全てのパスが正常に通過することを確認した後、本番環境へのデプロイを承認した。" +
  "その日の夕方には全ての主要機能が安定稼働を確認し、二人は成功を祝った。";
export const MOCK_LATIN_NARRATIVE =
  "The user asked about the weather today. The assistant reported sunny conditions with a high of 25 degrees Celsius, noting that the forecast predicted clear skies for the remainder of the week with no precipitation expected. The conversation then shifted to weekend plans, where they discussed visiting the local farmers market on Saturday morning and attending a community music festival in the park on Sunday afternoon."
  + "\n\n"
  + "Finally, they reviewed upcoming development tasks for the project, agreeing to prioritize the authentication module refactor, the database migration scripts, and the performance optimization ticket before the next sprint review meeting scheduled for Friday. They also decided to set up a pair programming session for the most complex task to ensure knowledge sharing across the team.";

export function readJson(relPath: string): any {
  const absPath = path.resolve(relPath);
  return JSON.parse(fs.readFileSync(absPath, "utf8"));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForLogContains(logPath: string, needles: string[], timeoutMs = 90000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(logPath, "utf8");
      if (needles.every((needle) => text.includes(needle))) {
        return text;
      }
    } catch {}
    await sleep(500); // Increased from 250ms to 500ms to reduce file system pressure
  }
  throw new Error(`Timed out waiting for log entries: ${needles.join(" | ")}`);
}

export async function waitForTextContains(getText: () => string, needles: string[], timeoutMs = 90000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = getText();
    if (needles.every((needle) => text.includes(needle))) {
      return text;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for text entries: ${needles.join(" | ")}`);
}

export function assertLogOrder(text: string, needles: string[]): void {
  let cursor = 0;
  for (const needle of needles) {
    const idx = text.indexOf(needle, cursor);
    assert.ok(idx >= 0, `Expected log entry not found in order: ${needle}`);
    cursor = idx + needle.length;
  }
}

export function loadCompactorCtor(): typeof import("./src/compactor.ts").Compactor {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-compactor-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "compactor.cjs");
  fs.copyFileSync(path.resolve("dist", "compactor.js"), tempCjsPath);
  for (const file of [
    "large-payload.js",
    "untrusted-metadata.js",
    "rpc-client.js",
    "env-var.js",
    "segmenter.js",
    "narrative-pool.js",
    "narrative-queue.js",
    "narrative-worker.js",
    "gemini-direct-client.js",
    "summary-escalation.js",
    "transcript-repair.js",
    "transport-retry.js",
    "types.js",
    "utils.js",
  ]) {
    fs.copyFileSync(path.join("dist", file), path.join(tempDir, file));
  }
  const require = createRequire(import.meta.url);
  return require(tempCjsPath).Compactor;
}

export function loadCompactorModule(): typeof import("./src/compactor.ts") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-compactor-module-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "compactor.cjs");
  fs.copyFileSync(path.resolve("dist", "compactor.js"), tempCjsPath);
  for (const file of [
    "large-payload.js",
    "untrusted-metadata.js",
    "rpc-client.js",
    "env-var.js",
    "segmenter.js",
    "narrative-pool.js",
    "narrative-queue.js",
    "narrative-worker.js",
    "gemini-direct-client.js",
    "summary-escalation.js",
    "transcript-repair.js",
    "transport-retry.js",
    "types.js",
    "utils.js",
  ]) {
    fs.copyFileSync(path.join("dist", file), path.join(tempDir, file));
  }
  const require = createRequire(import.meta.url);
  return require(tempCjsPath);
}
