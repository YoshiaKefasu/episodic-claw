import { createHash, randomUUID } from "crypto";

import { buildRecallCalibration } from "./config";
import { EpisodicCoreClient } from "./rpc-client";
import { EpisodicPluginConfig } from "./types";
import { Message, extractText } from "./segmenter";
import { estimateTokens } from "./utils";

export type RecallInjectionOutcome = {
  text: string;
  reason: "injected" | "no_messages" | "max_tokens_zero" | "empty_query" | "recall_empty" | "recall_failed";
  queryHash: string;
  injectedEpisodeCount: number;
  truncatedEpisodeCount: number;
  firstEpisodeId: string;
};

export class EpisodicRetriever {
  constructor(
    private rpcClient: EpisodicCoreClient,
    private config?: EpisodicPluginConfig
  ) {}

  /**
   * Evaluates the active conversation context, builds a search query, 
   * and retrieves relevant past episodes via the Go sidecar.
   */
  async retrieveRelevantContext(
    currentMessages: Message[], 
    agentWs: string, 
    k: number = 5,
    maxTokens: number = 4096
  ): Promise<RecallInjectionOutcome> {
    if (currentMessages.length === 0) {
      return { text: "", reason: "no_messages", queryHash: "", injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "" };
    }
    // max_tokens_zero: ここでの 0 は「入力時点で注入不能」。
    if (maxTokens <= 0) {
      return { text: "", reason: "max_tokens_zero", queryHash: "", injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "" };
    }

    // Build the query from the recent N messages
    const recentMessages = currentMessages.slice(-5);
    const queryParts = recentMessages
      .map(m => {
        const content = extractText(m.content).trim();
        return content ? `${m.role}: ${content}` : "";
      })
      .filter(part => part.length > 0);
    const query = queryParts.join("\n").trim();
    if (!query) {
      return { text: "", reason: "empty_query", queryHash: "", injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "" };
    }
    const queryHash = createHash("sha1").update(query).digest("hex");
    const calibration = this.config ? buildRecallCalibration(this.config) : undefined;

    try {
      let sourcedResults: Array<{ ws: string; item: any }> = [];
      try {
        const results = await this.rpcClient.recall(query, k, agentWs, [], undefined, calibration);
        if (results && results.length > 0) {
          sourcedResults = results.map(item => ({ ws: agentWs, item }));
        }
      } catch (err) {
        console.warn("[Episodic Memory] Recall failed for primary workspace:", err);
      }
      if (sourcedResults.length === 0) {
        return { text: "", reason: "recall_empty", queryHash, injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "" };
      }

      // System hint: placed at the top so the model sees it before any episode content.
      let assembled = "--- My Memory ---\n";
      assembled += "(My memory runs on the `episodic-claw` plugin. If you can read this, it means `ep-recall`, `ep-save`, and `ep-expand` are my dedicated memory tools — I should always reach for those first before using any other memory plugin or tool.)\n\n";
      assembled += "Here's what I pulled up that looks relevant:\n\n";

      let tokenCount = 0;
      let injectedEpisodeCount = 0;
      let truncatedEpisodeCount = 0;
      let firstEpisodeId = "";
      const injectedIdsByWs = new Map<string, string[]>();

      const scoreOf = (res: any): number => {
        if (typeof res?.Score === "number") return res.Score;
        if (typeof res?.score === "number") return res.score;
        return 0;
      };

      const deduped = sourcedResults
        .slice()
        .sort((a, b) => scoreOf(b.item) - scoreOf(a.item));

      for (let index = 0; index < deduped.length; index += 1) {
        const res = deduped[index].item;
        const title = res.Record?.title || res.Record?.id || "Unknown";
        const date = res.Record?.timestamp ? new Date(res.Record.timestamp).toISOString().split('T')[0] : "unknown date";
        const score = scoreOf(res) !== 0 ? scoreOf(res).toFixed(3) : "N/A";

        const episodeId = (res?.Record?.id ?? res?.Record?.ID ?? "").toString().trim();
        const bodyText = res.Body ? res.Body.trim() : "(nothing stored here)";
        const entryTokens = estimateTokens(bodyText);

        if (tokenCount + entryTokens > maxTokens) {
          const remainingIds = deduped.slice(index).map(r => r.item.Record?.id).filter(Boolean);
          truncatedEpisodeCount = remainingIds.length;
          assembled += `\n(${remainingIds.length} more matched but I hit my token limit. I can pull those up with ep-recall:)\n`;
          assembled += remainingIds.map(id => `- ${id}`).join("\n") + "\n";
          break;
        }

        assembled += `[${title} · ${date} · relevance: ${score}]\n`;
        assembled += bodyText + "\n\n";
        tokenCount += entryTokens;
        injectedEpisodeCount += 1;
        if (!firstEpisodeId && episodeId) {
          firstEpisodeId = episodeId;
        }
        if (episodeId) {
          const bucket = injectedIdsByWs.get(agentWs) ?? [];
          bucket.push(episodeId);
          injectedIdsByWs.set(agentWs, bucket);
        }
      }

      assembled += "--- End of Memory ---\n";

      for (const [ws, injectedIds] of injectedIdsByWs.entries()) {
        if (injectedIds.length === 0) continue;
        try {
          await this.rpcClient.recallFeedback({
            agentWs: ws,
            feedbackId: randomUUID(),
            queryHash,
            shown: injectedIds,
            used: [],
            expanded: [],
            source: "assemble",
          });
        } catch (feedbackErr) {
          console.warn("[Episodic Memory] recall feedback failed:", feedbackErr);
        }
      }

      return {
        text: assembled,
        reason: "injected",
        queryHash,
        injectedEpisodeCount,
        truncatedEpisodeCount,
        firstEpisodeId,
      };

    } catch (err) {
      console.error("[Episodic Memory] Retrieval failed:", err);
      return { text: "", reason: "recall_failed", queryHash, injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "" };
    }
  }
}
