import * as fs from "fs/promises";
import * as path from "path";
import { EpisodicCoreClient } from "./rpc-client";
import { EventSegmenter, Message } from "./segmenter";
import { BatchIngestItem, Watermark } from "./types";

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  result?: {
    summary: string;
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
  private isCompacting = false;
  private minRecentKeep = 15;

  constructor(
    private rpcClient: EpisodicCoreClient,
    private segmenter: EventSegmenter,
    private recentKeep: number = 30
  ) {
    this.recentKeep = Math.max(recentKeep, this.minRecentKeep);
  }

  setRecentKeep(val: number) {
    this.recentKeep = Math.max(val, this.minRecentKeep);
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

  async compact(ctx: any): Promise<CompactResult> {
    if (this.isCompacting) {
      console.log("[Episodic Memory] Compact is already running. Ignoring duplicate trigger (TOCTOU lock).");
      return { ok: true, compacted: false };
    }
    
    this.isCompacting = true;
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
        const dumpDir = path.join(agentWs, "episodes", today.slice(0, 4), today.slice(4, 6), today.slice(6, 8));
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
        
        for (const batch of chunks) {
           const summary = batch.map(m => `${m.role}: ${m.content}`).join("\n");
           
           const items: BatchIngestItem[] = [{
               summary: summary,
               tags: ["gap-compacted"],
               edges: []
           }];
           
           const generatedSlugs = await this.rpcClient.batchIngest(items, agentWs, agentId);
           // [429 Guard] 空戻り値は Go 側が 429 でエピソードをスキップした可能性を示す。
           if (generatedSlugs.length === 0) {
             console.warn(
               `[Episodic Memory] WARN: batchIngest returned 0 slugs during compact gap fill. ` +
               `Episode may have been silently skipped. ` +
               `Possible cause: Gemini API 429 (quota exceeded). Check Go sidecar logs for details.`
             );
           }
           slugs.push(...generatedSlugs);
        }
      }

      // Step 4: Generate LLM-free Index String
      // 一人称・メモ調: "The AI agent has access to..." のような3人称通知文を避け、
      // エージェント自身が書いた覚え書きのような自然な文体にする。
      const indexString = `(Tucked away the earlier conversation in memory. I can pull any of it back up when it's relevant.)\n\nWhat I've stored:\n${slugs.length > 0 ? slugs.map(s => `- \`${s}\``).join("\n") : "- (stored as a bulk archive)"}`;

      // Step 5: Session Modification
      const indexMessage: Message = { role: "system", content: indexString };
      const keptMessages = allMsgs.slice(-this.recentKeep);
      
      if (isJsonl) {
        const nonMsgLines = jsonlLines.filter(obj => obj.type !== "message");
        const keptRawMsgs = jsonlLines.filter(obj => obj.type === "message").slice(-this.recentKeep);
        
        const indexObj = {
          type: "message",
          id: "sys-idx-" + Date.now().toString(36),
          timestamp: new Date().toISOString(),
          message: indexMessage
        };
        
        const newLines = [...nonMsgLines, indexObj, ...keptRawMsgs];
        const newRaw = newLines.map(l => JSON.stringify(l)).join("\n");
        await fs.writeFile(sessionFile, newRaw, "utf-8");
      } else {
        session.messages = [indexMessage, ...keptMessages];
        await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), "utf-8");
      }

      // Step 6: Reset absIndex
      // After rewriting, the length corresponds to 1 (indexMsg) + RECENT_KEEP.
      // The previous absIndex context is no longer valid for the rewritten file.
      // So we reset absIndex to the boundary of the new array.
      const resetDateSeq = this.buildDateSeq(unprocessed.length); // diagnostic
      const newLength = 1 + keptMessages.length;
      await this.rpcClient.setWatermark(agentWs, {
          dateSeq: resetDateSeq,
          absIndex: newLength - 1
      });

      console.log(`[Episodic Memory] Compact completed. Retained ${keptMessages.length} messages. New absIndex: ${newLength - 1}`);

      return {
        ok: true,
        compacted: true,
        result: {
          summary: indexString,
        }
      };
    } finally {
      this.isCompacting = false;
    }
  }
}
