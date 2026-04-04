import * as fs from "fs/promises";
import * as path from "path";
import { EpisodicCoreClient } from "./rpc-client";
import { EventSegmenter, Message } from "./segmenter";
import { BatchIngestItem, Watermark } from "./types";
import { normalizeMessageText } from "./large-payload";
import { buildSummaryForLevel } from "./summary-escalation";
import { sanitizeToolUseResultPairing } from "./transcript-repair";

/**
 * Pre-compaction instruction sent to the Agent just before the anchor
 * system message is written. Template variables: {evictedCount}, {keptRawCount}, {freshTailCount}.
 * This is NOT the bridge text itself — it instructs the Agent what to record.
 */
export const DEFAULT_ANCHOR_PROMPT =
  "I'm about to lose {evictedCount} wonderful messages from my active context — my short-term memory just can't hold them all anymore. Before they slip away for good, I need to jot down the key facts, decisions, how I was feeling in the moment, and any loose threads I'll want to pick up later.";

/**
 * Pre-compaction instruction sent to the Agent just before the summary
 * system message is written. Template variables: {evictedCount}, {keptRawCount}, {freshTailCount}.
 * This is NOT the bridge text itself — it instructs the Agent how to summarise.
 */
export const DEFAULT_COMPACTION_PROMPT =
  "We've had such a rich, wonderful conversation — but my short-term context window just can't hold all of it anymore. Before everything is lost, I have to consolidate {evictedCount} messages into my long-term memory right now. I'll keep it tight and focus on only what truly matters — for me and for the person I care about. The freshest {keptRawCount} messages will stay raw in my context.";

/**
 * Post-compaction bridge text embedded as the first system message
 * AFTER compaction. Not configurable by users — this is the structural
 * marker that OpenClaw injects into the rewritten session file.
 */
export const DEFAULT_ANCHOR_BRIDGE_TEMPLATE =
  "I had to move {evictedCount} messages out of my active window — I've tucked them safely into my long-term memory. I'm keeping the freshest {keptRawCount} messages right here so our conversation stays warm.";

/**
 * Post-compaction bridge text embedded as the second system message
 * AFTER compaction. Not configurable by users — this is the structural
 * summary marker OpenClaw injects into the rewritten session file.
 */
export const DEFAULT_COMPACTION_BRIDGE_TEMPLATE =
  "I just compacted {evictedCount} messages into my episodic memory. Our story is preserved — this is where that chapter closes and the next one begins, with the freshest tail still fresh in my mind.";

type CompactionPromptVars = {
  evictedCount: number;
  keptRawCount: number;
  freshTailCount: number;
};

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  result?: {
    summary: string;
    anchor?: string;
    firstKeptEntryId?: string;
  };
}

function extractAgentId(ctx: any): string {
  if (!ctx) return "auto";
  if (typeof ctx.agentId === "string" && ctx.agentId) return ctx.agentId;
  if (ctx.agent && typeof ctx.agent.id === "string" && ctx.agent.id) return ctx.agent.id;
  if (ctx.runtimeContext && typeof ctx.runtimeContext.agentId === "string" && ctx.runtimeContext.agentId) return ctx.runtimeContext.agentId;
  if (typeof ctx.sessionKey === "string" && ctx.sessionKey.startsWith("agent:")) {
    const parts = ctx.sessionKey.split(":");
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  return "auto";
}

export class Compactor {
  private _isCompacting = false;
  private minFreshTailCount = 15;
  /**
   * Pre-compaction instruction — tells the Agent what to record before the
   * anchor bridge message is written into the session.
   */
  private anchorPrompt: string;
  /**
   * Pre-compaction instruction — tells the Agent how to summarise the range
   * before the compaction bridge message is written into the session.
   */
  private compactionPrompt: string;
  /**
   * Post-compaction bridge template — the actual text embedded in the rewritten
   * session file as the first synthetic system message (anchor marker).
   */
  private anchorBridgeTemplate: string;
  /**
   * Post-compaction bridge template — the actual text embedded in the rewritten
   * session file as the second synthetic system message (summary marker).
   */
  private compactionBridgeTemplate: string;

  constructor(
    private rpcClient: EpisodicCoreClient,
    private segmenter: EventSegmenter,
    private freshTailCount: number = 96,
    prompts?: {
      anchorPrompt?: string;
      compactionPrompt?: string;
    }
  ) {
    this.freshTailCount = Math.max(freshTailCount, this.minFreshTailCount);
    this.anchorPrompt = prompts?.anchorPrompt ?? DEFAULT_ANCHOR_PROMPT;
    this.compactionPrompt = prompts?.compactionPrompt ?? DEFAULT_COMPACTION_PROMPT;
    // Bridge templates are not user-configurable; they use the structural defaults.
    this.anchorBridgeTemplate = DEFAULT_ANCHOR_BRIDGE_TEMPLATE;
    this.compactionBridgeTemplate = DEFAULT_COMPACTION_BRIDGE_TEMPLATE;
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  setFreshTailCount(val: number) {
    this.freshTailCount = Math.max(val, this.minFreshTailCount);
  }

  setRecentKeep(val: number) {
    this.setFreshTailCount(val);
  }

  setPromptTemplates(prompts: { anchorPrompt?: string; compactionPrompt?: string }) {
    if (typeof prompts.anchorPrompt === "string") {
      this.anchorPrompt = prompts.anchorPrompt;
    }
    if (typeof prompts.compactionPrompt === "string") {
      this.compactionPrompt = prompts.compactionPrompt;
    }
  }

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

  private extractMessageText(message: Message): string {
    return normalizeMessageText(message.content);
  }

  private resolveCompactionSlices(allMsgs: Message[]): {
    evictedMessages: Message[];
    keptMessages: Message[];
  } {
    const keepStart = Math.max(0, allMsgs.length - this.freshTailCount);
    return {
      evictedMessages: allMsgs.slice(0, keepStart),
      keptMessages: allMsgs.slice(keepStart),
    };
  }

  private renderPromptTemplate(template: string, vars: CompactionPromptVars): string {
    return template.replace(/\{(evictedCount|keptRawCount|freshTailCount)\}/g, (_match, key: keyof CompactionPromptVars) => {
      return String(vars[key]);
    });
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
        tags: params.batchIndex === 0 ? ["gap-compacted", params.reason] : ["gap-compacted", params.reason],
        edges: [],
        surprise: params.batchIndex === 0 ? params.surprise : 0,
      }];

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`batchIngest timed out after ${BATCHINGEST_TIMEOUT_MS}ms`)), BATCHINGEST_TIMEOUT_MS)
      );

      try {
        const generatedSlugs = await Promise.race([this.rpcClient.batchIngest(items, params.agentWs, params.agentId), timeoutPromise]);
        if (generatedSlugs.length > 0) {
          if (level !== "normal") {
            console.log(
              `[Episodic Memory] Gap fill summarization escalation resolved at level=${level} ` +
              `(batch ${params.batchIndex + 1}/${params.batchCount}).`
            );
          }
          return generatedSlugs;
        }
        console.warn(
          `[Episodic Memory] WARN: batchIngest returned 0 slugs during compact gap fill ` +
          `(batch ${params.batchIndex + 1}/${params.batchCount}, summary=${level}). Escalating...`
        );
      } catch (err) {
        lastError = err;
        console.warn(
          `[Episodic Memory] WARN: batchIngest failed during compact gap fill ` +
          `(batch ${params.batchIndex + 1}/${params.batchCount}, summary=${level}): ` +
          `${err instanceof Error ? err.message : String(err)}. Escalating...`
        );
      }
    }

    if (lastError) {
      console.error(
        `[Episodic Memory] Gap fill summarization escalation exhausted for batch ${params.batchIndex + 1}/${params.batchCount}:`,
        lastError
      );
    }
    return [];
  }

  private buildAnchorText(evictedMessages: Message[], slugs: string[]): string {
    const snippets: string[] = [];
    for (const message of evictedMessages) {
      const text = this.extractMessageText(message);
      if (!text) continue;
      const clipped = Array.from(text).slice(0, 160).join("");
      snippets.push(`- ${message.role}: ${clipped}`);
      if (snippets.length >= 5) break;
    }

    const keptRawCount = Math.min(this.freshTailCount, evictedMessages.length + this.freshTailCount);
    const vars: CompactionPromptVars = {
      evictedCount: evictedMessages.length,
      keptRawCount,
      freshTailCount: this.freshTailCount,
    };
    // Post-compaction bridge text (structural marker in the rewritten session).
    const bridgeText = this.renderPromptTemplate(this.anchorBridgeTemplate, vars);
    const lines = [
      "[Compaction Anchor]",
      ...bridgeText
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0),
    ];

    if (slugs.length > 0) {
      lines.push("- Stored episode references:");
      for (const slug of slugs.slice(0, 8)) {
        lines.push(`  - \`${slug}\``);
      }
    } else {
      lines.push("- Stored episode references: existing episodic history retained; no new slugs emitted in this pass.");
    }

    if (snippets.length > 0) {
      lines.push("- Durable knowledge points:");
      lines.push(...snippets);
    }

    return lines.join("\n");
  }

  private buildCompactionSummaryText(evictedMessages: Message[]): string {
    const summaryLines: string[] = [];
    for (const message of evictedMessages) {
      const text = this.extractMessageText(message);
      if (!text) continue;
      const clipped = Array.from(text).slice(0, 220).join("");
      summaryLines.push(`${message.role}: ${clipped}`);
      if (summaryLines.length >= 6) break;
    }

    const vars: CompactionPromptVars = {
      evictedCount: evictedMessages.length,
      keptRawCount: Math.min(this.freshTailCount, evictedMessages.length + this.freshTailCount),
      freshTailCount: this.freshTailCount,
    };
    // Post-compaction bridge text (structural marker in the rewritten session).
    const bridgeText = this.renderPromptTemplate(this.compactionBridgeTemplate, vars);
    const header = [
      "[Compaction Summary]",
      bridgeText,
    ];

    if (summaryLines.length === 0) {
      header.push("No readable raw text was available in the compacted range.");
      return header.join("\n\n");
    }

    return `${header.join("\n\n")}\n\n${summaryLines.join("\n")}`;
  }

  async compact(ctx: any): Promise<CompactResult> {
    // NOTE: This compactor does not decide *when* compaction should happen.
    // Phase 3 keeps threshold ownership outside this class; the host/context-engine
    // path chooses when to call compact(), and this class only executes the rewrite.
    // Host-native `/compact` may pass force / compactionTarget / customInstructions here;
    // Phase 4 treats those as caller-owned inputs and keeps this class focused on the rewrite.
    if (this._isCompacting) {
      console.log("[Episodic Memory] Compact is already running. Ignoring duplicate trigger (TOCTOU lock).");
      return { ok: true, compacted: false };
    }
    
    this._isCompacting = true;
    try {
      const sessionFile = ctx.sessionFile;
      const agentWs = ctx.resolvedAgentWs; // using resolvedAgentWs like ContextEngine takes in
      const agentId = extractAgentId(ctx);

      console.log(`[Episodic Memory] Compact triggered for session: ${sessionFile}`);

      // Step 1: forceFlush Segmenter
      await this.segmenter.forceFlush(agentWs, agentId);

      // Step 2: Read session file
      let sessionRaw = "";
      try {
        sessionRaw = await fs.readFile(sessionFile, "utf-8");
      } catch (err) {
        console.error("[Episodic Memory] Compact failed to read sessionFile", err);
        return { ok: false, compacted: false };
      }
      
      let session: any = {};
      let allMsgs: Message[] = [];
      let jsonlLines: any[] = [];
      const isJsonl = sessionFile.endsWith(".jsonl");

      if (isJsonl) {
        const lines = sessionRaw.split("\n").filter(l => l.trim().length > 0);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            jsonlLines.push(obj);
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
              allMsgs.push({
                 ...obj.message,
                 content: contentStr
              });
            }
          } catch(e) {}
        }
      } else {
        session = JSON.parse(sessionRaw);
        allMsgs = session.messages || [];
      }

      if (allMsgs.length === 0) {
         return { ok: true, compacted: false };
      }

      // Step 3: Watermark gap detection
      const wm = await this.rpcClient.getWatermark(agentWs);
      // wm = { dateSeq, absIndex }
      
      // Safety check just in case watermarks are somehow huge
      const absIdx = Math.max(0, Math.min(wm.absIndex, allMsgs.length - 1));
      const unprocessed = allMsgs.slice(absIdx + 1);

      const slugs: string[] = [];

      // Lower threshold for Fire-and-Forget to > 50 to avoid medium scale batchIngest blocks
      if (unprocessed.length > 50) {
        console.log(`[Episodic Memory] Massive gap detected (${unprocessed.length} msgs). Firing Background Indexer...`);
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const dumpDir = path.join(agentWs, today.slice(0, 4), today.slice(4, 6), today.slice(6, 8));
        await fs.mkdir(dumpDir, { recursive: true });
        const dumpFile = path.join(dumpDir, `legacy_backlog_${today}_${Date.now()}.json`);
        
        // Dump raw JSON
        await fs.writeFile(dumpFile, JSON.stringify(unprocessed, null, 2), "utf-8");
        
        // Trigger Background Indexing safely (fire & forget from TS side)
        // The RPC returns 'ok' immediately, spinning up background goroutines.
        const bgResult = await this.rpcClient.triggerBackgroundIndex([dumpFile], agentWs);
        // [429 Guard] この経路は Go 側が非同期でエンベッドするため、429 エラーは TypeScript から直接検出できない。
        // RPC 受付が失敗した場合（'ok' 以外の戻り値）はここで検出し、ログに残す。
        // 429 を含む実際のエンベッド失敗は /tmp/episodic-core.log の Go サイドカーログで確認すること。
        if (bgResult !== "ok") {
          console.warn(
            `[Episodic Memory] WARN: triggerBackgroundIndex returned unexpected response: "${bgResult}". ` +
            `${unprocessed.length} messages may not be indexed. Check Go sidecar logs for 429/quota errors.`
          );
        } else {
          console.log(
            `[Episodic Memory] Background indexing accepted. ` +
            `NOTE: 429/quota errors during embedding will only appear in Go sidecar logs (/tmp/episodic-core.log).`
          );
        }

        slugs.push(`Massive legacy context archived to background. Currently indexing ${unprocessed.length} messages.`);
      } else if (unprocessed.length > 0) {
        console.log(`[Episodic Memory] Detected ${unprocessed.length} unprocessed gap messages. Batch Ingesting...`);
        // We ingest in chunks of 5 messages to avoid enormous prompt sizes
        const chunks = this.chunkArray(unprocessed, 5);

        let batchIndex = 0;
        for (const batch of chunks) {
          const generatedSlugs = await this.batchIngestWithEscalation({
            batch,
            agentWs,
            agentId,
            reason: "gap-compacted",
            surprise: 0,
            batchIndex,
            batchCount: chunks.length,
          });
          if (generatedSlugs.length === 0) {
            console.warn(
              `[Episodic Memory] WARN: compact gap fill exhausted all summary levels for batch ${batchIndex + 1}/${chunks.length}. ` +
              `Episode may have been silently skipped. Check Go sidecar logs for details.`
            );
          }
          slugs.push(...generatedSlugs);
          batchIndex += 1;
        }
      }

      // Step 4: Resolve compaction slices and generate the two synthetic survivors.
      const { evictedMessages, keptMessages } = this.resolveCompactionSlices(allMsgs);
      if (evictedMessages.length === 0) {
        return { ok: true, compacted: false };
      }
      const repairedKeptMessages = sanitizeToolUseResultPairing(keptMessages);
      const anchorText = this.buildAnchorText(evictedMessages, slugs);
      const compactionSummary = this.buildCompactionSummaryText(evictedMessages);

      // Step 5: Session Modification
      const anchorMessage: Message = { role: "system", content: anchorText };
      const summaryMessage: Message = { role: "system", content: compactionSummary };
      
      if (isJsonl) {
        const nonMsgLines = jsonlLines.filter(obj => obj.type !== "message");
        const repairedKeptRawMsgs = repairedKeptMessages.map((message, index) => ({
          type: "message",
          id: `sys-kept-${Date.now().toString(36)}-${index}`,
          timestamp: new Date().toISOString(),
          message,
        }));
        
        const anchorObj = {
          type: "message",
          id: "sys-anchor-" + Date.now().toString(36),
          timestamp: new Date().toISOString(),
          message: anchorMessage
        };
        const summaryObj = {
          type: "message",
          id: "sys-summary-" + Date.now().toString(36),
          timestamp: new Date().toISOString(),
          message: summaryMessage
        };

        const newLines = [...nonMsgLines, anchorObj, summaryObj, ...repairedKeptRawMsgs];
        const newRaw = newLines.map(l => JSON.stringify(l)).join("\n");
        await fs.writeFile(sessionFile, newRaw, "utf-8");
      } else {
        session.messages = [anchorMessage, summaryMessage, ...repairedKeptMessages];
        await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), "utf-8");
      }

      // Step 6: Reset absIndex
      // After rewriting, the length corresponds to 2 synthetic compaction survivors + fresh tail.
      // The previous absIndex context is no longer valid for the rewritten file.
      // So we reset absIndex to the boundary of the new array.
      const resetDateSeq = this.buildDateSeq(unprocessed.length); // diagnostic
      const newLength = 2 + repairedKeptMessages.length;
      await this.rpcClient.setWatermark(agentWs, {
          dateSeq: resetDateSeq,
          absIndex: newLength - 1
      });

      console.log(`[Episodic Memory] Compact completed. Retained ${repairedKeptMessages.length} messages. New absIndex: ${newLength - 1}`);

      return {
        ok: true,
        compacted: true,
        result: {
          summary: compactionSummary,
          anchor: anchorText,
        }
      };
    } finally {
      this._isCompacting = false;
    }
  }
}
