import * as fsPromises from "fs/promises";
import * as path from "path";
import { EpisodicCoreClient } from "./rpc-client";

const ANCHOR_FILENAME = "anchor.md";

export interface AnchorWriteResult {
  path: string;
  slug: string;
}

/**
 * AnchorStore manages the agent-written session anchor.
 *
 * The anchor lives at {agentWs}/anchor.md — one file, always latest.
 * On compaction completion, the anchor is read, injected, then consumed (deleted).
 * If no anchor exists, compaction proceeds with the LLM-generated summary only.
 */
export class AnchorStore {
  constructor(private rpcClient: EpisodicCoreClient) {}

  private getAnchorPath(agentWs: string): string {
    // anchor.md sits directly in the episodes workspace root (e.g. ~/.openclaw/workspace/episodes/anchor.md)
    return path.join(agentWs, ANCHOR_FILENAME);
  }

  /**
   * Write (overwrite) the anchor file and index it in the DB.
   * Called by the ep-anchor tool when the agent explicitly saves an anchor.
   */
  async write(params: {
    content: string;
    agentWs: string;
    agentId: string;
    topics?: string[];
  }): Promise<AnchorWriteResult> {
    const anchorPath = this.getAnchorPath(params.agentWs);
    await fsPromises.mkdir(path.dirname(anchorPath), { recursive: true });
    await fsPromises.writeFile(anchorPath, params.content, "utf-8");

    // Also index in the DB as an episode so it's searchable via ep-recall
    let slug = "";
    try {
      const slugRes = await this.rpcClient.generateEpisodeSlug({
        summary: params.content,
        agentWs: params.agentWs,
        topics: params.topics && params.topics.length > 0
          ? params.topics
          : ["anchor", "session-state", "compaction-bridge"],
        tags: ["anchor"],
        edges: [],
        savedBy: params.agentId,
      });
      slug = slugRes.slug ?? "";
    } catch (err) {
      // DB indexing failure is non-fatal — the file is still written
      console.warn("[Episodic Memory] AnchorStore.write: DB index failed (non-fatal):", err);
    }

    return { path: anchorPath, slug };
  }

  /**
   * Read the current anchor text.
   * Returns null if no anchor exists or it is empty.
   */
  async read(agentWs: string): Promise<string | null> {
    try {
      const content = await fsPromises.readFile(this.getAnchorPath(agentWs), "utf-8");
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Delete the anchor file after it has been injected into the compacted context.
   * Called after after_compaction hook reads and injects the anchor.
   */
  async consume(agentWs: string): Promise<void> {
    try {
      await fsPromises.unlink(this.getAnchorPath(agentWs));
    } catch {
      // File already gone — fine
    }
  }
}
