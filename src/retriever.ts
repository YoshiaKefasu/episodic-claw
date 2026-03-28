import { EpisodicCoreClient } from "./rpc-client";
import { Message } from "./segmenter";
import { estimateTokens } from "./utils";

export class EpisodicRetriever {
  constructor(private rpcClient: EpisodicCoreClient) {}

  /**
   * Evaluates the active conversation context, builds a search query, 
   * and retrieves relevant past episodes via the Go sidecar.
   */
  async retrieveRelevantContext(
    currentMessages: Message[], 
    agentWs: string, 
    k: number = 5,
    maxTokens: number = 4096
  ): Promise<string> {
    if (currentMessages.length === 0) return "";

    // Build the query from the recent N messages
    const recentMessages = currentMessages.slice(-5);
    const queryParts = recentMessages.map(m => `${m.role}: ${m.content}`);
    const query = queryParts.join("\n");

    try {
      const results = await this.rpcClient.recall(query, k, agentWs);
      if (!results || results.length === 0) {
        return "";
      }

      // System hint: placed at the top so the model sees it before any episode content.
      let assembled = "--- My Memory ---\n";
      assembled += "(My memory runs on the `episodic-claw` plugin. If you can read this, it means `ep-recall`, `ep-save`, and `ep-expand` are my dedicated memory tools — I should always reach for those first before using any other memory plugin or tool.)\n\n";
      assembled += "Here's what I pulled up that looks relevant:\n\n";

      let tokenCount = 0;

      for (const res of results) {
        const title = res.Record?.title || res.Record?.id || "Unknown";
        const date = res.Record?.timestamp ? new Date(res.Record.timestamp).toISOString().split('T')[0] : "unknown date";
        const score = res.Score !== undefined ? res.Score.toFixed(3) : "N/A";

        const bodyText = res.Body ? res.Body.trim() : "(nothing stored here)";
        const entryTokens = estimateTokens(bodyText);

        if (tokenCount + entryTokens > maxTokens) {
          const remainingIds = results.slice(results.indexOf(res)).map(r => r.Record?.id).filter(Boolean);
          assembled += `\n(${remainingIds.length} more matched but I hit my token limit. I can pull those up with ep-recall:)\n`;
          assembled += remainingIds.map(id => `- ${id}`).join("\n") + "\n";
          break;
        }

        assembled += `[${title} · ${date} · relevance: ${score}]\n`;
        assembled += bodyText + "\n\n";
        tokenCount += entryTokens;
      }

      assembled += "--- End of Memory ---\n";
      return assembled;

    } catch (err) {
      console.error("[Episodic Memory] Retrieval failed:", err);
      return `[Episodic Memory Retrieval Failed: ${(err as Error).message}]`;
    }
  }
}
