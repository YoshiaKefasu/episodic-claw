import * as fsPromises from "fs/promises";
import * as path from "path";
import { EpisodicCoreClient } from "./rpc-client";
import { EventSegmenter, Message } from "./segmenter";
import { BatchIngestItem } from "./types";
import { splitIntoChunks, enqueueNarrativeChunks } from "./narrative-queue";
import { normalizeMessageText } from "./large-payload";
import { buildSummaryForLevel } from "./summary-escalation";

/**
 * EpisodicArchiver — pre-compaction memory protection.
 *
 * Responsibilities:
 *  1. Force-flush the segmenter buffer (so in-flight messages get saved)
 *  2. Detect unprocessed messages via watermark gap
 *  3. Archive them losslessly via batchIngest (or background indexer for large gaps)
 *  4. Update the watermark
 *
 * What it does NOT do (removed from v0.3.0 Compactor):
 *  - Session file rewrite (owned by OpenClaw host)
 *  - Anchor text generation (owned by ep-anchor tool)
 *  - Compaction summary text generation (owned by OpenClaw LLM compaction)
 *  - Context pressure monitoring (owned by OpenClaw host)
 */
export class EpisodicArchiver {
  constructor(
    private rpcClient: EpisodicCoreClient,
    private segmenter: EventSegmenter,
  ) {}

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private chunkArray<T>(array: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      result.push(array.slice(i, i + size));
    }
    return result;
  }

  private buildDateSeq(count: number): string {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `${today}-${count}`;
  }

  private async batchIngestWithEscalation(params: {
    batch: Message[];
    agentWs: string;
    agentId: string;
    reason: string;
    surprise: number;
    batchIndex: number;
    batchCount: number;
  }): Promise<string[]> {
    const summaryLevels = ["normal", "aggressive", "fallback"] as const;
    const BATCHINGEST_TIMEOUT_MS = 30000;
    let lastError: unknown = null;

    for (const level of summaryLevels) {
      const summary = buildSummaryForLevel(params.batch, level);
      const items: BatchIngestItem[] = [{
        summary,
        tags: ["gap-compacted", params.reason],
        edges: [],
        surprise: params.batchIndex === 0 ? params.surprise : 0,
      }];

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`batchIngest timed out after ${BATCHINGEST_TIMEOUT_MS}ms`)), BATCHINGEST_TIMEOUT_MS)
      );

      try {
        const generatedSlugs = await Promise.race([
          this.rpcClient.batchIngest(items, params.agentWs, params.agentId),
          timeoutPromise,
        ]);
        if (generatedSlugs.length > 0) {
          if (level !== "normal") {
            console.log(
              `[Episodic Memory] Gap fill escalation resolved at level=${level} ` +
              `(batch ${params.batchIndex + 1}/${params.batchCount}).`
            );
          }
          return generatedSlugs;
        }
        console.warn(
          `[Episodic Memory] WARN: batchIngest returned 0 slugs ` +
          `(batch ${params.batchIndex + 1}/${params.batchCount}, summary=${level}). Escalating...`
        );
      } catch (err) {
        lastError = err;
        console.warn(
          `[Episodic Memory] WARN: batchIngest failed ` +
          `(batch ${params.batchIndex + 1}/${params.batchCount}, summary=${level}): ` +
          `${err instanceof Error ? err.message : String(err)}. Escalating...`
        );
      }
    }

    if (lastError) {
      console.error(
        `[Episodic Memory] Gap fill escalation exhausted for batch ${params.batchIndex + 1}/${params.batchCount}:`,
        lastError
      );
    }
    return [];
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Flush the segmenter's in-memory buffer, ensuring all unsaved events
   * are committed to the DB before compaction rewrites the session file.
   */
  async forceFlush(agentWs: string, agentId: string): Promise<void> {
    await this.segmenter.forceFlush(agentWs, agentId);
  }

  /**
   * Read the session file and archive all messages that have not yet been
   * processed (i.e., messages beyond the current watermark index).
   *
   * Returns the slugs of archived episodes.
   */
  async archiveUnprocessed(params: {
    sessionFile: string;
    agentWs: string;
    agentId: string;
  }): Promise<string[]> {
    // Read session file
    let sessionRaw = "";
    try {
      sessionRaw = await fsPromises.readFile(params.sessionFile, "utf-8");
    } catch (err) {
      console.error("[Episodic Memory] archiveUnprocessed: failed to read sessionFile", err);
      return [];
    }

    let allMsgs: Message[] = [];
    const isJsonl = params.sessionFile.endsWith(".jsonl");

    if (isJsonl) {
      const lines = sessionRaw.split("\n").filter(l => l.trim().length > 0);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "message" && obj.message) {
            let contentStr = "";
            if (Array.isArray(obj.message.content)) {
              contentStr = obj.message.content
                .map((c: any) => c.text || "")
                .filter((t: string) => t.length > 0)
                .join(" ");
            } else if (typeof obj.message.content === "string") {
              contentStr = obj.message.content;
            }
            allMsgs.push({ ...obj.message, content: contentStr });
          }
        } catch { /* skip malformed lines */ }
      }
    } else {
      try {
        const session = JSON.parse(sessionRaw);
        allMsgs = session.messages || [];
      } catch (err) {
        console.error("[Episodic Memory] archiveUnprocessed: failed to parse session JSON", err);
        return [];
      }
    }

    if (allMsgs.length === 0) return [];

    // Watermark gap detection
    const wm = await this.rpcClient.getWatermark(params.agentWs);
    const absIdx = Math.max(0, Math.min(wm.absIndex, allMsgs.length - 1));
    const unprocessed = allMsgs.slice(absIdx + 1);

    if (unprocessed.length === 0) {
      console.log("[Episodic Memory] archiveUnprocessed: no gap detected, all messages already archived.");
      return [];
    }

    const slugs: string[] = [];

    if (unprocessed.length > 50) {
      // v0.4.2: Large gap → split into 64K chunks and enqueue to cache DB
      console.log(`[Episodic Memory] Large gap detected (${unprocessed.length} msgs). Enqueuing to cache...`);
      const rawText = unprocessed.map(m => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n");
      try {
        const chunks = splitIntoChunks(rawText, params.agentWs, params.agentId, "gap-archive", "gap-archive", 0);
        await enqueueNarrativeChunks(this.rpcClient, chunks, () => this.segmenter.wakeNarrativeWorker());
        console.log(`[Episodic Memory] Enqueued ${chunks.length} chunks for gap archive narrativization.`);
        slugs.push(...chunks.map((c: any) => c.id));
      } catch (err) {
        console.error("[Episodic Memory] Gap archive cache enqueue failed, falling back to background indexer:", err);
        // Fallback to old path
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const dumpDir = path.join(params.agentWs, today.slice(0, 4), today.slice(4, 6), today.slice(6, 8));
        await fsPromises.mkdir(dumpDir, { recursive: true });
        const dumpFile = path.join(dumpDir, `legacy_backlog_${today}_${Date.now()}.json`);
        await fsPromises.writeFile(dumpFile, JSON.stringify(unprocessed, null, 2), "utf-8");
        await this.rpcClient.triggerBackgroundIndex([dumpFile], params.agentWs);
        slugs.push(`Massive legacy context archived to background. Indexing ${unprocessed.length} messages.`);
      }
    } else {
      // Normal gap: synchronous batchIngest in chunks
      console.log(`[Episodic Memory] Archiving ${unprocessed.length} unprocessed messages before compaction...`);
      const chunks = this.chunkArray(unprocessed, 5);
      let batchIndex = 0;
      for (const batch of chunks) {
        const generatedSlugs = await this.batchIngestWithEscalation({
          batch,
          agentWs: params.agentWs,
          agentId: params.agentId,
          reason: "pre-compaction-archive",
          surprise: 0,
          batchIndex,
          batchCount: chunks.length,
        });
        if (generatedSlugs.length === 0) {
          console.warn(
            `[Episodic Memory] WARN: batchIngest exhausted all summary levels for batch ${batchIndex + 1}/${chunks.length}.`
          );
        }
        slugs.push(...generatedSlugs);
        batchIndex++;
      }
    }

    // Update watermark to mark all messages as processed
    await this.rpcClient.setWatermark(params.agentWs, {
      dateSeq: this.buildDateSeq(unprocessed.length),
      absIndex: allMsgs.length - 1,
    });

    console.log(`[Episodic Memory] archiveUnprocessed: done. ${slugs.length} episodes archived.`);
    return slugs;
  }
}
