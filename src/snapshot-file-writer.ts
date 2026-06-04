// src/snapshot-file-writer.ts — Write one weekly forgotten-episode snapshot file.
//
// One weekly sweep produces one file:
//   {agentWs}/{year}/{month}/memory-that-ive-forgotten-<N>.md
// where agentWs is the agent's "episodes" directory (resolved upstream
// at src/index.ts:resolveWorkspace) and already ends in "/episodes".
// N is obtained from the Go episode.snapshotCounterIncrement RPC and is
// per-year-reset (1 on Jan 1).
//
// Lines are written in the form "<original-filename-stem> — <summary>".
// If the line buffer is empty, the file is NOT created and the counter
// is NOT advanced.

import * as fs from "fs";
import * as path from "path";

import type { EpisodicCoreClient } from "./rpc-client";

export interface SnapshotLine {
  /** Original episode filename WITHOUT the .md extension. */
  stem: string;
  /** One-sentence summary already past the guardrail. */
  summary: string;
}

export interface SnapshotWriteResult {
  written: boolean;
  path?: string;
  number?: number;
}

/**
 * Pick the per-year counter from Go and write the file. Counter is
 * advanced only when at least one line succeeded the guardrail. If
 * the line buffer is empty, no RPC call is issued and no file is
 * created.
 */
export async function writeSnapshotFile(
  client: EpisodicCoreClient,
  agentWs: string,
  year: string,
  month: string, // "06" — 2-digit zero-padded
  lines: SnapshotLine[]
): Promise<SnapshotWriteResult> {
  if (lines.length === 0) {
    return { written: false };
  }

  const { number } = await client.snapshotCounterIncrement(year);

  // agentWs already ends in "/episodes" — do NOT add it again here.
  const dir = path.join(agentWs, year, month);
  const filePath = path.join(dir, `memory-that-ive-forgotten-${String(number).padStart(4, "0")}.md`);

  fs.mkdirSync(dir, { recursive: true });

  const body = lines.map((l) => `${l.stem} — ${l.summary}`).join("\n") + "\n";
  fs.writeFileSync(filePath, body, "utf8");

  return { written: true, path: filePath, number };
}
