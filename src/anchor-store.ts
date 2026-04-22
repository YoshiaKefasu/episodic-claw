import * as fsPromises from "fs/promises";
import * as path from "path";

const ANCHOR_FILENAME = "anchor.md";

export interface AnchorWriteResult {
  path: string;
}

/**
 * AnchorStore manages the agent-written session anchor.
 *
 * The anchor lives at {agentWs}/anchor.md — one file, always latest.
 * On compaction completion, the anchor is read, injected, then consumed (deleted).
 * If no anchor exists, compaction proceeds with the LLM-generated summary only.
 */
export class AnchorStore {
  constructor() {}

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

    // anchor.md is continuity-only. It is intentionally not indexed into episodic memory.
    return { path: anchorPath };
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
