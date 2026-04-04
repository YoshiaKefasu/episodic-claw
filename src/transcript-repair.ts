/**
 * Tool use/result pairing repair for assembled context.
 *
 * Copied from openclaw core (src/agents/session-transcript-repair.ts +
 * src/agents/tool-call-id.ts) to avoid depending on unexported internals.
 * When the plugin SDK exports sanitizeToolUseResultPairing, this file can
 * be removed in favor of the SDK import.
 */

type AgentMessageLike = {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolUseId?: string;
  toolName?: string;
  stopReason?: string;
  isError?: boolean;
  timestamp?: number | string;
};

type ToolCallLike = {
  id: string;
  name?: string;
};

const TOOL_CALL_TYPES = new Set([
  "toolCall",
  "toolUse",
  "tool_use",
  "tool-use",
  "functionCall",
  "function_call",
]);
const OPENAI_FUNCTION_CALL_TYPES = new Set(["functionCall", "function_call"]);

function extractToolCallId(block: { id?: unknown; call_id?: unknown }): string | null {
  if (typeof block.id === "string" && block.id) {
    return block.id;
  }
  if (typeof block.call_id === "string" && block.call_id) {
    return block.call_id;
  }
  return null;
}

function normalizeAssistantReasoningBlocks<T extends AgentMessageLike>(message: T): T {
  if (!Array.isArray(message.content)) {
    return message;
  }

  let sawToolCall = false;
  let reasoningAfterToolCall = false;
  let functionCallCount = 0;

  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      return message;
    }

    const type = (block as { type?: unknown }).type;
    if (type === "reasoning" || type === "thinking") {
      if (sawToolCall) {
        reasoningAfterToolCall = true;
      }
      continue;
    }

    if (typeof type === "string" && TOOL_CALL_TYPES.has(type)) {
      sawToolCall = true;
      if (OPENAI_FUNCTION_CALL_TYPES.has(type)) {
        functionCallCount += 1;
      }
      continue;
    }

    return message;
  }

  if (!reasoningAfterToolCall || functionCallCount !== 1) {
    return message;
  }

  const reasoning = message.content.filter((block) => {
    const type = (block as { type?: unknown }).type;
    return type === "reasoning" || type === "thinking";
  });
  const toolCalls = message.content.filter((block) => {
    const type = (block as { type?: unknown }).type;
    return typeof type === "string" && TOOL_CALL_TYPES.has(type);
  });

  return {
    ...message,
    content: [...reasoning, ...toolCalls],
  };
}

function extractToolCallsFromAssistant(msg: AgentMessageLike): ToolCallLike[] {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCallLike[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown };
    const id = extractToolCallId(rec);
    if (!id) {
      continue;
    }
    if (typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) {
      toolCalls.push({
        id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: AgentMessageLike): string | null {
  if (typeof msg.toolCallId === "string" && msg.toolCallId) {
    return msg.toolCallId;
  }
  if (typeof msg.toolUseId === "string" && msg.toolUseId) {
    return msg.toolUseId;
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const rec = block as { tool_use_id?: unknown; call_id?: unknown };
      if (typeof rec.tool_use_id === "string" && rec.tool_use_id) {
        return rec.tool_use_id;
      }
      if (typeof rec.call_id === "string" && rec.call_id) {
        return rec.call_id;
      }
    }
  }
  return null;
}

function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
}): AgentMessageLike {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[episodic-claw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * Repair tool use/result pairing in an assembled message transcript.
 */
export function sanitizeToolUseResultPairing<T extends AgentMessageLike>(messages: T[]): T[] {
  const out: T[] = [];
  const seenToolResultIds = new Set<string>();
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;
  let changed = false;

  const pushToolResult = (msg: T) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) {
      droppedDuplicateCount += 1;
      changed = true;
      return;
    }
    if (id) {
      seenToolResultIds.add(id);
    }
    out.push(msg);
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = msg.role;
    if (role !== "assistant") {
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    const normalizedAssistant = normalizeAssistantReasoningBlocks(msg);
    if (normalizedAssistant !== msg) {
      changed = true;
    }

    const stopReason = normalizedAssistant.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      out.push(normalizedAssistant as T);
      continue;
    }

    const toolCalls = extractToolCallsFromAssistant(normalizedAssistant);
    if (toolCalls.length === 0) {
      out.push(normalizedAssistant as T);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));
    const spanResultsById = new Map<string, T>();
    const remainder: T[] = [];

    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j];
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }

      const nextRole = next.role;
      if (nextRole === "assistant") {
        break;
      }

      if (nextRole === "toolResult") {
        const id = extractToolResultId(next);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            droppedDuplicateCount += 1;
            changed = true;
            continue;
          }
          if (!spanResultsById.has(id)) {
            spanResultsById.set(id, next);
          }
          continue;
        }
      }

      if (nextRole !== "toolResult") {
        remainder.push(next);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
    }

    out.push(normalizedAssistant as T);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      moved = true;
      changed = true;
    }

    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        const missing = makeMissingToolResult({
          toolCallId: call.id,
          toolName: call.name,
        });
        changed = true;
        pushToolResult(missing as T);
      }
    }

    for (const rem of remainder) {
      out.push(rem);
    }
    i = j - 1;
  }

  const changedOrMoved = changed || moved;
  return changedOrMoved ? out : messages;
}
